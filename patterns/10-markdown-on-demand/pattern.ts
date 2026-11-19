import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { ExtraOrigin, Pattern, PatternContext } from '../../infra/lib/pattern';

/**
 * 10-markdown-on-demand: AI agents get a markdown copy of a page, made the first time one asks.
 *
 * Two origins:
 *  - `markdown-on-demand` (behavior origin) a private S3 bucket (OAC) with the HTML pages
 *    and, once converted, a `<page>.md` next to each. Viewers land here.
 *  - `markdown-on-demand-queue` (extra origin, no behavior) the 05 shape: an API Gateway
 *    REST API that turns the function's cf.beacon into SQS FIFO SendMessage. No Lambda in
 *    the request path.
 *
 * A worker Lambda on the queue converts the page with turndown, writes the .md, then the
 * KVS key `md:<uri>` the function checks before it beacons. A reset message (GET
 * /patterns/markdown-on-demand/reset?page=...) deletes the key, and an hourly schedule deletes
 * every md: key, so the demo can always show a first conversion again.
 *
 * Who is an AI agent comes from AWS WAF, not from a user-agent list in the function: Bot
 * Control (botControl: true) labels the request, and two count rules turn the label into the
 * header x-amzn-waf-ai-agent: the bot's name, or none.
 */
const ID = 'markdown-on-demand';
const QUEUE_ORIGIN = 'markdown-on-demand-queue';
const LAMBDA_DIR = path.join(__dirname, 'lambda');

