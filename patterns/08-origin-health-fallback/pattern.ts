import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { ExtraOrigin, Pattern } from '../../infra/lib/pattern';
import { WebFunctionOrigin } from '../../infra/lib/web-function-origin';

/**
 * 08-origin-health-fallback: failover for POST traffic, which origin groups cannot do.
 *
 * Three origins, no origin group in CDK:
 *  - behavior origin `origin-health-fallback` (the pattern id, the cf.fetch
 *    probe target): the primary Lambda Web Function (a Fastify server), an
 *    IamAuth endpoint behind CloudFront OAC (the resource policy lets only this
 *    distribution invoke it) plus the secret `x-origin-verify` header. Can be
 *    told to fail (?simulate=down) or to be slow (?simulate=slow).
 *  - extra origin `origin-health-fallback-secondary`: the same code as a second
 *    Web Function (ROLE=secondary, ignores ?simulate=), the POST standby. In production
 *    this is another Region.
 *  - extra origin `origin-health-fallback-static`: a private S3 bucket (OAC)
 *    holding a static mirror of the pages at the SAME paths, the GET/HEAD fallback.
 * No behavior points at the extra origins; the function routes to them with the
 * runtime 2.0 origin helpers.
 *
 * viewer-request (function.js): when gated on, probes GET /health via cf.fetch and
 * on failure cf.selectRequestOriginById(secondary for POST, mirror for GET/HEAD);
 * GET/HEAD on the primary route also get a cf.createRequestOriginGroup (5xx).
 * viewer-response (response-function.js): annotates who answered.
 * `keyValueStore: true` for the `health-probe` gate.
 */
export const pattern: Pattern = {
  id: 'origin-health-fallback',
  functionCode: path.join(__dirname, 'function.js'),
  responseFunctionCode: path.join(__dirname, 'response-function.js'),
  keyValueStore: true,

  origin(scope: Construct): cloudfront.IOrigin {
    // Primary: Web Function, IamAuth endpoint + OAC, secret header.
    return webFunctionOrigin(scope, 'Origin', 'primary', 'origin-health-fallback');
  },

  // The POST standby Web Function and the S3 static mirror, reachable only through
  // cf.selectRequestOriginById / cf.createRequestOriginGroup in function.js.
  extraOrigins(scope: Construct): ExtraOrigin[] {
    const secondary = webFunctionOrigin(scope, 'Secondary', 'secondary', 'origin-health-fallback-secondary');

    // S3 static mirror behind OAC; CDK writes the bucket policy for this distribution only.
    const bucket = new s3.Bucket(scope, 'MirrorBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    new s3deploy.BucketDeployment(scope, 'MirrorObjects', {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(path.join(__dirname, 'objects'))],
    });
    const mirror = origins.S3BucketOrigin.withOriginAccessControl(bucket, { originId: 'origin-health-fallback-static' });
    return [
      { id: 'origin-health-fallback-secondary', origin: secondary },
      { id: 'origin-health-fallback-static', origin: mirror },
    ];
  },

  behavior: {
    // POST is the point. Origin groups still only fail over GET/HEAD/OPTIONS, which is why
    // function.js builds a group for GET/HEAD only and probes + selects an origin for the rest.
    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
  },
};

// A Lambda Web Function behind OAC, locked by its own secret custom header.
function webFunctionOrigin(scope: Construct, id: string, role: string, originId: string): cloudfront.IOrigin {
  const secret = new secretsmanager.Secret(scope, id === 'Origin' ? 'OriginSecret' : `${id}Secret`, {
    description: `Shared secret CloudFront sends to the origin-health-fallback ${role} origin`,
    generateSecretString: { excludePunctuation: true, passwordLength: 32 },
  });
  return new WebFunctionOrigin(scope, id, {
    codeDir: path.join(__dirname, 'lambda'),
    originId,
    timeout: cdk.Duration.seconds(5),
    environment: { ORIGIN_SECRET: secret.secretValue.unsafeUnwrap(), ROLE: role },
    customHeaders: { 'x-origin-verify': secret.secretValue.unsafeUnwrap() },
  }).origin;
}
