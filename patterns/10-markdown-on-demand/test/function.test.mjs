// node --test patterns/10-markdown-on-demand/test
// Runs function.js under node with a fake `cloudfront` module (kvs + beacon spies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'function.js'), 'utf8')
  .replace(/^import cf from 'cloudfront';\s*/m, '');
const load = (cf) => new Function('cf', `${src}\nreturn handler;`)(cf);

const PAGE = '/patterns/markdown-on-demand/guide.html';
const MD = '/patterns/markdown-on-demand/guide.md';
const hv = (out, name) => out.headers[name] && out.headers[name].value;
const event = (uri = PAGE, headers = { accept: { value: 'text/markdown, text/html;q=0.9' } }) =>
  ({ request: { method: 'GET', uri, headers: { ...headers } } });
const named = (name, message) => Object.assign(new Error(message), { name });

// keys: what the KVS holds. beacon: what cf.beacon does (default: returns undefined).
function stub({ keys = {}, beacon = () => undefined, kvs = true } = {}) {
  const calls = { get: [], beacon: [], fetch: 0 };
  const cf = {
    fetch: async () => { calls.fetch++; throw new Error('cf.fetch must not be called'); },
    beacon: (path, opts) => { calls.beacon.push({ path, opts }); return beacon(path, opts); },
  };
  if (kvs) cf.kvs = () => ({
    get: async (key) => {
      calls.get.push(key);
      if (key in keys) return keys[key];
      throw named('Error', 'KeyNotFound');
    },
  });
  return { cf, calls };
}

test('agent, no markdown yet: HTML URI kept, one beacon with { uri } only, x-markdown: queued', async () => {
  const { cf, calls } = stub();
  const out = await load(cf)(event());
  assert.equal(out.uri, PAGE);
  assert.equal(hv(out, 'x-markdown'), 'queued');
  assert.deepEqual(calls.get, ['md:' + PAGE]);
  assert.equal(calls.fetch, 0);
  assert.equal(calls.beacon.length, 1);
  const { path, opts } = calls.beacon[0];
  assert.equal(path, '/patterns/convert');
  assert.deepEqual(opts, {
    originId: 'markdown-on-demand-queue',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri: PAGE, minute: JSON.parse(opts.body).minute }),
    logDeliveryErrors: true,
  }, 'no includeBody (throws on a beacon), no timeout, nothing random in the body');
});

test('the convert body is the URI and the minute: a burst is one queue message', async () => {
  const minute = Math.floor(Date.now() / 60000);
  const { cf, calls } = stub();
  await load(cf)(event());
  await load(cf)(event());
  const [a, b] = calls.beacon.map((c) => JSON.parse(c.opts.body));
  assert.ok(a.minute === minute || a.minute === minute + 1);
  if (a.minute === b.minute) assert.equal(calls.beacon[0].opts.body, calls.beacon[1].opts.body);
});

const reset = (qs, headers = {}) =>
  ({ request: { method: 'GET', uri: '/patterns/markdown-on-demand/reset', querystring: qs, headers } });

test('reset: one beacon { action: reset, uri, at } to the same queue, a JSON answer, no-store, no KVS read', async () => {
  const { cf, calls } = stub({ keys: { ['md:' + PAGE]: MD } });
  const out = await load(cf)(reset({ page: { value: 'guide.html' } }));
  assert.equal(out.statusCode, 200);
  assert.equal(hv(out, 'x-markdown'), 'reset');
  assert.equal(hv(out, 'cache-control'), 'no-store');
  assert.equal(hv(out, 'content-type'), 'application/json');
  assert.equal(JSON.parse(out.body).uri, PAGE);
  assert.equal(calls.get.length, 0);
  assert.equal(calls.beacon.length, 1);
  const { path, opts } = calls.beacon[0];
  assert.equal(path, '/patterns/convert');
  assert.equal(opts.originId, 'markdown-on-demand-queue');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.logDeliveryErrors, true);
  const body = JSON.parse(opts.body);
  assert.equal(body.action, 'reset');
  assert.equal(body.uri, PAGE);
  assert.equal(typeof body.at, 'number', 'a timestamp: the FIFO queue never drops a reset as a repeat');
});

test('reset works for a browser too, and for a folder page', async () => {
  const { cf, calls } = stub();
  const out = await load(cf)(reset({ page: { value: 'index.html' } }, { accept: { value: 'text/html' } }));
  assert.equal(hv(out, 'x-markdown'), 'reset');
  assert.equal(JSON.parse(calls.beacon[0].opts.body).uri, '/patterns/markdown-on-demand/index.html');
});

test('reset of anything but a page under the path: 400, no beacon', async () => {
  for (const qs of [{}, { page: { value: '' } }, { page: { value: 'guide.md' } }, { page: { value: '../x.html' } },
    { page: { value: 'a.b.html' } }, { page: { value: 'reset' } }, { page: { value: 'x'.repeat(201) + '.html' } }]) {
    const { cf, calls } = stub();
    const out = await load(cf)(reset(qs));
    assert.equal(out.statusCode, 400, JSON.stringify(qs));
    assert.equal(hv(out, 'x-markdown'), 'invalid');
    assert.equal(calls.beacon.length + calls.get.length, 0);
  }
});

