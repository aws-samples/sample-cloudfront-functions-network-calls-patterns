// Origin for 02-authorizer-headers, a Fastify server on a Lambda Web Function.
// Every route refuses a request without the shared secret header CloudFront adds.
//   POST /authorize  -> the authorizer: { allow: bool, headers: { x-tenant, x-role } }
//   anything else    -> the echo: shows the identity headers the CloudFront Function injected.
import Fastify from 'fastify';

// The demo policy: three tokens, three identities. Every other token is denied.
const TOKENS = {
  'demo-admin': { 'x-tenant': 'acme', 'x-role': 'admin' },
  'demo-viewer': { 'x-tenant': 'acme', 'x-role': 'viewer' },
  'demo-globex': { 'x-tenant': 'globex', 'x-role': 'admin' },
};

export function buildApp(options = {}) {
  const secret = options.secret ?? process.env.ORIGIN_SECRET;
  const app = Fastify({ logger: options.logger ?? false });

  // Take every body as a string; /authorize parses it so a bad body gets this origin's own 400.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (request, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    if (!secret || request.headers['x-origin-verify'] !== secret) {
      return json(reply, 403, { error: 'missing or wrong x-origin-verify header' });
    }
  });

  app.all('/authorize', async (request, reply) => {
    if (request.method !== 'POST') return json(reply, 405, { error: 'POST only' });
    let ctx;
    try {
      ctx = JSON.parse(request.body ?? '');
    } catch {
      return json(reply, 400, { error: 'body is not JSON' });
    }
    const auth = ctx?.headers?.authorization ?? '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const identity = TOKENS[token];
    if (!identity) return json(reply, 200, { allow: false, headers: {} });
    return json(reply, 200, { allow: true, headers: identity });
  });

  app.all('/*', async (request, reply) => {
    const identity = Object.fromEntries(
      Object.entries(request.headers).filter(([k]) => k === 'x-tenant' || k === 'x-role'));
    return json(reply, 200, {
      path: request.url.split('?')[0],
      identity,
      note: 'These headers were set by the CloudFront Function from the authorizer response. Viewer-supplied values are stripped.',
    });
  });

  return app;
}

function json(reply, statusCode, body) {
  return reply.code(statusCode).type('application/json').send(JSON.stringify(body, null, 2));
}
