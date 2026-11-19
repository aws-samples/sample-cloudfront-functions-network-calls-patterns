import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { Pattern, PatternContext } from '../../infra/lib/pattern';

/**
 * 11-edge-waiting-room: a virtual waiting room. The queue is two integers: a ticket counter
 * in DynamoDB (drawn with the function's one cf.fetch) and a watermark in KVS (raised by an
 * admission Lambda once a minute). Membership is a signed cookie.
 *
 * One origin, an API Gateway REST API locked to the distribution with an API key (the 05 shape):
 *  - POST /patterns/enqueue                -> DynamoDB UpdateItem ADD n 1 on one counter shard,
 *                                             no Lambda; the stage throttle caps it below the table
 *  - POST /patterns/leave                  -> DynamoDB UpdateItem ADD freed {ticket} (a number set),
 *                                             the function's cf.beacon from /leave
 *  - ANY  /patterns/edge-waiting-room/*    -> the "protected origin": a mock that echoes x-wr
 *
 * The stage is called `patterns` so viewer paths need no origin path rewrite (see 05).
 *
 * AWS WAF, scoped to this path only (webAclRules): Bot Control in count mode for its token
 * labels, a Challenge on page loads so only a real browser draws a ticket, and a count rule that
 * hands the WAF token id to the function, which binds the admission cookie to it. A first visit
 * gets a CAPTCHA; the silent challenge takes over once it expires.
 */
const ID = 'edge-waiting-room';
const LAMBDA_DIR = path.join(__dirname, 'lambda');
// Admits per minute. The demo admits a few people a minute; size it to what the origin absorbs.
const STEP = 5;
// Below a new on-demand table's 4,000 writes/s, so nothing throttles at minute zero without
// pre-warming. A bigger launch pre-warms the table (warm throughput) and raises this.
const ENQUEUE_PER_SECOND = 3000;
// Demo only: the admission Lambda keeps about this many simulated visitors in line, so a real
// visitor watches the position fall by STEP a minute. 0 for a real launch.
const DEMO_LINE = 10;

// Created in origin(), read by FoundationStack through `behavior` below.
let originRequestPolicy: cloudfront.IOriginRequestPolicy | undefined;

