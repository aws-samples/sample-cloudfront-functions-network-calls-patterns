// Primary AND secondary origin for 08-origin-health-fallback, a Fastify server on a Lambda
// Web Function. One code package, two Web Functions (ROLE=primary | secondary). The primary
// can be told to misbehave so the demo can show every recovery path; the secondary is the
// healthy standby (in production: another Region) and ignores ?simulate=.
//   ?simulate=down  -> 503 on every path (primary only)
//   ?simulate=slow  -> sleeps 1.5 s (past the 1 s cf.fetch timeout), then answers normally (primary only; the probe times out)
//   GET /health     -> 200 {ok:true}, the cf.fetch GET probe target
//   POST anything   -> 200 JSON echo of the request body: the "inference" call
//   anything else   -> 200 HTML naming the path
// Every answer carries x-origin: lambda (primary) or lambda-secondary.
// Refuses anything without the shared secret header CloudFront adds.
import Fastify from 'fastify';

const PREFIX = '/patterns/origin-health-fallback';
const SLOW_MS = 1500;
const ECHO_MAX = 2000;

export function buildApp(options = {}) {
  const secret = options.secret ?? process.env.ORIGIN_SECRET;
  const role = (options.role ?? process.env.ROLE) === 'secondary' ? 'secondary' : 'primary';
  const marker = role === 'secondary' ? 'lambda-secondary' : 'lambda';
  const slowMs = options.slowMs ?? SLOW_MS;
  const app = Fastify({ logger: options.logger ?? false });

  // Echo any body as the raw text, whatever its content type: the handler decides if it is JSON.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (request, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-origin', marker).header('cache-control', 'no-store');
    if (!secret || request.headers['x-origin-verify'] !== secret) {
      return reply.code(403).type('application/json').send({ error: 'missing or wrong x-origin-verify header' });
    }
  });

  // CloudFront does not run the viewer-response function on a 4xx or 5xx, so nothing would strip the
  // internal marker there: only send it on answers below 400.
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode >= 400) reply.removeHeader('x-origin');
    return payload;
  });

  app.all('/*', async (request, reply) => {
    const rawPath = request.url.split('?')[0];
    const path = rawPath.startsWith(PREFIX) ? rawPath.slice(PREFIX.length) : rawPath;
    const simulate = role === 'primary' ? request.query.simulate : undefined;
    const method = request.method;

    if (simulate === 'slow') await new Promise((r) => setTimeout(r, slowMs));
    if (simulate === 'down') return reply.code(503).type('text/plain').send(`${role}: simulated outage\n`);

    if (path === '/health') return reply.type('application/json').send({ ok: true, role });
    const probeError = request.headers['x-health-probe-error'];
    const probe = `${request.headers['x-health-probe'] ?? 'unknown'}${probeError ? ` (${probeError})` : ''}`;
    if (method !== 'GET' && method !== 'HEAD') {
      const raw = typeof request.body === 'string' ? request.body : '';
      let received = raw.slice(0, ECHO_MAX);
      try { received = JSON.parse(raw); } catch { /* not JSON: echo the text */ }
      const answer = { servedBy: role, method, path, received, probe, at: new Date().toISOString() };
      return reply.type('application/json').send(answer);
    }
    return reply.type('text/html; charset=utf-8').send(page(role, path, new Date().toISOString(), simulate, probe));
  });

  return app;
}

const page = (role, path, at, simulate, probe) => `<!doctype html>
<meta charset="utf-8"><title>${role} origin</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem}</style>
<h1>Served by the ${role} origin (Lambda)</h1>
<p>Path <code>${escapeHtml(path)}</code>, rendered at ${at}${simulate === 'slow' ? ' after a simulated 1.5 s delay' : ''}.</p>
<p>Edge probe verdict on this request: <code>x-health-probe: ${escapeHtml(probe)}</code>.</p>
<p>Response headers carry the same story: <code>x-served-by: ${role}</code>, <code>x-route</code>, <code>x-health-probe</code>.</p>
`;
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
