import * as path from 'node:path';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Pattern } from '../../infra/lib/pattern';
import { WebFunctionOrigin } from '../../infra/lib/web-function-origin';

/**
 * 00-hello-fetch: the smallest possible cf.fetch round trip.
 *
 * Origin: a Lambda Web Function with an IamAuth endpoint behind CloudFront origin
 * access control (OAC signs every origin request; the function's resource policy
 * lets only this distribution invoke it), plus a secret custom header CloudFront
 * adds on every origin request. The function GETs
 * `/hello`, copies `message` from the JSON into `x-hello-message`, and forwards.
 *
 * A 200 from /hello via cf.fetch also shows that cf.fetch sub-requests are OAC-signed.
 */
export const pattern: Pattern = {
  id: 'hello-fetch',
  functionCode: path.join(__dirname, 'function.js'),

  origin(scope: Construct): cloudfront.IOrigin {
    const secret = new secretsmanager.Secret(scope, 'OriginSecret', {
      description: 'Shared secret CloudFront sends to the hello-fetch origin',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });

    return new WebFunctionOrigin(scope, 'Origin', {
      codeDir: path.join(__dirname, 'lambda'),
      originId: 'hello-fetch',
      environment: { ORIGIN_SECRET: secret.secretValue.unsafeUnwrap() },
      customHeaders: { 'x-origin-verify': secret.secretValue.unsafeUnwrap() },
    }).origin;
  },
};
