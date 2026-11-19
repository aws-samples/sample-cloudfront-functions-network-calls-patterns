// node --test patterns/08-origin-health-fallback/test/origin.test.mjs
// The primary/secondary Fastify origin, exercised with app.inject (no network). ROLE picks the role.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../lambda/app.mjs';

const PREFIX = '/patterns/origin-health-fallback';
const primary = buildApp({ secret: 's3cret', role: 'primary', slowMs: 20 });
const secondary = buildApp({ secret: 's3cret', role: 'secondary' });
const ok = { 'x-origin-verify': 's3cret' };
const post = (app, url, payload, contentType = 'application/json') =>
  app.inject({ method: 'POST', url: PREFIX + url, headers: { ...ok, 'content-type': contentType }, payload });

test('no secret header or a wrong one: 403 on every route, without the internal marker', async () => {
  for (const headers of [{}, { 'x-origin-verify': 'nope' }]) {
    const res = await primary.inject({ method: 'POST', url: `${PREFIX}/infer`, headers, payload: '{}' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['x-origin'], undefined, 'no viewer-response function runs on a 4xx to strip it');
    assert.equal((await primary.inject({ url: `${PREFIX}/health`, headers })).statusCode, 403);
  }
});

test('an app with no secret configured refuses everything', async () => {
  const open = buildApp({ secret: '' });
  assert.equal((await open.inject({ url: `${PREFIX}/health`, headers: { 'x-origin-verify': '' } })).statusCode, 403);
});

test('POST echoes the JSON body, marked x-origin: lambda on the primary', async () => {
  const res = await post(primary, '/infer', '{"prompt":"hi"}');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-origin'], 'lambda');
  assert.equal(res.headers['cache-control'], 'no-store');
  const data = res.json();
  assert.deepEqual(data.received, { prompt: 'hi' });
  assert.equal(data.servedBy, 'primary');
  assert.equal(data.method, 'POST');
  assert.equal(data.path, '/infer');
});

test('POST with a non-JSON body (or invalid JSON) is echoed as text', async () => {
  assert.equal((await post(secondary, '/infer', 'plain text', 'text/plain')).json().received, 'plain text');
  const bad = await post(secondary, '/infer', '{not json');
  assert.equal(bad.statusCode, 200);
  assert.equal(bad.json().received, '{not json');
});

test('the probe verdict headers are echoed in the POST answer', async () => {
  const res = await secondary.inject({
    method: 'POST', url: `${PREFIX}/infer`, payload: '{}',
    headers: { ...ok, 'content-type': 'application/json', 'x-health-probe': 'unhealthy:timeout', 'x-health-probe-error': 'TimeoutError' },
  });
  assert.equal(res.json().probe, 'unhealthy:timeout (TimeoutError)');
});

test('primary honours ?simulate=down, the secondary ignores it', async () => {
  const down = await post(primary, '/infer?simulate=down', '{}');
  assert.equal(down.statusCode, 503);
  assert.equal(down.headers['x-origin'], undefined, 'no marker on a 5xx either');
  assert.equal(down.body, 'primary: simulated outage\n');
  const standby = await post(secondary, '/infer?simulate=down', '{}');
  assert.equal(standby.statusCode, 200);
  assert.equal(standby.headers['x-origin'], 'lambda-secondary');
  assert.equal(standby.json().servedBy, 'secondary');
});

test('primary ?simulate=slow waits, then answers normally', async () => {
  const res = await primary.inject({ url: `${PREFIX}/health?simulate=slow`, headers: ok });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('GET /health answers 200 JSON, the probe target', async () => {
  const res = await primary.inject({ url: `${PREFIX}/health`, headers: ok });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.deepEqual(res.json(), { ok: true, role: 'primary' });
});

test('GET anything else is an HTML page naming the role; HEAD answers too', async () => {
  const res = await secondary.inject({ url: `${PREFIX}/index.html`, headers: ok });
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /secondary origin/);
  const head = await primary.inject({ method: 'HEAD', url: `${PREFIX}/about.html`, headers: ok });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['x-origin'], 'lambda');
});
