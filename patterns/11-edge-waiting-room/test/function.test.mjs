// node --test patterns/11-edge-waiting-room/test
// Runs function.js under node with a fake `cloudfront` module (kvs + fetch spies) and node's crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'function.js'), 'utf8')
  .replace(/^import .*$/gm, '');
const load = (cf) => new Function('cf', 'crypto', `${src}\nreturn handler;`)(cf, crypto);

const URI = '/patterns/edge-waiting-room/shop';
const SECRET = 'cur-secret';
const OLD = 'prev-secret';
const NOW = Date.now();
const SEC = Math.floor(NOW / 1000); // JWT times are in seconds
const UA = 'Mozilla/5.0 test';
const JA4 = 't13d1516h2_8daaf6152771_02713d6af862';
const BIND = ['', UA, JA4].join('|');
// A compact JWT, built independently of function.js: base64url(header).base64url(claims).HMAC-SHA256.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const HS256 = b64({ alg: 'HS256', typ: 'JWT' });
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('base64url');
const mint = (claims, secret = SECRET, header = HS256) => `${header}.${b64(claims)}.${hmac(secret, `${header}.${b64(claims)}`)}`;
const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const signedBy = (jwt, secret) => jwt.split('.')[2] === hmac(secret, jwt.split('.').slice(0, 2).join('.'));
const bindHash = (bind = BIND) => crypto.createHash('sha256').update(bind).digest('base64url').slice(0, 22);
const ticketCookie = (epoch, ticket, secret = SECRET) => mint({ epoch, ticket, iat: SEC }, secret);
const admitCookie = (epoch, exp, bind = BIND, secret = SECRET) => mint({ epoch, exp, bnd: bindHash(bind) }, secret);
const hv = (out, name) => out.headers[name] && out.headers[name].value;
const named = (name, message) => Object.assign(new Error(message), { name });

const STATE = { mode: 'on', epoch: 1, serving: 100, step: 50, tick: NOW - 30_000 };

function event({ cookies = {}, method = 'GET', accept = 'text/html,application/xhtml+xml', headers = {} } = {}) {
  const c = {};
  for (const [k, v] of Object.entries(cookies)) c[k] = { value: v };
  return {
    context: { requestId: 'req-abc-123' },
    request: {
      method,
      uri: URI,
      headers: {
        accept: { value: accept },
        'user-agent': { value: UA },
        'cloudfront-viewer-ja4-fingerprint': { value: JA4 },
        ...headers,
      },
      cookies: c,
    },
  };
}

// keys: what the KVS holds (queue-state as an object). fetch: what cf.fetch resolves to.
function stub({ keys = { 'queue-state': STATE, 'queue-secret-cur': SECRET, 'queue-secret-prev': OLD }, fetch, beacon = () => undefined } = {}) {
  const calls = { get: [], fetch: [], beacon: [] };
  const cf = {
    kvs: () => ({
      get: async (key, opts) => {
        calls.get.push(key);
        if (!(key in keys)) throw named('Error', 'KeyNotFound');
        const v = keys[key];
        return opts && opts.format === 'json' ? v : String(v);
      },
    }),
    fetch: async (path, opts) => {
      calls.fetch.push({ path, opts });
      if (!fetch) throw new Error('cf.fetch must not be called');
      return fetch(path, opts);
    },
    beacon: (path, opts) => { calls.beacon.push({ path, opts }); return beacon(path, opts); },
  };
  return { cf, calls };
}
const okCounter = (n) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ n }) });

test('no cookie, browser page load: one cf.fetch to /patterns/enqueue, waiting page + signed wr_t', async () => {
  const { cf, calls } = stub({ fetch: okCounter(42) });
  const out = await load(cf)(event());
  assert.equal(out.statusCode, 200);
  assert.equal(hv(out, 'x-wr'), 'queued');
  assert.equal(hv(out, 'content-type'), 'text/html; charset=utf-8');
  assert.equal(hv(out, 'cache-control'), 'no-store');
  assert.equal(calls.fetch.length, 1);
  const { path, opts } = calls.fetch[0];
  assert.equal(path, '/patterns/enqueue');
  const body = JSON.parse(opts.body);
  assert.deepEqual(Object.keys(opts).sort(), ['body', 'headers', 'includeBody', 'method', 'originId']);
  assert.equal(opts.originId, 'edge-waiting-room');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.includeBody, true);
  assert.deepEqual(opts.headers, { 'content-type': 'application/json' });
  assert.equal(body.epoch, 1);
  assert.ok(Number.isInteger(body.shard) && body.shard >= 0 && body.shard < 8);
  const ticket = (42 - 1) * 8 + body.shard;
  const wrT = out.cookies.wr_t.value;
  assert.ok(wrT.startsWith(HS256 + '.'), 'a compact HS256 JWT');
  assert.ok(signedBy(wrT, SECRET));
  const claims = claimsOf(wrT);
  assert.deepEqual(Object.keys(claims).sort(), ['epoch', 'iat', 'ticket']);
  assert.equal(claims.epoch, 1);
  assert.equal(claims.ticket, ticket);
  assert.ok(Math.abs(claims.iat - SEC) <= 1);
  assert.match(out.cookies.wr_t.attributes, /Secure; HttpOnly; SameSite=Lax/);
  assert.match(out.body, new RegExp(`ticket is <b>${ticket}</b>`));
});

