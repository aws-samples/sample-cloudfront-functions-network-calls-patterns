import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { ExtraBehavior, ExtraOrigin, Pattern } from '../../infra/lib/pattern';
import { WebFunctionOrigin } from '../../infra/lib/web-function-origin';

/**
 * 01-cognito-auth: validate a Cognito access token at the edge, no Lambda authorizer.
 *
 * Two origins:
 *  - `cognito-auth-echo` (behavior origin) a Lambda Web Function (IamAuth endpoint + CloudFront OAC)
 *    that echoes the x-user-* headers the function injected. Viewers land here.
 *  - `cognito-auth`      (extra origin, no behavior) the regional Cognito endpoint the
 *    function calls with cf.fetch (GetUser, no SigV4). Viewers never reach it.
 *
 * Demo only: GET /patterns/cognito-auth/token (its own behavior, no function) answers a real
 * access token for demo-user, so the page shows the success path without the CLI.
 */
const TOKEN_PATH = '/patterns/cognito-auth/token';
// Token requests per IP per minute before AWS WAF blocks; the page asks about once an hour.
const TOKEN_RATE_PER_MINUTE = 10;

// Created in origin(), read by extraBehaviors() below.
let tokenRoute: { userPool: cognito.UserPool; client: cognito.UserPoolClient; password: secretsmanager.Secret; originSecret: secretsmanager.Secret } | undefined;

