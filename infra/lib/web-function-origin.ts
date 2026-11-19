import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface WebFunctionOriginProps {
  /**
   * The origin's folder: an `index.js` that starts an HTTP server on port 3000 (each pattern uses a
   * Fastify app), with its package.json dependencies. Deployed without `test/` and `node_modules/`;
   * the bundle runs `npm ci` for the dependencies.
   */
  readonly codeDir: string;
  /** The CloudFront origin id; `cf.fetch` names the origin by it. */
  readonly originId: string;
  readonly environment?: Record<string, string>;
  /** Headers CloudFront adds to every origin request, the network call included. */
  readonly customHeaders?: Record<string, string>;
  /** @default Duration.seconds(10) */
  readonly timeout?: cdk.Duration;
}

/**
 * A pattern's origin as a Lambda Web Function behind CloudFront origin access control.
 *
 * - The Web Function runs the folder's own server (`index.js`, an HTTP server on port 3000).
 * - The endpoint uses `IamAuth`. The OAC has origin type `lambda` and signs with `always-amz-auth`:
 *   CloudFront signs every origin request, the network call included, with an unsigned payload, so a
 *   POST needs no `x-amz-content-sha256`, and the viewer's `Authorization` header reaches the origin.
 * - When the origin is bound to the distribution, the Web Function's resource policy allows
 *   `cloudfront.amazonaws.com` to invoke the endpoint for that distribution only.
 * - Use an origin request policy without the viewer's Host header (`ALL_VIEWER_EXCEPT_HOST_HEADER`):
 *   the endpoint answers 404 to the distribution's own Host.
 */
export class WebFunctionOrigin extends Construct {
  readonly webFunction: lambda.WebFunction;
  readonly origin: cloudfront.IOrigin;

  constructor(scope: Construct, id: string, props: WebFunctionOriginProps) {
    super(scope, id);

    this.webFunction = new lambda.WebFunction(this, 'Function', {
      code: lambda.WebFunctionCode.fromAssetToManagedBucket(props.codeDir, {
        bundling: {
          image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:24'),
          local: { tryBundle: (outputDir) => bundle(props.codeDir, outputDir) },
        },
      }),
      runtime: lambda.WebFunctionRuntime.NODEJS_24_X,
      defaultEndpointAuth: lambda.WebFunctionAuthType.IAM_AUTH,
      environment: props.environment,
      timeout: props.timeout ?? cdk.Duration.seconds(10),
      // A log group the stack owns, so `cdk destroy` deletes it (the construct's default keeps it for 2 years).
      logGroup: new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });

    const oac = new cloudfront.FunctionUrlOriginAccessControl(this, 'OriginAccessControl', {
      signing: cloudfront.Signing.SIGV4_ALWAYS_AMZ_AUTH,
    });
    this.origin = new BoundWebFunctionOrigin(this.webFunction, {
      originId: props.originId,
      originAccessControlId: oac.originAccessControlId,
      customHeaders: props.customHeaders,
    });
  }
}

/** An HttpOrigin to the endpoint that grants this distribution invoke access when it is bound. */
class BoundWebFunctionOrigin extends origins.HttpOrigin {
  constructor(private readonly webFunction: lambda.WebFunction, props: origins.HttpOriginProps) {
    super(webFunction.endpoint.domainName, { ...props, protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY });
  }

  public bind(scope: Construct, options: cloudfront.OriginBindOptions): cloudfront.OriginBindConfig {
    const config = super.bind(scope, options);
    const stack = cdk.Stack.of(scope);
    this.webFunction.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['lambda:InvokeWebFunctionEndpoint'],
      resources: [this.webFunction.endpoint.endpointArn],
      conditions: {
        StringEquals: {
          'aws:SourceArn': stack.formatArn({
            service: 'cloudfront', region: '', resource: 'distribution', resourceName: options.distributionId,
          }),
        },
      },
    }));
    return config;
  }
}

/** The package: the origin folder without tests and node_modules, with its dependencies installed. */
function bundle(codeDir: string, outputDir: string): boolean {
  if (!fs.existsSync(path.join(codeDir, 'index.js'))) {
    throw new Error(`${codeDir}: a Web Function origin needs an index.js that starts the server on port 3000`);
  }
  fs.cpSync(codeDir, outputDir, {
    recursive: true,
    filter: (src) => !/^(test|node_modules)([/\\]|$)/.test(path.relative(codeDir, src)),
  });
  const pkgPath = path.join(outputDir, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : { name: 'origin', private: true };
  pkg.type = 'module';
  pkg.main = 'index.js';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  if (Object.keys(pkg.dependencies ?? {}).length) {
    execFileSync('npm', [fs.existsSync(path.join(outputDir, 'package-lock.json')) ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'],
      { cwd: outputDir, stdio: 'ignore' });
  }
  return true;
}
