import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { Pattern } from '../../infra/lib/pattern';

/**
 * 05-edge-signal-sqs: the function POSTs one small JSON signal into an SQS FIFO
 * queue through an API Gateway REST API service integration. No Lambda anywhere.
 *
 * Why REST API and not HTTP API: only REST APIs can require an API key, and an API
 * key in a CloudFront custom origin header is what locks the API to this
 * distribution without a Lambda authorizer. (HTTP API can set the dedup id too.)
 *
 * Why the stage is called `patterns`: a REST API needs the stage as the first path
 * segment, and the behavior forwards `/patterns/edge-signal-sqs/*` unchanged. Naming
 * the stage `patterns` means no origin path rewrite: the viewer path lands on the
 * `/edge-signal-sqs/{proxy+}` echo, and the function's `/patterns/signal` on the queue.
 */
export const pattern: Pattern = {
  id: 'edge-signal-sqs',
  functionCode: path.join(__dirname, 'function.js'),
  // Viewer-response: one more cf.beacon on the way out, gated to 5xx or x-signal-sample: 1.
  responseFunctionCode: path.join(__dirname, 'response-function.js'),

  origin(scope: Construct): cloudfront.IOrigin {
    const queue = new sqs.Queue(scope, 'Queue', {
      fifo: true,
      // Dedup id is set explicitly per message (the request URI), not from the body.
      contentBasedDeduplication: false,
      retentionPeriod: cdk.Duration.days(1),
    });

    const apiKeySecret = new secretsmanager.Secret(scope, 'ApiKeySecret', {
      description: 'API key CloudFront sends to the edge-signal-sqs API',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });

    const api = new apigateway.RestApi(scope, 'Api', {
      restApiName: 'network-calls-edge-signal-sqs',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: { stageName: 'patterns' },
      defaultMethodOptions: { apiKeyRequired: true },
      cloudWatchRole: false,
    });

    const key = api.addApiKey('Key', { value: apiKeySecret.secretValue.unsafeUnwrap() });
    const plan = api.addUsagePlan('Plan', { apiStages: [{ api, stage: api.deploymentStage }] });
    plan.addApiKey(key);

    // POST /patterns/signal -> SQS SendMessage. Body is the message; dedup id is the body's
    // `dedupId` when present ("served" events), else its `uri` ("requested" events).
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
          // A request without Content-Type is treated as application/json by API Gateway.
          'application/json':
            // `$!{d}` renders empty when the field is absent; `#{end}` keeps `Action` out of the directive.
            "#set($d = $input.path('$.dedupId'))#if(\"$!{d}\" == \"\")#set($d = $input.path('$.uri'))#{end}" +
            [
              'Action=SendMessage',
              'MessageGroupId=edge',
              'MessageDeduplicationId=$util.urlEncode($d)',
              'MessageBody=$util.urlEncode($input.body)',
            ].join('&'),
        },
        integrationResponses: [
          { statusCode: '200', responseTemplates: { 'application/json': '{"sent": true}' } },
          { statusCode: '400', selectionPattern: '4\\d{2}', responseTemplates: { 'application/json': '{"sent": false}' } },
          { statusCode: '500', selectionPattern: '5\\d{2}', responseTemplates: { 'application/json': '{"sent": false}' } },
        ],
      },
    });
    api.root.addResource('signal').addMethod('POST', sendMessage, {
      methodResponses: [{ statusCode: '200' }, { statusCode: '400' }, { statusCode: '500' }],
    });

    // ANY /patterns/edge-signal-sqs/* -> mock echo of the x-signal-* headers the function set.
    // A mock integration reads its status from the request template. Without a template for a
    // body's content type it parses the body itself and answers 500, so map the common types too.
    const ok = '{"statusCode": 200}';
    const echo = new apigateway.MockIntegration({
      requestTemplates: { 'application/json': ok, 'text/plain': ok, 'application/x-www-form-urlencoded': ok },
      integrationResponses: [
        {
          statusCode: '200',
          responseTemplates: {
            'application/json': [
              '#set($h = $input.params().header)',
              '#set($sep = "")',
              '{"path": "$context.path", "headersFromFunction": {',
              '#foreach($k in $h.keySet())',
              '#if($k.toLowerCase().startsWith("x-signal"))',
              '$sep"$k": "$util.escapeJavaScript($h.get($k))"',
              '#set($sep = ", ")',
              '#end',
              '#end',
              '}}',
            ].join('\n'),
          },
        },
      ],
    });
    const viewerPaths = api.root.addResource('edge-signal-sqs');
    viewerPaths.addResource('{proxy+}').addMethod('ANY', echo, { methodResponses: [{ statusCode: '200' }] });

    // GET /patterns/edge-signal-sqs/boom -> 503 on demand. Proves the documented restriction:
    // CloudFront does not run viewer-response functions on origin status >= 400, so the
    // served event cannot fire from a real 5xx and the response carries no x-signal-served.
    const boom = new apigateway.MockIntegration({
      requestTemplates: { 'application/json': '{"statusCode": 503}' },
      integrationResponses: [
        {
          statusCode: '503',
          responseTemplates: { 'application/json': '{"path": "$context.path", "boom": true}' },
        },
      ],
    });
    viewerPaths.addResource('boom').addMethod('GET', boom, { methodResponses: [{ statusCode: '503' }] });

    new cdk.CfnOutput(scope, 'QueueUrl', { value: queue.queueUrl });

    // No origin path: the stage name is already the first path segment (see above).
    return new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', api.url)), {
      originId: 'edge-signal-sqs',
      customHeaders: { 'x-api-key': apiKeySecret.secretValue.unsafeUnwrap() },
    });
  },
};
