import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Pattern } from '../../infra/lib/pattern';
import { WebFunctionOrigin } from '../../infra/lib/web-function-origin';

/**
 * 09-agent-authz: per-resource authorization for AI agents, decided at the edge.
 *
 * One origin, one Fastify app on a Lambda Web Function, two jobs:
 *  - POST /v1/check   the authorization service. The CloudFront Function calls it with cf.fetch
 *                     and gets back { allowed }.
 *  - anything else    the orders backend. Only requests the function allowed reach it.
 *
 * The endpoint is IamAuth and signed by CloudFront through origin access control (OAC); its
 * resource policy lets only this distribution invoke it. The app also checks the secret
 * x-origin-verify header CloudFront adds.
 */
export const pattern: Pattern = {
  id: 'agent-authz',
  functionCode: path.join(__dirname, 'function.js'),

  origin(scope: Construct): cloudfront.IOrigin {
    const secret = new secretsmanager.Secret(scope, 'OriginSecret', {
      description: 'Shared secret CloudFront sends to the agent-authz origin',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });

    return new WebFunctionOrigin(scope, 'AuthzService', {
      codeDir: path.join(__dirname, 'lambda'),
      originId: 'agent-authz',
      timeout: cdk.Duration.seconds(5),
      environment: { ORIGIN_SECRET: secret.secretValue.unsafeUnwrap() },
      customHeaders: { 'x-origin-verify': secret.secretValue.unsafeUnwrap() },
    }).origin;
  },

  behavior: {
    // Allowed reads are cacheable and shared by every agent: the cache key has no token,
    // because the function re-checks authorization before the cache on every request.
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
  },
};
