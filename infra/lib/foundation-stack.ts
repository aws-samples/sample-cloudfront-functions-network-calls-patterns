import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { ExtraBehavior, ExtraOrigin, Pattern, behaviorPath } from './pattern';

/** One pattern, materialised: its origin, any extra origins, and its CloudFront Function(s). */
export interface DeployedPattern {
  readonly pattern: Pattern;
  readonly origin: cloudfront.IOrigin;
  readonly extraOrigins: ExtraOrigin[];
  readonly extraBehaviors: ExtraBehavior[];
  readonly fn: cloudfront.Function;
  /** The `viewer-response` function, when the pattern sets `responseFunctionCode`. */
  readonly responseFn?: cloudfront.Function;
}

/**
 * Everything in one stack: the shared KeyValueStore, each pattern's backend and CloudFront
 * Function(s) under a scope named after the pattern, the ONE distribution with one cache
 * behavior per pattern, and an empty private bucket on its default behavior.
 *
 * Adding or removing a pattern is one deploy. Do not rename or move the `Distribution`
 * construct: a new logical id replaces the distribution and gives it a new domain name.
 */
export class FoundationStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;
  readonly keyValueStore: cloudfront.KeyValueStore;
  readonly defaultBucket: s3.Bucket;
  readonly deployed: DeployedPattern[];

  constructor(scope: Construct, id: string, patterns: Pattern[], props?: cdk.StackProps) {
    super(scope, id, props);

    // A new name on every deploy, so a KVS left behind by an earlier deployment can never
    // block this one with AlreadyExists. Each deploy therefore replaces the KVS and starts it
    // empty: every key the functions read has a default, and the caches refill.
    this.keyValueStore = new cloudfront.KeyValueStore(this, 'KeyValueStore', {
      keyValueStoreName: `${this.stackName}-kvs-${Date.now().toString(36)}`,
      comment: 'Shared KVS for the network-call patterns (durable edge cache / config)',
    });
    // Before the distribution: a pattern's `behavior` and `webAclRules` may read what origin() created.
    this.deployed = deployPatterns(this, patterns, this.keyValueStore);
    const deployed = this.deployed;

    // The default behavior's origin: an empty private bucket, so any path outside /patterns/<id>/*
    // answers 403 and reaches no pattern backend.
    this.defaultBucket = new s3.Bucket(this, 'DefaultOriginBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    const webAcl = sharedWebAcl(this, deployed);
    const serverTiming = new cloudfront.ResponseHeadersPolicy(this, 'ServerTimingPolicy', {
      comment: 'network-calls-patterns: CloudFront Server-Timing on every response',
      serverTimingSamplingRate: SERVER_TIMING_SAMPLING_RATE,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'CloudFront Functions network-call patterns (shared)',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      ...(webAcl ? { webAclId: webAcl.attrArn } : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.defaultBucket, { originId: 'default' }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: serverTiming,
      },
    });

    for (const { pattern, origin, extraOrigins, extraBehaviors, fn, responseFn } of deployed) {
      // Added first: CloudFront matches behaviors in order, so these win over the pattern's own path.
      for (const extra of extraBehaviors) {
        if (!extra.path.startsWith(`/patterns/${pattern.id}/`)) throw new Error(`pattern "${pattern.id}": extra behavior ${extra.path} must be under /patterns/${pattern.id}/`);
        this.distribution.addBehavior(extra.path, new StableScopeOrigin(extra.origin, this.distribution, `ExtraBehavior-${extra.id}`, extra.id), {
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: serverTiming,
        });
      }
      this.distribution.addBehavior(behaviorPath(pattern), new StableScopeOrigin(origin, this.distribution, `Origin-${pattern.id}`, pattern.id), {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [
          { function: fn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ...(responseFn ? [{ function: responseFn, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE }] : []),
        ],
        ...pattern.behavior,
        responseHeadersPolicy: withServerTiming(pattern.behavior?.responseHeadersPolicy, serverTiming, pattern.id),
      });
      for (const extra of extraOrigins) addStandaloneOrigin(this.distribution, extra);
    }
    serializeOriginAccessControls(this.distribution);

    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomain', { value: this.distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'KeyValueStoreArn', { value: this.keyValueStore.keyValueStoreArn });
  }
}

/**
 * Each pattern's backend (origin(), extraOrigins(), extraBehaviors()) and CloudFront Function(s),
 * under a scope named after the pattern. Function names start with the stack name, so two
 * deployments of this app can share an account.
 */
function deployPatterns(stack: cdk.Stack, patterns: Pattern[], keyValueStore: cloudfront.KeyValueStore): DeployedPattern[] {
  const deployed: DeployedPattern[] = [];
  // CloudFront throttles parallel Function create/update calls ('Rate exceeded'), so
  // each function depends on the previous one: CloudFormation then runs them in folder order.
  let previousFn: cloudfront.Function | undefined;
  const makeFunction = (scope: Construct, id: string, name: string, codePath: string, pattern: Pattern, hook: string) => {
    const fn = new cloudfront.Function(scope, id, {
      functionName: `${stack.stackName}-${name}`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromFile({ filePath: codePath }),
      comment: `network-call pattern: ${pattern.id} (${hook})`,
      ...(pattern.keyValueStore ? { keyValueStore } : {}),
    });
    if (previousFn) fn.node.addDependency(previousFn);
    previousFn = fn;
    return fn;
  };
  for (const pattern of patterns) {
    const scope = new Construct(stack, pattern.id);
    const ctx = { keyValueStore };
    const origin = pattern.origin(scope, ctx);
    const extraOrigins = pattern.extraOrigins?.(scope, ctx) ?? [];
    const extraBehaviors = pattern.extraBehaviors?.(scope, ctx) ?? [];
    const fn = makeFunction(scope, 'Function', pattern.id, pattern.functionCode, pattern, 'viewer-request');
    const responseFn = pattern.responseFunctionCode
      ? makeFunction(scope, 'ResponseFunction', `${pattern.id}-response`, pattern.responseFunctionCode, pattern, 'viewer-response')
      : undefined;
    deployed.push({ pattern, origin, extraOrigins, extraBehaviors, fn, responseFn });
  }
  return deployed;
}

/**
 * Percentage of responses that carry CloudFront's Server-Timing header. 100 here, so every
 * Try it shows timings. The header is ~300 bytes per response and no extra charge; in production a
 * low rate (1-10) is plenty, and a request with `Pragma: server-timing` gets the header at any rate.
 */
export const SERVER_TIMING_SAMPLING_RATE = 100;

/**
 * Every behavior gets Server-Timing. No policy of its own: the shared one. Its own policy: Server-Timing
 * is merged into it (whatever else it sets is kept). A managed or imported policy cannot be edited here.
 */
function withServerTiming(
  own: cloudfront.IResponseHeadersPolicyRef | undefined,
  shared: cloudfront.ResponseHeadersPolicy,
  patternId: string,
): cloudfront.IResponseHeadersPolicyRef {
  if (!own) return shared;
  const cfn = own instanceof cloudfront.ResponseHeadersPolicy ? own.node.defaultChild : undefined;
  if (!(cfn instanceof cloudfront.CfnResponseHeadersPolicy)) {
    throw new Error(`pattern "${patternId}": behavior.responseHeadersPolicy must be a cloudfront.ResponseHeadersPolicy created in the pattern, so Server-Timing can be merged into it`);
  }
  const config = cfn.responseHeadersPolicyConfig as cloudfront.CfnResponseHeadersPolicy.ResponseHeadersPolicyConfigProperty;
  if (!config.serverTimingHeadersConfig) {
    cfn.addPropertyOverride('ResponseHeadersPolicyConfig.ServerTimingHeadersConfig', { Enabled: true, SamplingRate: SERVER_TIMING_SAMPLING_RATE });
  }
  return own;
}

/**
 * One web ACL for the distribution: a shared Bot Control rule first (when a pattern sets
 * `botControl`), then the rules patterns contribute (`webAclRules`), in pattern order. Default
 * action Allow: a request no rule matches is untouched. No rules, no web ACL.
 */
function sharedWebAcl(scope: Construct, patterns: DeployedPattern[]): wafv2.CfnWebACL | undefined {
  const botControl = botControlRule(patterns.filter(({ pattern }) => pattern.botControl).map(({ pattern }) => pattern.id));
  const rules = [...botControl, ...patterns.flatMap(({ pattern }) => pattern.webAclRules?.() ?? [])].map((rule, priority) => ({ ...rule, priority }));
  if (rules.length === 0) return undefined;
  return new wafv2.CfnWebACL(scope, 'WebAcl', {
    scope: 'CLOUDFRONT',
    defaultAction: { allow: {} },
    rules,
    visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'network-calls-patterns', sampledRequestsEnabled: true },
  });
}