test('reset: cf.beacon throws -> 500 failed with the error by name', async () => {
  const err = new TypeError('bad option');
  const out = await load(stub({ beacon: () => { throw err; } }).cf)(reset({ page: { value: 'guide.html' } }));
  assert.equal(out.statusCode, 500);
  assert.equal(hv(out, 'x-markdown'), 'failed');
  assert.equal(JSON.parse(out.body).error, 'TypeError: bad option');
});

test('agent, KVS has md:<uri>: URI rewritten to the .md object, no network call', async () => {
  const { cf, calls } = stub({ keys: { ['md:' + PAGE]: MD } });
  const out = await load(cf)(event());
  assert.equal(out.uri, MD);
  assert.equal(hv(out, 'x-markdown'), 'served');
  assert.equal(calls.beacon.length, 0);
  assert.equal(calls.fetch, 0);
});

test('a human browser: HTML, no KVS read, no beacon', async () => {
  const { cf, calls } = stub({ keys: { ['md:' + PAGE]: MD } });
  const browser = { accept: { value: 'text/html,application/xhtml+xml,*/*;q=0.8' }, 'user-agent': { value: 'Mozilla/5.0 Safari/605.1.15' } };
  const out = await load(cf)(event(PAGE, browser));
  assert.equal(out.uri, PAGE);
  assert.equal(hv(out, 'x-markdown'), 'skipped');
  assert.equal(calls.get.length + calls.beacon.length + calls.fetch, 0);
  const none = await load(cf)(event(PAGE, {}));
  assert.equal(hv(none, 'x-markdown'), 'skipped');
});

test('a WAF-labelled AI bot (x-amzn-waf-ai-agent) counts as an agent without Accept: text/markdown', async () => {
  for (const name of ['gptbot', 'claudebot', 'perplexitybot']) {
    const { cf, calls } = stub();
    const out = await load(cf)(event(PAGE, { 'x-amzn-waf-ai-agent': { value: name } }));
    assert.equal(hv(out, 'x-markdown'), 'queued', name);
    assert.equal(calls.beacon.length, 1);
  }
});

test('the user agent alone decides nothing: no WAF label (none), or no header, is not an agent', async () => {
  for (const headers of [
    { 'user-agent': { value: 'Mozilla/5.0 (compatible; GPTBot/1.2)' }, 'x-amzn-waf-ai-agent': { value: 'none' } },
    { 'user-agent': { value: 'ClaudeBot/1.0' } },
  ]) {
    const { cf, calls } = stub();
    const out = await load(cf)(event(PAGE, headers));
    assert.equal(hv(out, 'x-markdown'), 'skipped');
    assert.equal(calls.get.length + calls.beacon.length, 0);
  }
});

test('a folder means its index.html, for agents and browsers alike', async () => {
  const { cf, calls } = stub();
  const out = await load(cf)(event('/patterns/markdown-on-demand/'));
  assert.equal(out.uri, '/patterns/markdown-on-demand/index.html');
  assert.equal(JSON.parse(calls.beacon[0].opts.body).uri, '/patterns/markdown-on-demand/index.html');
  const human = await load(stub().cf)(event('/patterns/markdown-on-demand/', {}));
  assert.equal(human.uri, '/patterns/markdown-on-demand/index.html');
});

test('not a page (the .md itself, assets, dots, outside the path, too long): skipped, no call', async () => {
  for (const uri of [
    MD,
    '/patterns/markdown-on-demand/style.css',
    '/patterns/markdown-on-demand/../secret.html',
    '/patterns/markdown-on-demand/a.b.html',
    '/patterns/other/guide.html',
    '/patterns/markdown-on-demand/' + 'x'.repeat(201) + '.html',
  ]) {
    const { cf, calls } = stub();
    const out = await load(cf)(event(uri));
    assert.equal(hv(out, 'x-markdown'), 'skipped', uri);
    assert.equal(out.uri, uri);
    assert.equal(calls.get.length + calls.beacon.length, 0, uri);
  }
});

test('no KVS associated: a miss, still beacons', async () => {
  const { cf, calls } = stub({ kvs: false });
  const out = await load(cf)(event());
  assert.equal(hv(out, 'x-markdown'), 'queued');
  assert.equal(calls.beacon.length, 1);
});

test('cf.beacon throws (a bad option, a second call): HTML still served, x-markdown: failed + error by name', async () => {
  const err = new TypeError('"cloudfront.beacon" only one network call per invocation');
  const out = await load(stub({ beacon: () => { throw err; } }).cf)(event());
  assert.equal(out.uri, PAGE);
  assert.equal(hv(out, 'x-markdown'), 'failed');
  assert.equal(hv(out, 'x-markdown-error'), 'TypeError: "cloudfront.beacon" only one network call per invocation');
});

test('viewer-supplied x-markdown headers are dropped', async () => {
  const out = await load(stub().cf)(event(PAGE, { 'x-markdown': { value: 'served' }, 'x-markdown-error': { value: 'x' } }));
  assert.equal(hv(out, 'x-markdown'), 'skipped');
  assert.equal(out.headers['x-markdown-error'], undefined);
});
