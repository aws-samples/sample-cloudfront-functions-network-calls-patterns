// node --test patterns/01-cognito-auth/test/token.test.mjs
// The demo token route's Fastify app, exercised with app.inject and a fake Cognito (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../token/app.mjs';

const env = { ORIGIN_SECRET: 's3cret', CLIENT_ID: 'client', USER_POOL_ID: 'pool', DEMO_USERNAME: 'demo-user', PASSWORD_SECRET_ARN: 'secret-arn' };
const ok = { 'x-origin-verify': 's3cret' };
const get = (app, headers = ok, method = 'GET') => app.inject({ method, url: '/patterns/cognito-auth/token', headers });

// A fake Cognito: records calls, signs in with token-<n>, valid one hour.
function fake({ missingUser = false, fail } = {}) {
  const calls = [];
  let n = 0;
  let exists = !missingUser;
  const cognito = async (name, input) => {
    calls.push({ name, input });
    if (fail) throw Object.assign(new Error('boom'), { name: fail });
    if (name === 'AdminCreateUser') exists = true;
    if (name === 'InitiateAuth') {
      if (!exists) throw Object.assign(new Error('User does not exist.'), { name: 'UserNotFoundException' });
      return { AuthenticationResult: { AccessToken: `token-${++n}`, ExpiresIn: 3600 } };
    }
    return {};
  };
  return { calls, cognito, secrets: async (id) => `password-of-${id}` };
}

test('wrong or missing x-origin-verify -> 403, no sign-in', async () => {
  const f = fake();
  const app = buildApp({ env, ...f });
  for (const headers of [{}, { 'x-origin-verify': 'nope' }]) {
    const res = await get(app, headers);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { error: 'missing or wrong x-origin-verify header' });
  }
  assert.equal(f.calls.length, 0);
});

test('no secret configured -> 403 even with an empty header', async () => {
  const app = buildApp({ env: { ...env, ORIGIN_SECRET: '' }, ...fake() });
  assert.equal((await get(app, { 'x-origin-verify': '' })).statusCode, 403);
});

test('POST -> 405, and the secret is checked first', async () => {
  const app = buildApp({ env, ...fake() });
  const res = await get(app, { ...ok, 'content-type': 'application/json' }, 'POST');
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.json(), { error: 'GET only' });
  assert.equal((await get(app, {}, 'POST')).statusCode, 403);
});

test('HEAD is allowed', async () => {
  assert.equal((await get(buildApp({ env, ...fake() }), ok, 'HEAD')).statusCode, 200);
});

test('GET -> a real sign-in with the password from the secret, never echoed', async () => {
  const f = fake();
  const res = await get(buildApp({ env, ...f }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-type'], /^application\/json/);
  const body = res.json();
  assert.equal(body.access_token, 'token-1');
  assert.equal(body.token_type, 'Bearer');
  assert.equal(body.username, 'demo-user');
  assert.equal(body.expires_in, 3600);
  assert.deepEqual(f.calls[0].input, { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: 'client', AuthParameters: { USERNAME: 'demo-user', PASSWORD: 'password-of-secret-arn' } });
  assert.ok(!res.body.includes('password-of'), 'the password is not in the reply');
});

test('the token is shared until 10 minutes before it expires', async () => {
  let t = 0;
  const f = fake();
  const app = buildApp({ env, ...f, now: () => t });
  assert.equal((await get(app)).json().access_token, 'token-1');
  t = 49 * 60 * 1000;
  const later = (await get(app)).json();
  assert.equal(later.access_token, 'token-1');
  assert.equal(later.expires_in, 11 * 60);
  t = 51 * 60 * 1000;
  assert.equal((await get(app)).json().access_token, 'token-2');
  assert.equal(f.calls.filter((c) => c.name === 'InitiateAuth').length, 2);
});

test('a deleted demo-user is created again, then signed in', async () => {
  const f = fake({ missingUser: true });
  const res = await get(buildApp({ env, ...f }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(f.calls.map((c) => c.name), ['InitiateAuth', 'AdminCreateUser', 'AdminSetUserPassword', 'InitiateAuth']);
  assert.equal(f.calls[2].input.Permanent, true);
});

test('Cognito failing -> 503 token_unavailable, no detail leaked', async () => {
  const res = await get(buildApp({ env, ...fake({ fail: 'TooManyRequestsException' }) }));
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json(), { error: 'token_unavailable' });
});

test('a revoked shared token (GlobalSignOut) is replaced at the next minute check', async () => {
  let t = 0;
  const f = fake();
  let revoked = false;
  const cognito = async (name, input) => {
    if (name === 'GetUser' && revoked) throw Object.assign(new Error('Access Token has been revoked'), { name: 'NotAuthorizedException' });
    return f.cognito(name, input);
  };
  const app = buildApp({ env, ...f, cognito, now: () => t });
  assert.equal((await get(app)).json().access_token, 'token-1');
  revoked = true;
  t = 30 * 1000; // not yet a minute: no check
  assert.equal((await get(app)).json().access_token, 'token-1');
  t = 61 * 1000;
  assert.equal((await get(app)).json().access_token, 'token-2');
  assert.equal(f.calls.filter((c) => c.name === 'GetUser').length, 0, 'the fake only saw calls that passed the revoked check');
});