test('the shard is a hash of the request id: the same request draws the same shard', async () => {
  const shards = [];
  for (let i = 0; i < 2; i++) {
    const { cf, calls } = stub({ fetch: okCounter(1) });
    await load(cf)(event());
    shards.push(JSON.parse(calls.fetch[0].opts.body).shard);
  }
  assert.equal(shards[0], shards[1]);
});

test('no cookie, not a browser page load: 503 + Retry-After, no ticket, no call', async () => {
  for (const e of [event({ accept: '*/*' }), event({ method: 'POST' })]) {
    const { cf, calls } = stub();
    const out = await load(cf)(e);
    assert.equal(out.statusCode, 503);
    assert.equal(hv(out, 'x-wr'), 'browsers-only');
    assert.equal(hv(out, 'content-type'), 'application/json', 'the caller overrides the HTML default');
    assert.equal(hv(out, 'retry-after'), '5');
    assert.equal(out.cookies, undefined);
    assert.equal(calls.fetch.length, 0);
  }
});

test('enqueue fails (throttled 429, timeout, bad body): fail closed, waiting page, no ticket', async () => {
  const failures = [
    async () => ({ ok: false, status: 429, text: async () => '{}' }),
    async () => { throw named('TimeoutError', 'took longer than 1 s'); },
    async () => ({ ok: true, status: 200, text: async () => 'not json' }),
    async () => ({ ok: true, status: 200, text: async () => '{}' }),
  ];
  for (const fetch of failures) {
    const { cf } = stub({ fetch });
    const out = await load(cf)(event());
    assert.equal(out.statusCode, 200);
    assert.equal(hv(out, 'x-wr'), 'busy');
    assert.equal(out.cookies, undefined);
    assert.equal(out.method, undefined, 'never forwarded to the origin');
  }
});

test('ticket still above the watermark: waiting page with the position, no call', async () => {
  const { cf, calls } = stub();
  const out = await load(cf)(event({ cookies: { wr_t: ticketCookie(1, 149) } }));
  assert.equal(hv(out, 'x-wr'), 'waiting');
  assert.match(out.body, /Position about <b>50<\/b>, roughly 1 min/);
  assert.equal(calls.fetch.length, 0);
});

test('ticket below the watermark: 302 to the same URL with a bound wr_a, no call', async () => {
  const { cf, calls } = stub();
  const out = await load(cf)(event({ cookies: { wr_t: ticketCookie(1, 99) } }));
  assert.equal(out.statusCode, 302);
  assert.equal(hv(out, 'location'), URI);
  assert.equal(hv(out, 'cache-control'), 'no-store');
  const wrA = out.cookies.wr_a.value;
  assert.ok(signedBy(wrA, SECRET));
  const claims = claimsOf(wrA);
  assert.deepEqual(Object.keys(claims).sort(), ['bnd', 'epoch', 'exp']);
  assert.equal(claims.epoch, 1);
  assert.ok(claims.exp >= SEC + 119 && claims.exp <= SEC + 121, 'exp in seconds, 120 s ahead');
  assert.equal(claims.bnd, bindHash(), 'a hash of token id | UA | JA4, not the values');
  assert.match(out.cookies.wr_a.attributes, /Max-Age=120/);
  assert.equal(calls.fetch.length, 0);
});

test('valid wr_a: forwarded with x-wr: admitted, no call; viewer-supplied x-wr is dropped', async () => {
  const { cf, calls } = stub();
  const out = await load(cf)(event({ cookies: { wr_a: admitCookie(1, SEC + 60) }, headers: { 'x-wr': { value: 'forged' } } }));
  assert.equal(out.uri, URI);
  assert.equal(hv(out, 'x-wr'), 'admitted');
  assert.equal(calls.fetch.length, 0);
});

