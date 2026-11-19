// node --test patterns/03-bot-check-fail-open/test/origin.test.mjs
// The Fastify mock vendor, exercised with app.inject (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, classify } from '../lambda/app.mjs';

const app = buildApp({ secret: 'test-secret' });
const ok = { 'x-origin-verify': 'test-secret' };

const check = (body, headers = {}) => app.inject({
  method: 'POST', url: '/check',
  headers: { ...ok, 'content-type': 'application/json', ...headers },
  payload: typeof body === 'string' ? body : JSON.stringify(body),
});

test('classify: bot-ish user-agent is a bot', () => {
  const r = classify({ userAgent: 'Googlebot/2.1', acceptLanguage: 'en' });
  assert.equal(r.verdict, 'bot');
  assert.equal(r.score, 60);
});

test('classify: browser-like signals are human', () => {
  const r = classify({ userAgent: 'Mozilla/5.0', acceptLanguage: 'en-US' });
  assert.equal(r.verdict, 'human');
  assert.equal(r.score, 0);
});

test('classify: plain curl (no accept-language) stays human but scores 40', () => {
  const r = classify({ userAgent: 'curl/8.0', acceptLanguage: '' });
  assert.equal(r.verdict, 'human');
  assert.equal(r.score, 40);
});

test('classify: empty user-agent + no accept-language is a bot', () => {
  assert.equal(classify({ userAgent: '', acceptLanguage: '' }).verdict, 'bot');
});

test('classify: x-force-verdict wins', () => {
  assert.equal(classify({ userAgent: 'Mozilla/5.0', acceptLanguage: 'en', forceVerdict: 'bot' }).score, 100);
  assert.equal(classify({ userAgent: 'Googlebot', forceVerdict: 'human' }).verdict, 'human');
});

test('no secret or a wrong one: 403 on every route', async () => {
  for (const headers of [{}, { 'x-origin-verify': 'nope' }]) {
    const res = await app.inject({ method: 'POST', url: '/check', headers, payload: '{}' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'missing or wrong x-origin-verify header');
    assert.equal((await app.inject({ url: '/patterns/bot-check-fail-open/echo', headers })).statusCode, 403);
  }
});

test('an app with no secret configured refuses everything', async () => {
  const open = buildApp({ secret: '' });
  assert.equal((await open.inject({ url: '/check', method: 'POST', headers: { 'x-origin-verify': '' } })).statusCode, 403);
});

test('POST /check returns verdict in body and header', async () => {
  const res = await check({ userAgent: 'Mozilla/5.0', acceptLanguage: 'en' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.equal(res.headers['x-bot-verdict'], 'human');
  assert.equal(res.headers['x-bot-score'], '0');
  assert.equal(res.json().verdict, 'human');
});

test('POST /check: an unreadable or empty body is no signals (a bot), never a 400', async () => {
  for (const payload of ['not json', '']) {
    const res = await check(payload);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().verdict, 'bot');
  }
  const noType = await app.inject({ method: 'POST', url: '/check', headers: ok, payload: '{"forceVerdict":"human"}' });
  assert.equal(noType.json().verdict, 'human');
});

test('POST /check honours delayMs (capped)', async () => {
  const started = Date.now();
  await check({ delayMs: 150 });
  assert.ok(Date.now() - started >= 140, 'should have slept ~150 ms');
});

test('POST /check needs no x-amz-content-sha256 (CloudFront signs the Web Function call with an unsigned payload)', async () => {
  const res = await check({ forceVerdict: 'bot' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().score, 100);
});

test('echo route reflects only x-bot-* headers, path without the query', async () => {
  const res = await app.inject({
    method: 'GET', url: '/patterns/bot-check-fail-open/echo?a=1',
    headers: { ...ok, 'x-bot-verdict': 'bot', 'user-agent': 'curl' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { path: '/patterns/bot-check-fail-open/echo', headersFromFunction: { 'x-bot-verdict': 'bot' } });
});

test('GET /check is not the check: it is echoed', async () => {
  const res = await app.inject({ method: 'GET', url: '/check', headers: ok });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().path, '/check');
});
