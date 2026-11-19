// Every behavior on the distribution carries a response headers policy with Server-Timing enabled.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { FoundationStack, SERVER_TIMING_SAMPLING_RATE } from '../lib/foundation-stack';
import { Pattern, loadPatterns, PATTERNS_DIR } from '../lib/pattern';

const env = { region: 'us-east-1' };

function synth(patterns: Pattern[]): Template {
  const app = new cdk.App();
  const foundation = new FoundationStack(app, 'FoundationStack', patterns, { env });
  return Template.fromStack(foundation);
}

/** policy logical id -> its ServerTimingHeadersConfig */
function serverTimingByPolicy(t: Template): Record<string, { Enabled?: boolean; SamplingRate?: number } | undefined> {
  const out: Record<string, { Enabled?: boolean; SamplingRate?: number } | undefined> = {};
  for (const [id, r] of Object.entries(t.findResources('AWS::CloudFront::ResponseHeadersPolicy'))) {
    out[id] = (r as { Properties: { ResponseHeadersPolicyConfig: { ServerTimingHeadersConfig?: { Enabled?: boolean; SamplingRate?: number } } } })
      .Properties.ResponseHeadersPolicyConfig.ServerTimingHeadersConfig;
  }
  return out;
}

function assertEveryBehaviorHasServerTiming(t: Template, expectedBehaviors: number): void {
  const policies = serverTimingByPolicy(t);
  const [dist] = Object.values(t.findResources('AWS::CloudFront::Distribution')) as { Properties: { DistributionConfig: Record<string, any> } }[];
  const config = dist.Properties.DistributionConfig;
  const behaviors = [{ PathPattern: 'default', ...config.DefaultCacheBehavior }, ...(config.CacheBehaviors ?? [])];
  assert.equal(behaviors.length, expectedBehaviors);
  for (const b of behaviors) {
    const ref = b.ResponseHeadersPolicyId?.Ref;
    assert.ok(ref, `${b.PathPattern}: no response headers policy`);
    assert.deepEqual(policies[ref], { Enabled: true, SamplingRate: SERVER_TIMING_SAMPLING_RATE }, `${b.PathPattern}: Server-Timing not enabled`);
  }
}

test('the default behavior and every pattern behavior have Server-Timing enabled', () => {
  const patterns = loadPatterns();
  assert.ok(patterns.length > 0);
  const app = new cdk.App();
  const foundation = new FoundationStack(app, 'FoundationStack', patterns, { env });
  const extra = foundation.deployed.reduce((n, d) => n + d.extraBehaviors.length, 0);
  assert.ok(extra > 0, "01's demo token route is an extra behavior");
  assertEveryBehaviorHasServerTiming(Template.fromStack(foundation), patterns.length + 1 + extra);
});

test("a pattern's own response headers policy keeps its settings and gains Server-Timing", () => {
  // Same idiom as 11's origin request policy: created in origin(), handed over by a behavior getter.
  let responseHeadersPolicy: cloudfront.ResponseHeadersPolicy | undefined;
  const own: Pattern = {
    id: 'own-policy',
    functionCode: `${PATTERNS_DIR}/00-hello-fetch/function.js`,
    origin(scope) {
      responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(scope, 'Headers', {
        customHeadersBehavior: { customHeaders: [{ header: 'x-demo', value: '1', override: true }] },
      });
      return new origins.HttpOrigin('example.com', { originId: 'own-policy' });
    },
    get behavior() {
      return { responseHeadersPolicy };
    },
  };
  const app = new cdk.App();
  const foundation = new FoundationStack(app, 'FoundationStack', [own], { env });
  const template = Template.fromStack(foundation);
  const policies = Object.entries(template.findResources('AWS::CloudFront::ResponseHeadersPolicy')) as [string, { Properties: { ResponseHeadersPolicyConfig: Record<string, any> } }][];
  const [ownId, policy] = policies.find(([, p]) => p.Properties.ResponseHeadersPolicyConfig.CustomHeadersConfig)!;
  const config = policy.Properties.ResponseHeadersPolicyConfig;
  assert.deepEqual(config.ServerTimingHeadersConfig, { Enabled: true, SamplingRate: SERVER_TIMING_SAMPLING_RATE });
  assert.deepEqual(config.CustomHeadersConfig.Items, [{ Header: 'x-demo', Value: '1', Override: true }]);
  const [dist] = Object.values(template.findResources('AWS::CloudFront::Distribution')) as { Properties: { DistributionConfig: Record<string, any> } }[];
  assert.equal(dist.Properties.DistributionConfig.CacheBehaviors[0].ResponseHeadersPolicyId.Ref, ownId, 'the behavior uses the pattern policy');
});

test('a managed (uneditable) response headers policy is rejected', () => {
  const managed: Pattern = {
    id: 'managed-policy',
    functionCode: `${PATTERNS_DIR}/00-hello-fetch/function.js`,
    origin: () => new origins.HttpOrigin('example.com', { originId: 'managed-policy' }),
    behavior: { responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS },
  };
  assert.throws(() => synth([managed]), /must be a cloudfront.ResponseHeadersPolicy created in the pattern/);
});