/**
 * Bot Control at the common level, count only: it labels requests (bot name and category, token
 * id) and never blocks, so each pattern's own rules and function decide. One rule group for all
 * the patterns that ask, scoped to their paths: Bot Control is billed per request it inspects.
 */
function botControlRule(patternIds: string[]): wafv2.CfnWebACL.RuleProperty[] {
  if (patternIds.length === 0) return [];
  const onPath = (id: string) => ({ byteMatchStatement: { searchString: `/patterns/${id}/`, fieldToMatch: { uriPath: {} },
    positionalConstraint: 'STARTS_WITH', textTransformations: [{ priority: 0, type: 'NONE' }] } });
  const paths = patternIds.map(onPath);
  return [{
    name: 'bot-control',
    priority: 0,
    overrideAction: { count: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name: 'AWSManagedRulesBotControlRuleSet',
        managedRuleGroupConfigs: [{ awsManagedRulesBotControlRuleSet: { inspectionLevel: 'COMMON' } }],
        scopeDownStatement: paths.length === 1 ? paths[0] : { orStatement: { statements: paths } },
      },
    },
    visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'bot-control', sampledRequestsEnabled: true },
  }];
}

/**
 * Binds an origin under a scope named after the pattern (`Distribution/Origin-<pattern id>`,
 * `Distribution/ExtraOrigin-<origin id>`) instead of CDK's positional `Distribution/Origin<N>`.
 * With positional scopes, inserting or removing a pattern renumbers every later origin and
 * CloudFormation replaces their OACs, VPC origins and Lambda permissions. Named scopes are
 * stable. An origin group's failover origin gets `<scope>-failover`.
 */