test('wr_a copied to another client (other UA, JA4 or WAF token id) is not admitted', async () => {
  const cookie = admitCookie(1, SEC + 60);
  const others = [
    { 'user-agent': { value: 'curl/8' } },
    { 'cloudfront-viewer-ja4-fingerprint': { value: 'other' } },
    { 'x-amzn-waf-wr-token-id': { value: 'someone-elses-token' } },
  ];
  for (const headers of others) {
    const { cf, calls } = stub({ fetch: okCounter(1) });
    const out = await load(cf)(event({ cookies: { wr_a: cookie }, headers }));
    assert.notEqual(hv(out, 'x-wr'), 'admitted');
    assert.equal(calls.fetch.length, 1, 'no wr_t either, so it queues like a newcomer');
  }
});

test('wr_a bound to the WAF token id when AWS WAF inserts it', async () => {
  const bind = ['tok-1', UA, JA4].join('|');
  const { cf } = stub();
  const out = await load(cf)(event({ cookies: { wr_a: admitCookie(1, SEC + 60, bind) }, headers: { 'x-amzn-waf-wr-token-id': { value: 'tok-1' } } }));
  assert.equal(hv(out, 'x-wr'), 'admitted');
});

test('expired wr_a with a valid wr_t: re-admitted for free (a new wr_a), no call', async () => {
  const { cf, calls } = stub();
  const out = await load(cf)(event({ cookies: { wr_a: admitCookie(1, SEC - 1), wr_t: ticketCookie(1, 10) } }));
  assert.equal(out.statusCode, 302);
  assert.equal(calls.fetch.length, 0);
});

test('cookies signed with the previous secret still verify; new ones use the current secret', async () => {
  const { cf } = stub();
  const out = await load(cf)(event({ cookies: { wr_t: ticketCookie(1, 99, OLD) } }));
  assert.equal(out.statusCode, 302);
  assert.ok(signedBy(out.cookies.wr_a.value, SECRET));
  assert.ok(!signedBy(out.cookies.wr_a.value, OLD));
});

test('forged, tampered, alg none, other alg, wrong secret, old epoch or old format: queued as a newcomer', async () => {
  const good = ticketCookie(1, 5);
  const [h, p, s] = good.split('.');
  const forged = [
    { wr_t: `${h}.${b64({ epoch: 1, ticket: 4, iat: SEC })}.${s}` }, // tampered payload, original signature
    { wr_t: `${b64({ alg: 'none', typ: 'JWT' })}.${p}.` }, // alg none, no signature
    { wr_t: `${b64({ alg: 'none', typ: 'JWT' })}.${p}.${s}` },
    { wr_t: mint({ epoch: 1, ticket: 5, iat: SEC }, SECRET, b64({ alg: 'HS512', typ: 'JWT' })) }, // another alg
    { wr_t: ticketCookie(1, 5, 'attacker') }, // wrong secret
    { wr_t: `${h}.${p}.${s.slice(0, -1)}` }, // a signature one character short
    { wr_t: ticketCookie(0, 5) }, // epoch 0: the counter was reset since
    { wr_t: mint({ epoch: 1, ticket: '5', iat: SEC }) }, // ticket not a number
    { wr_a: admitCookie(0, SEC + 60) },
    { wr_t: '1.5.' + 'f'.repeat(32) }, // the pre-JWT cookie format: just redraw
    { wr_t: 'garbage' },
  ];
  for (const cookies of forged) {
    const { cf, calls } = stub({ fetch: okCounter(7) });
    const out = await load(cf)(event({ cookies }));
    assert.equal(hv(out, 'x-wr'), 'queued', JSON.stringify(cookies));
    assert.equal(calls.fetch.length, 1);
  }
});

test('queue-state stale (admission Lambda stopped): "paused", place kept, no call', async () => {
  const { cf, calls } = stub({ keys: { 'queue-state': { ...STATE, tick: NOW - 6 * 60_000 }, 'queue-secret-cur': SECRET } });
  const out = await load(cf)(event({ cookies: { wr_t: ticketCookie(1, 500) } }));
  assert.equal(hv(out, 'x-wr'), 'paused');
  assert.equal(calls.fetch.length, 0);
});

const leaveEvent = (cookies = {}) => {
  const e = event({ cookies, headers: { host: { value: 'd123.cloudfront.net' } } });
  e.request.uri = '/patterns/edge-waiting-room/leave';
  return e;
};

