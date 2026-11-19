// node --test patterns/04-ab-global-table/test/origin.test.mjs
// The Fastify origin, exercised with app.inject (no network): a fake DynamoDB client and KVS writer are injected.
// Needs `npm ci` in lambda/ first, so the SDK and Fastify specifiers resolve.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../lambda/app.mjs';

const UID = '0123456789abcdef';
const sent = [];
const kvsWrites = [];
let failCondition = false;
let kvsError = null;
const ddb = {
  async send(cmd) {
    sent.push(cmd);
    if (cmd.constructor.name === 'PutItemCommand' && failCondition) {
      const e = new Error('conditional'); e.name = 'ConditionalCheckFailedException';
      e.Item = { uid: { S: cmd.input.Item.uid.S }, variant: { S: 'Z' } }; throw e;
    }
    return {};
  },
};
const updateKeys = async (plan) => { if (kvsError) throw kvsError; kvsWrites.push(plan); };
const app = buildApp({ secret: 's3cret', tableName: 'Assignments', ddb, updateKeys });
const ok = { 'x-origin-verify': 's3cret' };

test('rejects without the secret header, or with a wrong one, on every route', async () => {
  for (const headers of [{}, { 'x-origin-verify': 'nope' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/assign/' + UID, headers })).statusCode, 403);
    assert.equal((await app.inject({ url: '/patterns/ab-global-table/', headers })).statusCode, 403);
  }
});

test('an app with no secret configured refuses everything', async () => {
  const open = buildApp({ secret: '', ddb, updateKeys });
  assert.equal((await open.inject({ method: 'POST', url: '/assign/' + UID, headers: { 'x-origin-verify': '' } })).statusCode, 403);
});

test('POST /assign/<uid> assigns once, writes KVS, answers { variant }', async () => {
  const res = await app.inject({ method: 'POST', url: '/assign/' + UID, headers: ok });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json();
  assert.ok(['A', 'B'].includes(body.variant));
  assert.equal(body.uid, UID);
  assert.equal(body.created, true);
  assert.equal(body.kvs, undefined, 'the loader no longer writes KVS');
  const put = sent.at(-1).input;
  assert.equal(put.TableName, 'Assignments');
  assert.match(put.ConditionExpression, /attribute_not_exists\(uid\)/);
  assert.equal(kvsWrites.length, 0, 'the stream fills KVS, not the loader');
});

test('second writer gets the existing item back', async () => {
  failCondition = true;
  const res = await app.inject({ method: 'POST', url: '/assign/' + UID, headers: ok });
  failCondition = false;
  const body = res.json();
  assert.equal(body.variant, 'Z');
  assert.equal(body.created, false);
});

test('the POST needs no body hash behind a Web Function OAC', async () => {
  const res = await app.inject({ method: 'POST', url: '/assign/' + UID, headers: ok, payload: '' });
  assert.equal(res.statusCode, 200);
});

test('bad uid is a 400, GET is a plain echo: cookies belong to the viewer-response function', async () => {
  assert.equal((await app.inject({ method: 'POST', url: '/assign/not-hex', headers: ok })).statusCode, 400);
  const res = await app.inject({
    url: '/patterns/ab-global-table/?x=1',
    headers: { ...ok, 'x-ab-uid': UID, 'x-ab-uid-new': '1', 'x-ab-set-uid': UID, 'x-ab-variant': 'A', 'x-other': 'no' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['set-cookie'], undefined);
  const body = res.json();
  assert.equal(body.path, '/patterns/ab-global-table/');
  assert.equal(body.variant, 'A');
  assert.equal(body.headersFromFunction['x-ab-set-uid'], UID);
  assert.equal(body.headersFromFunction['x-origin-verify'], '<present>');
  assert.equal(body.headersFromFunction['x-other'], undefined);
});

test('GET /assign/<uid> is an echo, not an assignment', async () => {
  const before = sent.length;
  const res = await app.inject({ url: '/assign/' + UID, headers: ok });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().variant, null);
  assert.equal(sent.length, before);
});
