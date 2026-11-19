// node --test patterns/07-kvs-config-plus-fetch/test
// Synthesizes this pattern's origin (bundling skipped) and checks the security and promotion wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { require as tsxRequire } from 'tsx/cjs/api';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Template } from 'aws-cdk-lib/assertions';

const { pattern } = tsxRequire('../pattern.ts', import.meta.url);

const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
const stack = new cdk.Stack(app, 'Test');
const keyValueStore = new cloudfront.KeyValueStore(stack, 'Kvs');
pattern.origin(stack, { keyValueStore });
const t = Template.fromStack(stack);

test('the origin is a Web Function: IamAuth endpoint behind a lambda OAC that always signs, no function URL', () => {
  assert.equal(Object.keys(t.findResources('AWS::Lambda::Url')).length, 0);
  const endpoints = Object.values(t.findResources('AWS::Lambda::WebFunctionEndpoint'));
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].Properties.AuthType, 'IamAuth');
  const [oac] = Object.values(t.findResources('AWS::CloudFront::OriginAccessControl'));
  assert.equal(oac.Properties.OriginAccessControlConfig.OriginAccessControlOriginType, 'lambda');
  assert.equal(oac.Properties.OriginAccessControlConfig.SigningBehavior, 'always-amz-auth');
});

test('the origin may count reads in the table', () => {
  const [role] = Object.keys(t.findResources('AWS::IAM::Role')).filter((id) => id.startsWith('ConfigOrigin'));
  const statements = Object.values(t.findResources('AWS::IAM::Policy'))
    .filter((p) => p.Properties.Roles.some((r) => r.Ref === role))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
  assert.ok(statements.some((s) => [].concat(s.Action).includes('dynamodb:UpdateItem')));
});

test('the promoter only wakes for a counter at the threshold or a marker change', () => {
  const [esm] = Object.values(t.findResources('AWS::Lambda::EventSourceMapping'));
  const patterns = esm.Properties.FilterCriteria.Filters.map((f) => JSON.parse(f.Pattern));
  assert.deepEqual(patterns, [
    { dynamodb: { NewImage: { hits: { N: ['5'] } } } },
    { dynamodb: { Keys: { pk: { S: [{ prefix: 'kvs#' }] } } } },
  ]);
  assert.equal(esm.Properties.BatchSize, 50);
});

test('only the promoter may write the KVS, and only UpdateKeys plus Describe', () => {
  const statements = Object.values(t.findResources('AWS::IAM::Policy'))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .filter((s) => [].concat(s.Action).some((a) => a.startsWith('cloudfront-keyvaluestore:')));
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].Action, ['cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:UpdateKeys']);
});

test('the table expires counters and markers by TTL and streams both images', () => {
  const [table] = Object.values(t.findResources('AWS::DynamoDB::GlobalTable'));
  assert.equal(table.Properties.TimeToLiveSpecification.AttributeName, 'ttl');
  assert.equal(table.Properties.StreamSpecification.StreamViewType, 'NEW_AND_OLD_IMAGES');
});
