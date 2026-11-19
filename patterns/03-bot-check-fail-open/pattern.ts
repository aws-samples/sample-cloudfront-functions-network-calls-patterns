import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Pattern } from '../../infra/lib/pattern';
import { WebFunctionOrigin } from '../../infra/lib/web-function-origin';

/**
 * 03-bot-check-fail-open: ask a bot-detection vendor, fail open if it is slow or down.
 *
 * Origin: a Lambda Web Function (a Fastify server) that MOCKS a vendor (DataDome-style). Two locks:
 *   1. An IamAuth endpoint behind CloudFront origin access control (OAC signs every origin
 *      request); the resource policy lets only this distribution invoke it, never the public.
 *   2. A secret custom header CloudFront adds on every origin request; the app
 *      rejects anything without it.
 *   POST /check   -> { verdict: "human"|"bot", score, reasons }, honours x-mock-delay-ms
 *   anything else -> echoes the x-bot-* headers the function added
 *
 * Function: Promise.allSettled([cf.fetch(POST /check), kvs.get("bot-policy")]).
 * Policy block|tag|off comes from KVS (default tag). Vendor timeout (the runtime's 1 s)/error -> forward
 * with x-bot-check: unavailable.
 */
export const pattern: Pattern = {
  id: 'bot-check-fail-open',
  functionCode: path.join(__dirname, 'function.js'),
  // Associate the shared KVS so `cf.kvs().get('bot-policy')` works.
  keyValueStore: true,

  origin(scope: Construct): cloudfront.IOrigin {
    const secret = new secretsmanager.Secret(scope, 'OriginSecret', {
      description: 'Shared secret CloudFront sends to the bot-check-fail-open mock vendor',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });

    return new WebFunctionOrigin(scope, 'Origin', {
      codeDir: path.join(__dirname, 'lambda'),
      originId: 'bot-check-fail-open',
      environment: { ORIGIN_SECRET: secret.secretValue.unsafeUnwrap() },
      customHeaders: { 'x-origin-verify': secret.secretValue.unsafeUnwrap() },
      // x-mock-delay-ms is capped at 5000 in the app; leave headroom.
      timeout: cdk.Duration.seconds(10),
    }).origin;
  },
};
