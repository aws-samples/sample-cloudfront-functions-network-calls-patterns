import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';
import { Pattern, PatternContext } from '../../infra/lib/pattern';
import { WebFunctionOrigin } from '../../infra/lib/web-function-origin';

/**
 * 07-kvs-config-plus-fetch: read-through config, KVS first, cf.fetch on a miss.
 *
 * The function reads `cfg-<key>` from the shared KVS. On a miss (or an expired
 * entry) it GETs /config/<key> from this origin, a Fastify server on a Lambda
 * Web Function (IamAuth endpoint behind OAC, invocable only by this distribution)
 * that serves the config and counts the read in DynamoDB (one item per key per
 * minute). The table's stream feeds the Promoter: a counter reaching
 * HOT_THRESHOLD becomes a marker item (TTL = PROMOTE_SECONDS), and markers are
 * mirrored into KVS, put on write and deleted when DynamoDB TTL removes them.
 * Promotion never touches the request path, and the function makes one call.
 *
 * `keyValueStore: true` associates the shared KVS with the function; the same
 * store's ARN reaches the Promoter through `ctx.keyValueStore`.
 */
const LAMBDA_DIR = path.join(__dirname, 'lambda');
const HOT_THRESHOLD = 5; // origin reads of one key...
const HOT_WINDOW_SECONDS = 60; // ...inside one fixed window make it hot
const PROMOTE_SECONDS = 600; // how long a promoted key is served from KVS before it is read through again

export const pattern: Pattern = {
  id: 'kvs-config-plus-fetch',
  functionCode: path.join(__dirname, 'function.js'),
  keyValueStore: true,

  origin(scope: Construct, ctx: PatternContext): cloudfront.IOrigin {
    const kvsArn = ctx.keyValueStore.keyValueStoreArn;

    const table = new dynamodb.TableV2(scope, 'HotKeys', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const code = lambdaCode();
    const environment = {
      TABLE_NAME: table.tableName,
      KVS_ARN: kvsArn,
      HOT_THRESHOLD: String(HOT_THRESHOLD),
      HOT_WINDOW_SECONDS: String(HOT_WINDOW_SECONDS),
      PROMOTE_SECONDS: String(PROMOTE_SECONDS),
    };

    // The origin: lambda/index.js (Fastify) on a Web Function. The same folder holds the promoter;
    // the Web Function bundle copies it whole and runs npm ci.
    const server = new WebFunctionOrigin(scope, 'ConfigOrigin', {
      codeDir: LAMBDA_DIR,
      originId: 'kvs-config-plus-fetch',
      environment,
      timeout: cdk.Duration.seconds(5),
    });
    table.grantWriteData(server.webFunction);

    const promoter = new lambda.Function(scope, 'Promoter', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'promoter.handler',
      code,
      timeout: cdk.Duration.seconds(30),
      environment,
    });
    table.grantWriteData(promoter);
    // Only the records that matter wake it: a counter at exactly the threshold, and any marker change.
    promoter.addEventSource(new DynamoEventSource(table, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 50, // at most one KVS write per record, and UpdateKeys takes 50
      maxBatchingWindow: cdk.Duration.seconds(1),
      bisectBatchOnError: true,
      retryAttempts: 3,
      filters: [
        lambda.FilterCriteria.filter({ dynamodb: { NewImage: { hits: { N: lambda.FilterRule.isEqual(String(HOT_THRESHOLD)) } } } }),
        lambda.FilterCriteria.filter({ dynamodb: { Keys: { pk: { S: lambda.FilterRule.beginsWith('kvs#') } } } }),
      ],
    }));
    // Describe (for the ETag) and write keys in the shared KVS, nothing else.
    promoter.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:UpdateKeys'],
      resources: [kvsArn],
    }));

    // The endpoint only accepts SigV4-signed calls: IamAuth + origin access control, granted to the
    // cloudfront service principal for THIS distribution only.
    return server.origin;
  },

  // GET only: nothing here needs a body.
  behavior: { allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD },
};

/**
 * The Promoter's package. The KVS data plane needs SigV4a, which the Lambda-provided
 * SDK lacks, so the SDK clients and the pure-JS signer are installed from
 * lambda/package-lock.json at synth time (locally with npm, or in the runtime's
 * Docker image as a fallback). Same bundling as 04-ab-global-table.
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
