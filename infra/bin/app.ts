#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { loadPatterns } from '../lib/pattern';

const app = new cdk.App();

// CloudFront Functions and KVS are us-east-1 only. Account comes from the CLI profile, never from code.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };

// Every pattern folder by default; a subset with -c patterns=hello-fetch,agent-authz.
const patterns = loadPatterns(app.node.tryGetContext('patterns'));
new FoundationStack(app, 'FoundationStack', patterns, { env });

cdk.Tags.of(app).add('project', 'cloudfront-functions-network-call-patterns');
// Optional extra tags on every resource, from context: -c tags='{"team":"edge"}', or "tags" in cdk.json or ~/.cdk.json.
const extraTags = app.node.tryGetContext('tags') as Record<string, string> | string | undefined;
for (const [key, value] of Object.entries(typeof extraTags === 'string' ? JSON.parse(extraTags) : extraTags ?? {})) {
  cdk.Tags.of(app).add(key, String(value));
}
