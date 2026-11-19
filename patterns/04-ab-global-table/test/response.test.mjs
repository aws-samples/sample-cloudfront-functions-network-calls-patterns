// node --test patterns/04-ab-global-table/test
// Runs the viewer-response function under node. It has no `cloudfront` import: nothing to fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'response-function.js'), 'utf8');
const handler = new Function(`${src}\nreturn handler;`)();

const event = (requestHeaders = {}) => ({
  request: { headers: Object.fromEntries(Object.entries(requestHeaders).map(([k, v]) => [k, { value: v }])) },
  response: { statusCode: 200, headers: {}, cookies: {} },
});
const ATTRS = 'Path=/patterns/ab-global-table/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax';

test('first visit: both x-ab-set-* headers -> uid and ab cookies', () => {
  const out = handler(event({ 'x-ab-set-uid': '0123456789abcdef', 'x-ab-set-variant': 'A' }));
  assert.deepEqual(out.cookies.uid, { value: '0123456789abcdef', attributes: ATTRS });
  assert.deepEqual(out.cookies.ab, { value: 'A', attributes: ATTRS });
  assert.equal(out.headers['x-ab-hooks'].value, 'request+response');
});

test('warm visit: only the variant header -> only the ab cookie', () => {
  const out = handler(event({ 'x-ab-set-variant': 'B' }));
  assert.equal(out.cookies.uid, undefined);
  assert.equal(out.cookies.ab.value, 'B');
});

test('no headers (fallback path): no cookies, hooks header still present', () => {
  const out = handler(event({ 'x-ab-variant': 'control' }));
  assert.deepEqual(out.cookies, {});
  assert.equal(out.headers['x-ab-hooks'].value, 'request+response');
});

test('malformed values are ignored, never echoed into a cookie', () => {
  const out = handler(event({ 'x-ab-set-uid': 'not-hex; Domain=evil', 'x-ab-set-variant': 'control' }));
  assert.deepEqual(out.cookies, {});
});

test('does not touch the response body or status, returns the same response object', () => {
  const ev = event({ 'x-ab-set-variant': 'A' });
  ev.response.statusCode = 404;
  const out = handler(ev);
  assert.equal(out, ev.response);
  assert.equal(out.statusCode, 404);
});

test('no network calls: the code (comments aside) never touches cf.fetch, kvs or any import', () => {
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /fetch|kvs|import /);
});