export const pattern: Pattern = {
  id: ID,
  functionCode: path.join(__dirname, 'function.js'),
  // Viewer-response: no call, it copies x-markdown onto the response (S3 echoes nothing).
  responseFunctionCode: path.join(__dirname, 'response-function.js'),
  keyValueStore: true,
  botControl: true, // bot:category:ai and bot:name labels for the agent header

  origin(scope: Construct): cloudfront.IOrigin {
    const bucket = new s3.Bucket(scope, 'Pages', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Seed the HTML pages. prune:false keeps the .md files the worker wrote across deploys.
    new s3deploy.BucketDeployment(scope, 'PageObjects', {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(path.join(__dirname, 'objects'))],
      prune: false,
    });

    // OAC, read only; CDK writes the bucket policy for this distribution only. A missing page is a 403.
    return origins.S3BucketOrigin.withOriginAccessControl(bucket, { originId: ID });
  },

  // The queue the function beacons into, and the worker that drains it.
  extraOrigins(scope: Construct, ctx: PatternContext): ExtraOrigin[] {
    const bucket = scope.node.findChild('Pages') as s3.Bucket;

    const queue = new sqs.Queue(scope, 'Queue', {
      fifo: true,
      // A convert body is { uri, minute }: the same page within a minute is one message.
      // A reset carries a timestamp, so it is never dropped as a repeat.
      contentBasedDeduplication: true,
      retentionPeriod: cdk.Duration.days(1),
      visibilityTimeout: cdk.Duration.minutes(3),
    });

    const apiKeySecret = new secretsmanager.Secret(scope, 'ApiKeySecret', {
      description: 'API key CloudFront sends to the markdown-on-demand queue API',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });

    const api = new apigateway.RestApi(scope, 'Api', {
      restApiName: 'network-calls-markdown-on-demand',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: { stageName: 'patterns' },
      defaultMethodOptions: { apiKeyRequired: true },
      cloudWatchRole: false,
    });
    const key = api.addApiKey('Key', { value: apiKeySecret.secretValue.unsafeUnwrap() });
    const plan = api.addUsagePlan('Plan', { apiStages: [{ api, stage: api.deploymentStage }] });
    plan.addApiKey(key);

    // POST /patterns/convert -> SQS SendMessage, the body as the message. One message group:
    // conversions run one at a time, which is plenty for pages agents discover.
    const role = new iam.Role(scope, 'ApiToQueueRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    queue.grantSendMessages(role);
    const sendMessage = new apigateway.AwsIntegration({
      service: 'sqs',
      path: `${cdk.Aws.ACCOUNT_ID}/${queue.queueName}`,
      integrationHttpMethod: 'POST',
      options: {
        credentialsRole: role,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestParameters: {
          'integration.request.header.Content-Type': "'application/x-www-form-urlencoded'",
        },
        requestTemplates: {
          'application/json': ['Action=SendMessage', 'MessageGroupId=pages', 'MessageBody=$util.urlEncode($input.body)'].join('&'),
        },
        integrationResponses: [
          { statusCode: '200', responseTemplates: { 'application/json': '{"sent": true}' } },
          { statusCode: '400', selectionPattern: '4\\d{2}', responseTemplates: { 'application/json': '{"sent": false}' } },
          { statusCode: '500', selectionPattern: '5\\d{2}', responseTemplates: { 'application/json': '{"sent": false}' } },
        ],
      },
    });
    api.root.addResource('convert').addMethod('POST', sendMessage, {
      methodResponses: [{ statusCode: '200' }, { statusCode: '400' }, { statusCode: '500' }],
    });

    // The worker: reads the HTML from the bucket (not through the distribution, so it never
    // triggers itself), writes <page>.md and the KVS key; a reset or the sweep deletes the key.
    const kvsArn = ctx.keyValueStore.keyValueStoreArn;
    const worker = new lambda.Function(scope, 'Worker', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambdaCode(),
      timeout: cdk.Duration.seconds(30),
      environment: { BUCKET_NAME: bucket.bucketName, KVS_ARN: kvsArn },
    });
    bucket.grantRead(worker, 'patterns/markdown-on-demand/*');
    bucket.grantPut(worker, 'patterns/markdown-on-demand/*.md');
    worker.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:PutKey',
        'cloudfront-keyvaluestore:DeleteKey', 'cloudfront-keyvaluestore:ListKeys',
      ],
      resources: [kvsArn],
    }));
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }));

    // The sweep: every hour the worker deletes every md: key, so the live demo goes
    // back to "not converted" on its own (KVS has no TTL).
    new events.Rule(scope, 'Sweep', {
      description: 'Hourly reset of the markdown-on-demand demo: deletes every md: key',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(worker)],
    });

    new cdk.CfnOutput(scope, 'QueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(scope, 'PagesBucket', { value: bucket.bucketName });

    // No origin path: the stage name is already the first path segment of /patterns/convert.
    const origin = new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', api.url)), {
      originId: QUEUE_ORIGIN,
      customHeaders: { 'x-api-key': apiKeySecret.secretValue.unsafeUnwrap() },
    });
    return [{ id: QUEUE_ORIGIN, origin }];
  },

  // Both rules insert the same header, and the last rule that matches wins: every request on
  // this path gets one, so a viewer-supplied x-amzn-waf-ai-agent is always overwritten.
  webAclRules(): wafv2.CfnWebACL.RuleProperty[] {
    const onPath = { byteMatchStatement: { searchString: `/patterns/${ID}/`, fieldToMatch: { uriPath: {} },
      positionalConstraint: 'STARTS_WITH', textTransformations: [{ priority: 0, type: 'NONE' }] } };
    const metrics = (name: string) => ({ cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true });
    const insertAgent = (value: string) => ({ count: { customRequestHandling: { insertHeaders: [{ name: 'ai-agent', value }] } } });
    return [
      {
        name: `${ID}-not-an-agent`,
        priority: 0,
        action: insertAgent('none'),
        statement: onPath,
        visibilityConfig: metrics(`${ID}-not-an-agent`),
      },
      {
        // Dynamic label interpolation: the bot's name label (gptbot, claudebot, ...) becomes the value.
        name: `${ID}-ai-agent`,
        priority: 0,
        action: insertAgent('${awswaf:managed:aws:bot-control:bot:name:}'),
        statement: { andStatement: { statements: [onPath,
          { labelMatchStatement: { scope: 'LABEL', key: 'awswaf:managed:aws:bot-control:bot:category:ai' } }] } },
        visibilityConfig: metrics(`${ID}-ai-agent`),
      },
    ];
  },

  behavior: {
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
    originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
  },
};

/**
 * turndown and the KVS client (SigV4a, which the Lambda-provided SDK lacks) are installed
 * from lambda/package-lock.json at synth time (locally with npm, or in the runtime's Docker
 * image as a fallback). Same as 04.
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
