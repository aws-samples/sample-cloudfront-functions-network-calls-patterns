import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Pattern, PatternContext } from '../../infra/lib/pattern';
import { WebFunctionOrigin } from '../../infra/lib/web-function-origin';

/**
 * 04-ab-global-table: sticky A/B variant per user.
 *
 * KVS is the warm working set the function reads first. DynamoDB (a global
 * table: us-east-1 + one replica in eu-west-1) is the source of truth. On a
 * KVS miss the function POSTs /assign/<uid> to this origin, which assigns
 * once (conditional PutItem), fills KVS, and answers { variant }. The origin is
 * a Fastify server on a Lambda Web Function (IamAuth endpoint behind origin
 * access control). A stream Lambda (a normal Lambda function built from the same
 * folder) mirrors DynamoDB into KVS: TTL expiry evicts, a MODIFY rewrites.
 *
 * Two hooks: the viewer-request function decides (KVS, then ONE cf.fetch on a
 * miss) and leaves x-ab-set-uid / x-ab-set-variant on the request; the
 * viewer-response function turns those into the uid and ab cookies. Cookies are
 * set in exactly one place, and the response side makes no network call.
 *
 * `keyValueStore: true` associates the shared KVS with both functions; the same
 * store's ARN reaches the Lambdas through `ctx.keyValueStore`.
 */
const LAMBDA_DIR = path.join(__dirname, 'lambda');

export const pattern: Pattern = {
  id: 'ab-global-table',
  functionCode: path.join(__dirname, 'function.js'),
  responseFunctionCode: path.join(__dirname, 'response-function.js'),
  keyValueStore: true,

  origin(scope: Construct, ctx: PatternContext): cloudfront.IOrigin {
    const kvsArn = ctx.keyValueStore.keyValueStoreArn;

    const table = new dynamodb.TableV2(scope, 'Assignments', {
      partitionKey: { name: 'uid', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      replicas: [{ region: 'eu-west-1' }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const secret = new secretsmanager.Secret(scope, 'OriginSecret', {
      description: 'Shared secret CloudFront sends to the ab-global-table origin',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });

    const environment = { TABLE_NAME: table.tableName, KVS_ARN: kvsArn };

    // Two locks: the endpoint only accepts SigV4-signed calls (IamAuth + origin access control, granted
    // to the cloudfront service principal for THIS distribution only), and the loader also checks the secret header.
    const loader = new WebFunctionOrigin(scope, 'Loader', {
      codeDir: LAMBDA_DIR,
      originId: 'ab-global-table',
      timeout: cdk.Duration.seconds(5),
      environment: { TABLE_NAME: table.tableName, ORIGIN_SECRET: secret.secretValue.unsafeUnwrap() },
      customHeaders: { 'x-origin-verify': secret.secretValue.unsafeUnwrap() },
    });
    table.grantReadWriteData(loader.webFunction);

    const evictor = new lambda.Function(scope, 'Evictor', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'stream.handler',
      code: lambdaCode(),
      timeout: cdk.Duration.seconds(30),
      environment,
    });
    evictor.addEventSource(new DynamoEventSource(table, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: cdk.Duration.seconds(5),
      bisectBatchOnError: true,
      retryAttempts: 3,
    }));

    grantKvsWrite(evictor, kvsArn); // the stream consumer is the only KVS writer

    return loader.origin;
  },
};

/** Describe (for the ETag) and write keys in the shared KVS, nothing else. */
function grantKvsWrite(fn: { addToRolePolicy(statement: iam.PolicyStatement): void }, kvsArn: string): void {
  fn.addToRolePolicy(new iam.PolicyStatement({
    actions: ['cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:UpdateKeys'],
    resources: [kvsArn],
  }));
}

/**
 * The evictor's package. The KVS data plane needs SigV4a, which the Lambda-provided
 * SDK lacks, so the KVS client and the pure-JS signer are installed from
 * lambda/package-lock.json at synth time (locally with npm, or in the runtime's
 * Docker image as a fallback). The loader's package is built by WebFunctionOrigin.
 */
function lambdaCode(): lambda.Code {
  return lambda.Code.fromAsset(LAMBDA_DIR, {
    exclude: ['node_modules', 'test'],
    bundling: {
      image: lambda.Runtime.NODEJS_22_X.bundlingImage,
      command: ['bash', '-c', 'cp -r /asset-input/. /asset-output/ && cd /asset-output && npm ci --omit=dev --no-audit --no-fund'],
      local: {
        tryBundle(outputDir: string): boolean {
          fs.cpSync(LAMBDA_DIR, outputDir, { recursive: true, filter: (src) => !['node_modules', 'test'].includes(path.basename(src)) });
          execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: outputDir, stdio: 'inherit' });
          return true;
        },
      },
    },
  });
}
