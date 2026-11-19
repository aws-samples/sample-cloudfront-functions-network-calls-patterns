// Echo origin for 01-cognito-auth, a Fastify server on a Lambda Web Function.
// Refuses anything without the shared secret header, then echoes the identity headers the
// CloudFront Function injected. It never sees a request the function did not already authenticate.
import Fastify from 'fastify';

export function buildApp(options = {}) {
  const secret = options.secret ?? process.env.ORIGIN_SECRET;
  const app = Fastify({ logger: options.logger ?? false });
  // The echo never reads a body: accept any content type as raw bytes instead of parsing it.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    if (!secret || request.headers['x-origin-verify'] !== secret) {
      return json(reply, 403, { error: 'missing or wrong x-origin-verify header' });
    }
  });

  app.all('/*', async (request, reply) => {
    const identity = Object.fromEntries(Object.entries(request.headers).filter(([k]) => k.startsWith('x-user-')));
    return json(reply, 200, {
      path: request.url.split('?')[0],
      identity,
      note: 'These x-user-* headers were set by the CloudFront Function after Cognito accepted the token.',
    });
  });

  return app;
}

const json = (reply, statusCode, body) =>
  reply.code(statusCode).type('application/json').send(JSON.stringify(body, null, 2));