class StableScopeOrigin implements cloudfront.IOrigin {
  constructor(
    private readonly inner: cloudfront.IOrigin,
    private readonly distribution: cloudfront.Distribution,
    private readonly scopeId: string,
    private readonly originId: string,
  ) {}

  private bound?: cloudfront.OriginBindConfig;

  bind(_scope: Construct, options: cloudfront.OriginBindOptions): cloudfront.OriginBindConfig {
    if (this.bound) return this.bound; // the Distribution may bind an origin more than once
    const scope = new Construct(this.distribution, this.scopeId);
    const bound = this.inner.bind(scope, { ...options, originId: this.originId });
    this.bound = bound;
    if (bound.failoverConfig) {
      const failoverOrigin = new StableScopeOrigin(
        bound.failoverConfig.failoverOrigin, this.distribution, `${this.scopeId}-failover`, `${this.originId}-failover`);
      this.bound = { ...bound, failoverConfig: { ...bound.failoverConfig, failoverOrigin } };
    }
    return this.bound;
  }
}

/**
 * CloudFront throttles parallel OriginAccessControl calls ('Rate exceeded'), so every OAC
 * the origins created under the distribution depends on the previous one (creation order,
 * i.e. pattern folder order). Only DependsOn lines change; the Distribution is untouched.
 */
function serializeOriginAccessControls(distribution: cloudfront.Distribution): void {
  const oacs = distribution.node
    .findAll()
    .filter((c): c is cloudfront.CfnOriginAccessControl => c instanceof cloudfront.CfnOriginAccessControl);
  for (let i = 1; i < oacs.length; i++) oacs[i].node.addDependency(oacs[i - 1]);
}

/**
 * Add an origin that has no cache behavior (a `cf.fetch`-only target).
 *
 * The Distribution L2 only exposes origins through behaviors, so this calls its
 * private `addOrigin` — the same code path behaviors use, which also binds OAC
 * origins correctly. The origin id comes from the origin's own `originId`.
 */
function addStandaloneOrigin(distribution: cloudfront.Distribution, extra: ExtraOrigin): void {
  const d = distribution as unknown as { addOrigin?: (origin: cloudfront.IOrigin) => string };
  if (typeof d.addOrigin !== 'function') {
    throw new Error('cloudfront.Distribution no longer has addOrigin(); update addStandaloneOrigin in infra/lib/foundation-stack.ts');
  }
  const originId = d.addOrigin(new StableScopeOrigin(extra.origin, distribution, `ExtraOrigin-${extra.id}`, extra.id));
  if (originId !== extra.id) {
    throw new Error(`extra origin "${extra.id}" must be created with originId: '${extra.id}' (distribution got "${originId}")`);
  }
}
