// node --test patterns/10-markdown-on-demand/test
// response-function.js makes no network call: it only copies the verdict onto the response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'response-function.js'), 'utf8');
// Any property read on cf throws: proves the response side never touches the network API.
const cf = new Proxy({}, { get: (_, k) => { throw new Error('cf.' + String(k) + ' touched'); } });
const handler = new Function('cf', `${src}\nreturn handler;`)(cf);

const event = (requestHeaders) => ({
  request: { uri: '/patterns/markdown-on-demand/guide.md', headers: requestHeaders },
  response: { statusCode: 200, headers: { 'content-type': { value: 'text/markdown; charset=utf-8' } } },
});

test('copies x-markdown (and the error, when there is one) and sets Vary', async () => {
  const out = await handler(event({ 'x-markdown': { value: 'served' } }));
  assert.equal(out.headers['x-markdown'].value, 'served');
  assert.equal(out.headers['x-markdown-error'], undefined);
  assert.equal(out.headers.vary.value, 'Accept, User-Agent');
  assert.equal(out.headers['content-type'].value, 'text/markdown; charset=utf-8');
  assert.equal(out.statusCode, 200);
  const failed = await handler(event({ 'x-markdown': { value: 'failed' }, 'x-markdown-error': { value: 'TypeError: x' } }));
  assert.equal(failed.headers['x-markdown-error'].value, 'TypeError: x');
});

test('nothing on the request: nothing copied, Vary still set', async () => {
  const out = await handler(event({}));
  assert.equal(out.headers['x-markdown'], undefined);
  assert.equal(out.headers.vary.value, 'Accept, User-Agent');
});
