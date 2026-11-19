import cf from 'cloudfront';
import crypto from 'crypto';

// Viewer-request: a virtual waiting room. Design, cases and the cookie contract: README.

const QUEUE_ORIGIN_ID = 'edge-waiting-room';
const PATH_PREFIX = '/patterns/edge-waiting-room/';
const STATE_KEY = 'queue-state'; // from the admission Lambda: { mode, epoch, serving, step, tick }
const SECRET_KEYS = ['queue-secret-cur', 'queue-secret-prev']; // cur signs, either verifies
const SHARDS = 8; // counter items; the admission Lambda reads the same number
const ADMIT_SECONDS = 120; // wr_a lifetime; renewing it is free while wr_t is below the watermark
const TICKET_SECONDS = 7200;
const STALE_MS = 5 * 60 * 1000; // queue-state older than this: the admission Lambda stopped ticking
const REFRESH_SECONDS = 5;
const TICKET_COOKIE = 'wr_t';
const PASS_COOKIE = 'wr_a';
const COOKIE_ATTRIBUTES = 'Path=' + PATH_PREFIX + '; Secure; HttpOnly; SameSite=Lax';
const JWT_HEADER = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'; // {"alg":"HS256","typ":"JWT"}, the only header accepted
const DOC = '<!doctype html><meta charset="utf-8">';
const VERDICT_HEADER = 'x-wr';
const PLACE_HEADER = 'x-wr-place';

const headerValue = (headers, name) => (headers[name] ? headers[name].value : '');
const sign = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('base64url');
const sha256 = (text, encoding) => crypto.createHash('sha256').update(text).digest(encoding);

function signJwt(claims, secret) {
  const signed = JWT_HEADER + Buffer.from(JSON.stringify(claims)).toString('base64url');
  return signed + '.' + sign(secret, signed);
}

// Constant time: timing never tells how much of a signature matched.
function constantTimeEquals(expected, actual) {
  let difference = expected.length ^ actual.length;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return difference === 0;
}

// The claims of a token this queue signed, or null.
function verifyJwt(cookie, secrets) {
  const token = cookie ? cookie.value : '';
  const dot = token.lastIndexOf('.');
  if (token.indexOf(JWT_HEADER) !== 0 || dot <= JWT_HEADER.length) return null;
  let valid = false;
  for (let i = 0; i < secrets.length; i++) {
    if (constantTimeEquals(sign(secrets[i], token.slice(0, dot)), token.slice(dot + 1))) valid = true;
  }
  try {
    return valid ? JSON.parse(Buffer.from(token.slice(JWT_HEADER.length, dot), 'base64url').toString()) : null;
  } catch (error) {
    return null;
  }
}

// no-store: any answer may carry a ticket or a pass.
function respond(statusCode, verdict, extraHeaders, body) {
  const headers = { 'cache-control': { value: 'no-store' }, [VERDICT_HEADER]: { value: verdict },
    'content-type': { value: 'text/html; charset=utf-8' } };
  const response = { statusCode: statusCode, headers: Object.assign(headers, extraHeaders) };
  if (body) response.body = body;
  return response;
}

function withCookie(response, name, value, maxAge) {
  response.cookies = response.cookies || {};
  response.cookies[name] = { value: value, attributes: COOKIE_ATTRIBUTES + '; Max-Age=' + maxAge };
  return response;
}

function waitingPage(verdict, title, line) {
  const html = DOC + '<meta http-equiv="refresh" content="' + REFRESH_SECONDS + '">' +
    '<title>' + title + '</title><body style="font:18px system-ui;max-width:34em;margin:4em auto">' +
    '<h1>' + title + '</h1><p>' + line + '</p>' +
    '<p><a href="leave">Leave the line</a></p>';
  return respond(200, verdict, { 'retry-after': { value: String(REFRESH_SECONDS) } }, html);
}

// Clears the HttpOnly cookies and aws-waf-token (both Domain forms), so the CAPTCHA comes back.
function leftPage(host, place) {
  const page = respond(200, 'left', { [PLACE_HEADER]: { value: place } },
    DOC + '<title>You left the line</title><p>You left the line. <a href="shop">Join again</a></p>');
  withCookie(withCookie(page, TICKET_COOKIE, '', 0), PASS_COOKIE, '', 0);
  const expired = (domain) => ({ value: '', attributes: 'Path=/; Secure; ' + domain + 'Max-Age=0' });
  const wafToken = [expired(''), expired('Domain=' + host + '; ')];
  page.cookies['aws-waf-token'] = Object.assign(expired(''), { multiValue: wafToken });
  return page;
}

// KVS reads, not network calls; a missing key leaves state null or a secret out.
async function readQueue() {
  const store = cf.kvs();
  const reads = await Promise.allSettled([
    store.get(STATE_KEY, { format: 'json' }), store.get(SECRET_KEYS[0]), store.get(SECRET_KEYS[1]),
  ]);
  return {
    state: reads[0].status === 'fulfilled' ? reads[0].value : null,
    secrets: reads.slice(1).filter((read) => read.status === 'fulfilled' && read.value).map((read) => read.value),
  };
}