export const pattern: Pattern = {
  id: 'cognito-auth',
  functionCode: path.join(__dirname, 'function.js'),

  origin(scope: Construct): cloudfront.IOrigin {
    // --- Cognito: user pool, public app client, one demo user -------------------------
    const userPool = new cognito.UserPool(scope, 'UserPool', {
      userPoolName: 'network-calls-cognito-auth',
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const client = userPool.addClient('Client', {
      userPoolClientName: 'cli',
      generateSecret: false,
      authFlows: { userPassword: true },
      accessTokenValidity: cdk.Duration.hours(1),
    });

    const password = new secretsmanager.Secret(scope, 'DemoUserPassword', {
      description: 'Password of the cognito-auth demo user',
      // Kept as first deployed: changing the generator settings would replace the secret value.
      generateSecretString: { passwordLength: 24, requireEachIncludedType: true, excludeCharacters: '"\'\\`{}/@ ' },
    });
    const username = 'demo-user';
    const createUser = new cr.AwsCustomResource(scope, 'DemoUser', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminCreateUser',
        parameters: { UserPoolId: userPool.userPoolId, Username: username, MessageAction: 'SUPPRESS' },
        physicalResourceId: cr.PhysicalResourceId.of(`${username}@cognito-auth`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [userPool.userPoolArn] }),
      installLatestAwsSdk: false,
    });
    // The password is read from Secrets Manager at deploy time, inside this Lambda. It cannot be an
    // AwsCustomResource parameter: CloudFormation does not resolve {{resolve:secretsmanager:...}} in
    // custom resource properties, so Cognito would store the reference string itself.
    const setPasswordFn = new lambda.Function(scope, 'SetDemoUserPasswordFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { CognitoIdentityProviderClient, AdminSetUserPasswordCommand } = require('@aws-sdk/client-cognito-identity-provider');
exports.handler = async (event) => {
  const p = event.ResourceProperties;
  if (event.RequestType !== 'Delete') {
    const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: p.SecretArn }));
    await new CognitoIdentityProviderClient({}).send(new AdminSetUserPasswordCommand({
      UserPoolId: p.UserPoolId, Username: p.Username, Password: secret.SecretString, Permanent: true,
    }));
  }
  return { PhysicalResourceId: p.Username + '@cognito-auth/password' };
};
`),
    });
    password.grantRead(setPasswordFn);
    setPasswordFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminSetUserPassword'],
      resources: [userPool.userPoolArn],
    }));
    const setPassword = new cdk.CustomResource(scope, 'SetDemoUserPasswordFromSecret', {
      serviceToken: new cr.Provider(scope, 'SetDemoUserPasswordProvider', { onEventHandler: setPasswordFn }).serviceToken,
      // Only the secret's ARN goes into the template, never its value.
      properties: { UserPoolId: userPool.userPoolId, Username: username, SecretArn: password.secretArn },
    });
    setPassword.node.addDependency(createUser);

    new cdk.CfnOutput(scope, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(scope, 'ClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(scope, 'DemoUserPasswordSecret', { value: password.secretName });

    // --- Echo origin: Lambda Web Function, IamAuth endpoint, CloudFront signs with OAC --------
    // Two locks: only this distribution may invoke the endpoint (OAC + resource policy), and the
    // server also checks a secret header CloudFront adds. Never a public endpoint.
    const originSecret = new secretsmanager.Secret(scope, 'OriginSecret', {
      description: 'Shared secret CloudFront sends to the cognito-auth echo origin',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
    });
    const echoOrigin = new WebFunctionOrigin(scope, 'Echo', {
      codeDir: path.join(__dirname, 'lambda'),
      originId: 'cognito-auth-echo',
      timeout: cdk.Duration.seconds(5),
      environment: { ORIGIN_SECRET: originSecret.secretValue.unsafeUnwrap() },
      customHeaders: { 'x-origin-verify': originSecret.secretValue.unsafeUnwrap() },
    }).origin;

    tokenRoute = { userPool, client, password, originSecret };
    return echoOrigin;
  },

  // Cognito as a CloudFront origin: what cf.fetch('/', { originId: 'cognito-auth' }) hits.
  extraOrigins(): ExtraOrigin[] {
    const cognitoOrigin = new origins.HttpOrigin(`cognito-idp.${cdk.Aws.REGION}.amazonaws.com`, {
      originId: 'cognito-auth',
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    return [{ id: 'cognito-auth', origin: cognitoOrigin }];
  },

  // Demo-only token route: signs demo-user in server-side and hands out the access token.
  extraBehaviors(scope: Construct): ExtraBehavior[] {
    if (!tokenRoute) throw new Error('cognito-auth: origin() must run before extraBehaviors()');
    const { userPool, client, password, originSecret } = tokenRoute;
    const token = new WebFunctionOrigin(scope, 'DemoToken', {
      codeDir: path.join(__dirname, 'token'),
      originId: 'cognito-auth-token',
      // A cold start loads two SDK clients, reads Secrets Manager and calls InitiateAuth; the
      // CloudFront origin read timeout (30 s) is longer.
      timeout: cdk.Duration.seconds(10),
      environment: {
        ORIGIN_SECRET: originSecret.secretValue.unsafeUnwrap(),
        USER_POOL_ID: userPool.userPoolId,
        CLIENT_ID: client.userPoolClientId,
        DEMO_USERNAME: 'demo-user',
        PASSWORD_SECRET_ARN: password.secretArn, // the ARN only; the server reads the value
      },
      customHeaders: { 'x-origin-verify': originSecret.secretValue.unsafeUnwrap() },
    });
    password.grantRead(token.webFunction);
    token.webFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword'],
      resources: [userPool.userPoolArn],
    }));
    const origin = token.origin;
    return [{ path: TOKEN_PATH, id: 'cognito-auth-token', origin }];
  },

  // A per-IP rate limit on the token route only.
  webAclRules(): wafv2.CfnWebACL.RuleProperty[] {
    return [{
      name: 'cognito-auth-token-rate',
      priority: 0,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: TOKEN_RATE_PER_MINUTE,
          evaluationWindowSec: 60,
          aggregateKeyType: 'IP',
          scopeDownStatement: {
            byteMatchStatement: {
              searchString: TOKEN_PATH,
              fieldToMatch: { uriPath: {} },
              positionalConstraint: 'EXACTLY',
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
        },
      },
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'cognito-auth-token-rate', sampledRequestsEnabled: true },
    }];
  },
};
