// Origin for 00-hello-fetch, a Fastify server on a Lambda Web Function.
// Every route refuses a request without the shared secret header CloudFront adds.
//   GET /hello  -> { message: "hello from the origin" }   (the function's cf.fetch call)
//   anything    -> echoes the x-hello-* headers the function added to the viewer request
import Fastify from 'fastify';

export function buildApp(options = {}) {
  const secret = options.secret ?? process.env.ORIGIN_SECRET;
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook('onRequest', async (request, reply) => {
    if (!secret || request.headers['x-origin-verify'] !== secret) {
      return reply.code(403).send({ error: 'missing or wrong x-origin-verify header' });
    }
  });

  app.get('/hello', async () => ({ message: 'hello from the origin', at: new Date().toISOString() }));

  app.all('/*', async (request) => {
    const headersFromFunction = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (name.startsWith('x-hello-')) headersFromFunction[name] = value;
    }
    headersFromFunction['x-origin-verify'] = '<present>';
    return { path: request.url.split('?')[0], headersFromFunction };
  });

  return app;
}