export const pattern: Pattern = {
  id: ID,
  functionCode: path.join(__dirname, 'function.js'),
  keyValueStore: true,
  botControl: true, // token id labels for the client binding

  origin(scope: Construct, ctx: PatternContext): cloudfront.IOrigin {
    const table = new dynamodb.Table(scope, 'Counters', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // "e<epoch>-<shard>"
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const apiKeySecret = new secretsmanager.Secret(scope, 'ApiKeySecret', {
      description: 'API key CloudFront sends to the edge-waiting-room API',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });
    const api = new apigateway.RestApi(scope, 'Api', {
      restApiName: 'network-calls-edge-waiting-room',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: {
        stageName: 'patterns',
        throttlingRateLimit: ENQUEUE_PER_SECOND,
        throttlingBurstLimit: ENQUEUE_PER_SECOND,
      },
      defaultMethodOptions: { apiKeyRequired: true },
      cloudWatchRole: false,
    });
    const key = api.addApiKey('Key', { value: apiKeySecret.secretValue.unsafeUnwrap() });
    const plan = api.addUsagePlan('Plan', { apiStages: [{ api, stage: api.deploymentStage }] });
    plan.addApiKey(key);

    // POST /patterns/enqueue {epoch, shard} -> UpdateItem ADD n :1, returns {"n": <new value>}.
    // Throttled (429) or failed (5xx) answers make the function fail closed.
    const role = new iam.Role(scope, 'ApiToTableRole', { assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com') });
    table.grant(role, 'dynamodb:UpdateItem');
    const enqueue = new apigateway.AwsIntegration({
      service: 'dynamodb',
      action: 'UpdateItem',
      options: {
        credentialsRole: role,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          'application/json': JSON.stringify({
            TableName: table.tableName,
            Key: { pk: { S: "e$input.path('$.epoch')-$input.path('$.shard')" } },
            UpdateExpression: 'ADD n :one',
            ExpressionAttributeValues: { ':one': { N: '1' } },
            ReturnValues: 'UPDATED_NEW',
          }),
        },
        integrationResponses: [
          { statusCode: '200', responseTemplates: { 'application/json': "{\"n\": $input.path('$.Attributes.n.N')}" } },
          { statusCode: '400', selectionPattern: '4\\d{2}', responseTemplates: { 'application/json': '{"n": null}' } },
          { statusCode: '500', selectionPattern: '5\\d{2}', responseTemplates: { 'application/json': '{"n": null}' } },
        ],
      },
    });
    api.root.addResource('enqueue').addMethod('POST', enqueue, {
      methodResponses: [{ statusCode: '200' }, { statusCode: '400' }, { statusCode: '500' }],
    });

    // POST /patterns/leave {epoch, ticket} -> UpdateItem ADD freed {ticket}. A number set: the same
    // ticket added twice is still one member, so replaying a cookie can't free extra places.
    const leave = new apigateway.AwsIntegration({
      service: 'dynamodb',
      action: 'UpdateItem',
      options: {
        credentialsRole: role,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          'application/json': JSON.stringify({
            TableName: table.tableName,
            Key: { pk: { S: "e$input.path('$.epoch')-left" } },
            UpdateExpression: 'ADD freed :ticket', // no #name placeholder: # starts a VTL directive
            ExpressionAttributeValues: { ':ticket': { NS: ["$input.path('$.ticket')"] } },
          }),
        },
        integrationResponses: [
          { statusCode: '200', responseTemplates: { 'application/json': '{"left": true}' } },
          { statusCode: '400', selectionPattern: '4\\d{2}', responseTemplates: { 'application/json': '{"left": false}' } },
          { statusCode: '500', selectionPattern: '5\\d{2}', responseTemplates: { 'application/json': '{"left": false}' } },
        ],
      },
    });
    api.root.addResource('leave').addMethod('POST', leave, {
      methodResponses: [{ statusCode: '200' }, { statusCode: '400' }, { statusCode: '500' }],
    });

    // The protected origin: only admitted viewers (or a queue that is off) reach it.
    const shop = new apigateway.MockIntegration({
      requestTemplates: { 'application/json': '{"statusCode": 200}' },
      integrationResponses: [{
        statusCode: '200',
        responseTemplates: { 'application/json': "{\"path\": \"$context.path\", \"x-wr\": \"$util.escapeJavaScript($input.params('x-wr'))\", \"message\": \"you are past the waiting room\"}" },
      }],
    });
    api.root.addResource(ID).addResource('{proxy+}').addMethod('ANY', shop, { methodResponses: [{ statusCode: '200' }] });

    // The admission Lambda: once a minute, raise the watermark by STEP and publish queue-state.
    const kvsArn = ctx.keyValueStore.keyValueStoreArn;
    const admission = new lambda.Function(scope, 'Admission', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambdaCode(),
      timeout: cdk.Duration.seconds(20),
      environment: { TABLE_NAME: table.tableName, KVS_ARN: kvsArn, STEP: String(STEP), DEMO_LINE: String(DEMO_LINE) },
    });
    table.grant(admission, 'dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'); // UpdateItem: the simulated line
    admission.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:GetKey', 'cloudfront-keyvaluestore:UpdateKeys'],
      resources: [kvsArn],
    }));
    new events.Rule(scope, 'Tick', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)), // EventBridge's shortest rate
      targets: [new targets.LambdaFunction(admission)],
    });

    // The function binds wr_a to the viewer's TLS fingerprint, which CloudFront adds only when a
    // policy asks for it. x-wr carries the function's verdict to the mock. No Host: API Gateway
    // needs its own.
    originRequestPolicy = new cloudfront.OriginRequestPolicy(scope, 'OriginRequestPolicy', {
      comment: 'edge-waiting-room: x-wr and the JA4 fingerprint, no Host',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('x-wr', 'CloudFront-Viewer-JA4-Fingerprint'),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
    });

    new cdk.CfnOutput(scope, 'CountersTable', { value: table.tableName });

    return new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', api.url)), {
      originId: ID,
      customHeaders: { 'x-api-key': apiKeySecret.secretValue.unsafeUnwrap() },
    });
  },

  webAclRules(): wafv2.CfnWebACL.RuleProperty[] {
    const none = [{ priority: 0, type: 'NONE' }];
    const onPath = { byteMatchStatement: { searchString: `/patterns/${ID}/`, fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH', textTransformations: none } };
    const pageLoad = { byteMatchStatement: { searchString: 'text/html', fieldToMatch: { singleHeader: { Name: 'accept' } }, positionalConstraint: 'CONTAINS', textTransformations: none } };
    const metrics = (name: string) => ({ cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true });
    const hasLabel = (key: string) => ({ labelMatchStatement: { scope: 'LABEL', key } });
    // Bot Control (botControl: true, the shared count-only rule) runs before these: its token
    // management adds awswaf:managed:token:id:<id>, and curl still gets the function's 503, not a WAF 403.
    return [
      {
        // A browser that has never solved a CAPTCHA (token absent, or rejected:not_solved) gets one
        // on a page load. Once its CAPTCHA
        // expires (rejected:expired), the silent challenge below takes over, so a viewer solves one
        // CAPTCHA per visit. The labels come from the encrypted token, which the viewer can't forge.
        name: `${ID}-captcha`,
        priority: 0,
        action: { captcha: {} },
        statement: { andStatement: { statements: [onPath, pageLoad,
          { notStatement: { statement: hasLabel('awswaf:managed:captcha:accepted') } },
          { notStatement: { statement: hasLabel('awswaf:managed:captcha:rejected:expired') } },
        ] } },
        visibilityConfig: metrics(`${ID}-captcha`),
      },
      {
        // A page load without a valid aws-waf-token gets WAF's silent JavaScript challenge; a browser
        // solves it and reloads, a script can't, so it never draws a ticket. With a valid token the
        // rule acts like count and evaluation goes on.
        name: `${ID}-challenge`,
        priority: 0,
        action: { challenge: {} },
        statement: { andStatement: { statements: [onPath, pageLoad] } },
        visibilityConfig: metrics(`${ID}-challenge`),
      },
      {
        // Dynamic label interpolation: the token id becomes a header, which reaches the function as
        // x-amzn-waf-wr-token-id (WAF prefixes every header it inserts, and runs before the function).
        name: `${ID}-token-id`,
        priority: 0,
        action: { count: { customRequestHandling: { insertHeaders: [{ name: 'wr-token-id', value: '${awswaf:managed:token:id:}' }] } } },
        statement: { andStatement: { statements: [onPath, { labelMatchStatement: { scope: 'NAMESPACE', key: 'awswaf:managed:token:id:' } }] } },
        visibilityConfig: metrics(`${ID}-token-id`),
      },
    ];
  },

  // A getter: the policy only exists once origin() ran, which FoundationStack does before
  // FoundationStack reads this.
  get behavior() {
    return { originRequestPolicy };
  },
};

/**
 * The KVS client (SigV4a, which the Lambda-provided SDK lacks) is installed from
 * lambda/package-lock.json at synth time (locally with npm, or in the runtime's Docker image
 * as a fallback). Same as 10.
 */
function lambdaCode(): lambda.Code {
  return lambda.Code.fromAsset(LAMBDA_DIR, {
    exclude: ['node_modules'],
    bundling: {
      image: lambda.Runtime.NODEJS_22_X.bundlingImage,
      command: ['bash', '-c', 'cp -r /asset-input/. /asset-output/ && cd /asset-output && npm ci --omit=dev --no-audit --no-fund'],
      local: {
        tryBundle(outputDir: string): boolean {
          fs.cpSync(LAMBDA_DIR, outputDir, { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' });
          execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: outputDir, stdio: 'inherit' });
          return true;
        },
      },
    },
  });
}