test('/leave: expires wr_t, wr_a and aws-waf-token (both forms); an admitted ticket frees nothing', async () => {
  const { cf, calls } = stub();
  const out = await load(cf)(leaveEvent({ wr_t: ticketCookie(1, 5) })); // 5 < serving 100: already admitted
  assert.equal(out.statusCode, 200);
  assert.equal(hv(out, 'x-wr'), 'left');
  assert.equal(hv(out, 'cache-control'), 'no-store');
  assert.equal(hv(out, 'content-type'), 'text/html; charset=utf-8');
  assert.match(out.body, /^<!doctype html><meta charset="utf-8"><title>You left the line/);
  for (const name of ['wr_t', 'wr_a']) {
    assert.equal(out.cookies[name].value, '');
    assert.match(out.cookies[name].attributes, /Path=\/patterns\/edge-waiting-room\/;.*Max-Age=0$/);
  }
  assert.deepEqual(out.cookies['aws-waf-token'].multiValue.map((c) => c.attributes), [
    'Path=/; Secure; Max-Age=0',
    'Path=/; Secure; Domain=d123.cloudfront.net; Max-Age=0',
  ]);
  assert.equal(hv(out, 'x-wr-place'), 'none');
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.beacon.length, 0);
});

test('/leave with a valid ticket still in line: one cf.beacon frees the place, no await', async () => {
  const { cf, calls } = stub();
  const out = await load(cf)(leaveEvent({ wr_t: ticketCookie(1, 150) }));
  assert.equal(hv(out, 'x-wr'), 'left');
  assert.equal(hv(out, 'x-wr-place'), 'freed');
  assert.equal(out.cookies.wr_t.value, '');
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.beacon.length, 1);
  const { path, opts } = calls.beacon[0];
  assert.equal(path, '/patterns/leave');
  assert.deepEqual(Object.keys(opts).sort(), ['body', 'headers', 'logDeliveryErrors', 'method', 'originId']);
  assert.equal(opts.originId, 'edge-waiting-room');
  assert.equal(opts.method, 'POST');
  assert.deepEqual(opts.headers, { 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(opts.body), { epoch: 1, ticket: 150 });
});

test('/leave frees nothing for a forged, foreign-secret or old-epoch ticket, or with no ticket', async () => {
  for (const cookies of [{}, { wr_t: '1.150.' + 'f'.repeat(32) }, { wr_t: ticketCookie(1, 150, 'attacker') }, { wr_t: ticketCookie(0, 150) }]) {
    const { cf, calls } = stub();
    const out = await load(cf)(leaveEvent(cookies));
    assert.equal(hv(out, 'x-wr'), 'left', JSON.stringify(cookies));
    assert.equal(hv(out, 'x-wr-place'), 'none');
    assert.equal(calls.beacon.length, 0);
  }
});

test('/leave when cf.beacon throws or KVS is empty: the cookies are still cleared', async () => {
  const thrown = stub({ beacon: () => { throw named('TypeError', 'only one network call per invocation'); } });
  const a = await load(thrown.cf)(leaveEvent({ wr_t: ticketCookie(1, 150) }));
  assert.equal(hv(a, 'x-wr'), 'left');
  assert.equal(hv(a, 'x-wr-place'), 'failed');
  assert.equal(a.cookies.wr_t.value, '');
  const empty = stub({ keys: {} });
  const b = await load(empty.cf)(leaveEvent({ wr_t: ticketCookie(1, 150) }));
  assert.equal(hv(b, 'x-wr'), 'left');
  assert.equal(hv(b, 'x-wr-place'), 'none');
  assert.equal(empty.calls.beacon.length, 0);
});

test('queue off: forwarded with x-wr: off, no cookie checks, no call', async () => {
  const { cf, calls } = stub({ keys: { 'queue-state': { ...STATE, mode: 'off' } } });
  const out = await load(cf)(event({ accept: '*/*' }));
  assert.equal(out.uri, URI);
  assert.equal(hv(out, 'x-wr'), 'off');
  assert.equal(calls.fetch.length, 0);
});

test('no queue-state or no secret yet: "starting" page, fail closed, no call', async () => {
  for (const keys of [{ 'queue-secret-cur': SECRET }, { 'queue-state': STATE }, {}]) {
    const { cf, calls } = stub({ keys });
    const out = await load(cf)(event());
    assert.equal(hv(out, 'x-wr'), 'starting');
    assert.equal(calls.fetch.length, 0);
  }
});
