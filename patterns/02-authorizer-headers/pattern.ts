import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Pattern } from '../../infra/lib/pattern';
import { WebFunctionOrigin } from '../../infra/lib/web-function-origin';

/**
 * 02-authorizer-headers: the API Gateway "Lambda authorizer with context" pattern, at the edge.
 *
 * One origin, one Fastify app on a Lambda Web Function, two jobs:
 *  - POST /authorize   the authorizer. The CloudFront Function calls it with cf.fetch and gets
 *                      back { allow, headers: { x-tenant, x-role } }.
 *  - anything else     the echo. Viewers land here and see the identity headers the function set.
 *
 * The endpoint uses IamAuth and CloudFront signs every origin request through origin access
 * control (OAC); the resource policy lets only this distribution invoke it. The app also checks
 * the secret x-origin-verify header CloudFront adds.
 */
export const pattern: Pattern = {
  id: 'authorizer-headers',
  functionCode: path.join(__dirname, 'function.js'),

  origin(scope: Construct): cloudfront.IOrigin {
    const secret = new secretsmanager.Secret(scope, 'OriginSecret', {
      description: 'Shared secret CloudFront sends to the authorizer-headers origin',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });

    return new WebFunctionOrigin(scope, 'Origin', {
      codeDir: path.join(__dirname, 'lambda'),
      originId: 'authorizer-headers',
      timeout: cdk.Duration.seconds(5),
      environment: { ORIGIN_SECRET: secret.secretValue.unsafeUnwrap() },
      customHeaders: { 'x-origin-verify': secret.secretValue.unsafeUnwrap() },
    }).origin;
  },
};