// One cf.beacon puts the ticket in a skip set (a set: a replayed cookie frees one place).
function leaveLine(state, ticket, host) {
  if (ticket < 0 || ticket < state.serving) return leftPage(host, 'none');
  try {
    cf.beacon('/patterns/leave', {
      originId: QUEUE_ORIGIN_ID,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ epoch: state.epoch, ticket: ticket }),
      logDeliveryErrors: true, // late failures go to CloudWatch Logs
    });
    return leftPage(host, 'freed');
  } catch (error) {
    return leftPage(host, 'failed'); // only an invalid call throws
  }
}

// wr_a binds to a hash of WAF token id, user agent and JA4: a copied pass fails.
function clientBinding(headers) {
  const client = [headerValue(headers, 'x-amzn-waf-wr-token-id'), headerValue(headers, 'user-agent'),
    headerValue(headers, 'cloudfront-viewer-ja4-fingerprint')].join('|');
  return sha256(client, 'base64url').slice(0, 22);
}

function positionPage(ticket, state, now) {
  if (now * 1000 - state.tick > STALE_MS) return waitingPage('paused', 'The queue is paused', 'You keep your place in line.');
  const ahead = ticket - state.serving + 1;
  const minutes = Math.ceil(ahead / Math.max(state.step, 1));
  return waitingPage('waiting', 'You are in line', 'Position about <b>' + ahead + '</b>, roughly ' + minutes + ' min.');
}

// The one network call: the shard's counter hands out its next number, or throws.
async function drawTicket(epoch, shard) {
  const enqueueResponse = await cf.fetch('/patterns/enqueue', {
    originId: QUEUE_ORIGIN_ID,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ epoch: epoch, shard: shard }),
    includeBody: true,
  });
  if (!enqueueResponse.ok) throw new Error('enqueue answered ' + enqueueResponse.status); // 429: API Gateway throttled
  const text = await enqueueResponse.text();
  const ticket = (JSON.parse(text).n - 1) * SHARDS + shard;
  if (!(ticket >= 0)) throw new Error('enqueue sent no counter');
  return ticket;
}

async function handler(event) {
  const request = event.request;
  const headers = request.headers;
  const now = Math.floor(Date.now() / 1000); // JWT times are in seconds
  delete headers[VERDICT_HEADER]; // only this function tells the origin what happened

  const queue = await readQueue();
  const state = queue.state;
  const secrets = queue.secrets;
  // The epoch makes a counter reset safe.
  const claims = state ? verifyJwt(request.cookies[TICKET_COOKIE], secrets) : null;
  const ticket = claims && claims.epoch === state.epoch && typeof claims.ticket === 'number' ? claims.ticket : -1;

  if (request.uri === PATH_PREFIX + 'leave') return leaveLine(state, ticket, headerValue(headers, 'host'));
  if (state && state.mode === 'off') {
    headers[VERDICT_HEADER] = { value: 'off' };
    return request;
  }
  if (!state || !secrets.length) return waitingPage('starting', 'The queue is starting', 'Please wait a moment.');

  const binding = clientBinding(headers);
  const pass = verifyJwt(request.cookies[PASS_COOKIE], secrets);
  if (pass && pass.epoch === state.epoch && pass.exp > now && pass.bnd === binding) {
    headers[VERDICT_HEADER] = { value: 'admitted' };
    return request;
  }

  // In line. Tickets below the watermark are admitted.
  if (ticket >= 0) {
    if (ticket >= state.serving) return positionPage(ticket, state, now);
    const admitted = respond(302, 'admit', { location: { value: request.uri } });
    const newPass = signJwt({ epoch: state.epoch, exp: now + ADMIT_SECONDS, bnd: binding }, secrets[0]);
    return withCookie(admitted, PASS_COOKIE, newPass, ADMIT_SECONDS);
  }

  // No ticket. Only a browser page load may draw one.
  if (request.method !== 'GET' || headerValue(headers, 'accept').indexOf('text/html') === -1) {
    return respond(503, 'browsers-only',
      { 'content-type': { value: 'application/json' }, 'retry-after': { value: String(REFRESH_SECONDS) } },
      '{"waitingRoom":"open this URL in a browser"}');
  }

  // A hash of the request id, not Math.random(): no network call may follow random values.
  const shard = parseInt(sha256(event.context.requestId, 'hex').slice(0, 8), 16) % SHARDS;
  let drawn;
  try {
    drawn = await drawTicket(state.epoch, shard);
  } catch (error) {
    // Fail closed: no ticket, the page retries.
    return waitingPage('busy', 'Busy, retrying', 'The line is very long right now (' + error.name + ').');
  }
  const queued = waitingPage('queued', 'You are in line', 'Your ticket is <b>' + drawn + '</b>. Finding your position...');
  return withCookie(queued, TICKET_COOKIE, signJwt({ epoch: state.epoch, ticket: drawn, iat: now }, secrets[0]), TICKET_SECONDS);
}
