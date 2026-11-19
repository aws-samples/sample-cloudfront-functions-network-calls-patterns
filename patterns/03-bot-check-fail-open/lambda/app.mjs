// Mock bot-detection vendor for 03-bot-check-fail-open, a Fastify server on a Lambda Web Function.
// Every route refuses a request without the shared secret header CloudFront adds.
//
// POST /check   -> 200 { verdict: "human"|"bot", score, reasons } + header x-bot-verdict.
//                  Body: { userAgent, acceptLanguage, forceVerdict, delayMs, ... } sent by the function.
//                  Sleeps delayMs (max 5000) first; over ~1 s the function's call hits the runtime TimeoutError.
// anything else -> 200 echo of the x-bot-* headers the function added, so the demo can see them.
//
// The rules are deliberately naive; this is a stand-in for a real vendor, not a detector.
import Fastify from 'fastify';

const MAX_DELAY_MS = 5000;
const BOT_THRESHOLD = 50;

export function buildApp(options = {}) {
  const secret = options.secret ?? process.env.ORIGIN_SECRET;
  const app = Fastify({ logger: options.logger ?? false });

  // Read every body as a string and parse it here: a bad or empty body is "no signals", never a 400.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (request, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    if (!secret || request.headers['x-origin-verify'] !== secret) {
      return json(reply, 403, { error: 'missing or wrong x-origin-verify header' });
    }
  });

  app.post('/check', async (request, reply) => {
    const signals = parseBody(request.body);
    const delay = Math.min(Math.max(Number(signals.delayMs) || 0, 0), MAX_DELAY_MS);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const result = classify(signals);
    return json(reply, 200, result, { 'x-bot-verdict': result.verdict, 'x-bot-score': String(result.score) });
  });

  app.all('/*', async (request, reply) => {
    const echoed = Object.fromEntries(
      Object.entries(request.headers).filter(([k]) => k.startsWith('x-bot-')),
    );
    return json(reply, 200, { path: request.url.split('?')[0], headersFromFunction: echoed });
  });

  return app;
}

/** Simple, explainable rules. Returns { verdict, score, reasons }. */
export function classify(signals) {
  const force = String(signals.forceVerdict ?? '').toLowerCase();
  if (force === 'bot') return { verdict: 'bot', score: 100, reasons: ['x-force-verdict: bot'] };
  if (force === 'human') return { verdict: 'human', score: 0, reasons: ['x-force-verdict: human'] };

  const ua = String(signals.userAgent ?? '');
  const reasons = [];
  let score = 0;
  if (ua === '') { score += 60; reasons.push('empty user-agent'); }
  else if (/bot|crawler|spider/i.test(ua)) { score += 60; reasons.push('user-agent contains bot/crawler/spider'); }
  if (!signals.acceptLanguage) { score += 40; reasons.push('missing accept-language'); }

  return { verdict: score >= BOT_THRESHOLD ? 'bot' : 'human', score, reasons };
}

function parseBody(raw) {
  try {
    const parsed = JSON.parse(typeof raw === 'string' && raw ? raw : '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function json(reply, statusCode, body, extraHeaders = {}) {
  return reply.code(statusCode).headers({ 'content-type': 'application/json', ...extraHeaders })
    .send(JSON.stringify(body, null, 2));
}
