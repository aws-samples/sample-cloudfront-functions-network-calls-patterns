// Origin for 09-agent-authz, a Fastify server on a Lambda Web Function.
// Every route refuses a request without the shared secret header CloudFront adds.
//   POST /v1/check -> the authorization service: { allowed: bool }
//   anything else  -> the orders backend: a cacheable JSON order. Only allowed requests get here.
import Fastify from 'fastify';

// The demo policy. "demo-agent-token" is a fixed, public demo value, not a secret: it may READ
// order 48291 and nothing else. Real services check a signed, short-lived token instead.
const GRANTS = {
  'demo-agent-token': ['read /patterns/agent-authz/orders/48291'],
};

export function buildApp(options = {}) {
  const secret = options.secret ?? process.env.ORIGIN_SECRET;
  const app = Fastify({ logger: options.logger ?? false });

  // Every body arrives as a string, whatever its content type; /v1/check parses it itself.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (request, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    if (!secret || request.headers['x-origin-verify'] !== secret) {
      return json(reply, 403, { error: 'missing or wrong x-origin-verify header' });
    }
  });

  app.all('/v1/check', async (request, reply) => {
    if (request.method !== 'POST') return json(reply, 405, { error: 'POST only' });
    let req;
    try {
      req = JSON.parse(typeof request.body === 'string' ? request.body : '');
    } catch {
      return json(reply, 400, { error: 'body is not JSON' });
    }
    const auth = typeof req?.token === 'string' ? req.token : '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const grants = GRANTS[token] ?? [];
    return json(reply, 200, { allowed: grants.includes(`${req?.action} ${req?.resource}`) });
  });

  app.all('/*', async (request, reply) => {
    const id = request.url.split('?')[0].split('/').pop();
    // Cacheable: the edge re-checks authorization on every request, before the cache.
    return json(reply, 200, { order: id, status: 'shipped', servedAt: new Date().toISOString() }, 'public, max-age=60');
  });

  return app;
}

function json(reply, statusCode, body, cacheControl = 'no-store') {
  return reply.code(statusCode)
    .header('content-type', 'application/json')
    .header('cache-control', cacheControl)
    // A Buffer, so Fastify sends the content type as set (no added charset).
    .send(Buffer.from(JSON.stringify(body, null, 2)));
}
