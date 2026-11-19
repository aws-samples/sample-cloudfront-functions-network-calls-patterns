// The shared web ACL runs Bot Control once, first, scoped to every pattern that sets botControl.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';
import { loadPatterns } from '../lib/pattern';

const env = { region: 'us-east-1' };

function webAclRules(): Record<string, any>[] {
  const app = new cdk.App();
  const foundation = new FoundationStack(app, 'FoundationStack', loadPatterns(), { env });
  const [acl] = Object.values(Template.fromStack(foundation).findResources('AWS::WAFv2::WebACL')) as { Properties: { Rules: Record<string, any>[] } }[];
  return acl.Properties.Rules;
}

test('one Bot Control rule group, first, scoped to the paths of the patterns that ask for it', () => {
  const rules = webAclRules();
  const botControl = rules.filter((r) => r.Statement.ManagedRuleGroupStatement?.Name === 'AWSManagedRulesBotControlRuleSet');
  assert.equal(botControl.length, 1);
  assert.equal(rules[0], botControl[0]);
  assert.deepEqual(botControl[0].OverrideAction, { Count: {} });
  const paths = botControl[0].Statement.ManagedRuleGroupStatement.ScopeDownStatement.OrStatement.Statements
    .map((s: any) => s.ByteMatchStatement.SearchString);
  assert.deepEqual(paths, ['/patterns/markdown-on-demand/', '/patterns/edge-waiting-room/']);
  assert.deepEqual(rules.map((r) => r.Priority), rules.map((_, i) => i));
});

test('markdown-on-demand: none on every request, then the bot name for an AI bot label', () => {
  const rules = webAclRules();
  const index = (name: string) => rules.findIndex((r) => r.Name === name);
  const header = (name: string) => rules[index(name)].Action.Count.CustomRequestHandling.InsertHeaders[0];
  assert.ok(index('markdown-on-demand-not-an-agent') < index('markdown-on-demand-ai-agent'), 'the label rule must run last to win');
  assert.deepEqual(header('markdown-on-demand-not-an-agent'), { Name: 'ai-agent', Value: 'none' });
  assert.deepEqual(header('markdown-on-demand-ai-agent'), { Name: 'ai-agent', Value: '${awswaf:managed:aws:bot-control:bot:name:}' });
});
