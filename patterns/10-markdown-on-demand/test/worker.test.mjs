// node --test patterns/10-markdown-on-demand/test
// The SQS worker's logic (lambda/worker.mjs) with fake S3, KVS and converter: no SDK needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeHandler, PAGE } from '../lambda/worker.mjs';

const URI = '/patterns/markdown-on-demand/guide.html';
const KEY = 'patterns/markdown-on-demand/guide.html';
const MD_KEY = 'patterns/markdown-on-demand/guide.md';

// objects: the bucket. fail: { op: Error } makes that operation throw.
function fakes(objects = { [KEY]: '<h1>Guide</h1>' }, fail = {}, kv = {}) {
  const log = { writes: [], keys: [], converted: 0, deletedKeys: [] };
  const guard = (op) => { if (fail[op]) throw fail[op]; };
  const deps = {
    read: async (key) => { guard('read'); return key in objects ? objects[key] : null; },
    write: async (key, md) => { guard('write'); objects[key] = md; log.writes.push(key); },
    putKey: async (key, value) => { guard('putKey'); kv[key] = value; log.keys.push([key, value]); },
    deleteKey: async (key) => { guard('deleteKey'); delete kv[key]; log.deletedKeys.push(key); },
    listKeys: async (prefix) => Object.keys(kv).filter((k) => k.startsWith(prefix)),
    toMarkdown: (html) => { log.converted++; return 'md of ' + html; },
  };
  return { handler: makeHandler(deps), objects, log, kv };
}
const sqs = (...bodies) => ({ Records: bodies.map((body, i) => ({ messageId: 'm' + i, body })) });
const msg = (uri) => JSON.stringify({ uri });

test('converts the page, writes <page>.md, then md:<uri> -> the .md URI', async () => {
  const { handler, objects, log } = fakes();
  assert.deepEqual(await handler(sqs(msg(URI))), { batchItemFailures: [] });
  assert.equal(objects[MD_KEY], 'md of <h1>Guide</h1>');
  assert.deepEqual(log.writes, [MD_KEY]);
  assert.deepEqual(log.keys, [['md:' + URI, '/patterns/markdown-on-demand/guide.md']]);
});

test('idempotent: a repeat converts again and overwrites the same .md and key', async () => {
  const { handler, objects, log } = fakes();
  await handler(sqs(msg(URI), msg(URI)));
  assert.equal(log.converted, 2);
  assert.deepEqual(log.writes, [MD_KEY, MD_KEY]);
  assert.deepEqual(log.keys[0], log.keys[1]);
  assert.equal(objects[MD_KEY], 'md of <h1>Guide</h1>');
});

test('a page that does not exist, or a bad message: dropped, no write, no key, no retry', async () => {
  const { handler, log } = fakes({});
  const bad = [msg('/patterns/markdown-on-demand/nope.html'), msg('/patterns/markdown-on-demand/../x.html'),
    msg('/elsewhere/a.html'), msg(42), '{"uri":', 'not json', '{}'];
  assert.deepEqual(await handler(sqs(...bad)), { batchItemFailures: [] });
  assert.equal(log.converted + log.writes.length + log.keys.length, 0);
});

test('the worker and function.js accept the same URIs', () => {
  const fn = readFileSync(new URL('../function.js', import.meta.url), 'utf8');
  assert.equal(/const PAGE = (\/.*\/);/.exec(fn)[1], String(PAGE));
  assert.ok(PAGE.test(URI));
  assert.ok(PAGE.test('/patterns/markdown-on-demand/index.html'));
  assert.ok(!PAGE.test('/patterns/markdown-on-demand/guide.md'));
  assert.ok(!PAGE.test('/patterns/markdown-on-demand/' + 'x'.repeat(201) + '.html'));
});

test('a failure (S3 or KVS) retries it and every later record (FIFO order), not the earlier ones', async () => {
  const boom = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
  const { handler } = fakes({ [KEY]: '<p>x</p>' }, { putKey: boom });
  const out = await handler(sqs('not json', msg(URI), msg(URI)));
  assert.deepEqual(out, { batchItemFailures: [{ itemIdentifier: 'm1' }, { itemIdentifier: 'm2' }] });
  const read = fakes(undefined, { read: boom });
  assert.deepEqual(await read.handler(sqs(msg(URI))), { batchItemFailures: [{ itemIdentifier: 'm0' }] });
});

const resetMsg = (uri) => JSON.stringify({ action: 'reset', uri, at: 1 });

test('a convert body may carry the minute: still one conversion', async () => {
  const { handler, objects } = fakes();
  await handler(sqs(JSON.stringify({ uri: URI, minute: 29000000 })));
  assert.equal(objects[MD_KEY], 'md of <h1>Guide</h1>');
});

test('reset: deletes md:<uri> only; the .md stays for edges that still hold the key', async () => {
  const { handler, objects, log, kv } = fakes();
  await handler(sqs(msg(URI)));
  assert.deepEqual(await handler(sqs(resetMsg(URI))), { batchItemFailures: [] });
  assert.deepEqual(log.deletedKeys, ['md:' + URI]);
  assert.ok(!('md:' + URI in kv));
  assert.equal(objects[MD_KEY], 'md of <h1>Guide</h1>', 'an edge with the old key still finds the .md');
  objects[KEY] = '<h1>Guide v2</h1>';
  await handler(sqs(msg(URI)));
  assert.equal(objects[MD_KEY], 'md of <h1>Guide v2</h1>', 'the next convert overwrites it');
  assert.equal(kv['md:' + URI], '/patterns/markdown-on-demand/guide.md');
});

test('reset is idempotent: nothing converted yet, or twice in a row', async () => {
  const { handler, log } = fakes();
  assert.deepEqual(await handler(sqs(resetMsg(URI), resetMsg(URI))), { batchItemFailures: [] });
  assert.equal(log.deletedKeys.length, 2);
  assert.equal(log.writes.length + log.keys.length, 0);
});

test('reset of anything but a page: dropped, nothing deleted', async () => {
  const { handler, log } = fakes();
  await handler(sqs(resetMsg('/elsewhere/a.html'), resetMsg('/patterns/markdown-on-demand/../x.html'), JSON.stringify({ action: 'reset' })));
  assert.equal(log.deletedKeys.length, 0);
});

test('reset: a KVS failure retries the message', async () => {
  const boom = Object.assign(new Error('conflict'), { name: 'ConflictException' });
  const { handler } = fakes({ [KEY]: 'x', [MD_KEY]: 'md' }, { deleteKey: boom });
  assert.deepEqual(await handler(sqs(resetMsg(URI))), { batchItemFailures: [{ itemIdentifier: 'm0' }] });
});

test('the sweep (no Records, the EventBridge event): every md: key for a page, nothing else; the .md files stay', async () => {
  const objects = { [KEY]: 'x', [MD_KEY]: 'md', 'patterns/markdown-on-demand/index.md': 'md', 'patterns/markdown-on-demand/index.html': 'y' };
  const kv = { ['md:' + URI]: '/patterns/markdown-on-demand/guide.md', 'md:/patterns/markdown-on-demand/index.html': 'x', 'md:/elsewhere/a.html': 'x', 'queue-state': '{}' };
  const { handler, log } = fakes(objects, {}, kv);
  assert.deepEqual(await handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' }), { keys: 2 });
  assert.deepEqual(Object.keys(kv).sort(), ['md:/elsewhere/a.html', 'queue-state']);
  assert.equal(Object.keys(objects).length, 4);
  assert.equal(log.deletedKeys.length, 2);
  assert.deepEqual(await handler({}), { keys: 0 }, 'a second sweep finds nothing');
});
