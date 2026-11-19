// Demo-only token route for 01-cognito-auth, a Fastify server on a Lambda Web Function:
// GET /patterns/cognito-auth/token answers a REAL Cognito access token for demo-user, so the demo
// page and curl can show the success path in one step. The password never leaves AWS: this server
// reads it from Secrets Manager and signs in itself. It has its own cache behavior, so the
// pattern's CloudFront Function never runs on it.
//
// Every caller shares one token, kept in memory until 10 minutes before it expires: about one
// InitiateAuth an hour per warm environment, and a per-IP AWS WAF rate rule in front.
// A token can delete its own user (DeleteUser) or revoke itself (GlobalSignOut), so a missing
// demo-user is created again and a revoked token is replaced.
import Fastify from 'fastify';

const MARGIN_MS = 10 * 60 * 1000;
const CHECK_MS = 60 * 1000;

/**
 * options.env      ORIGIN_SECRET, USER_POOL_ID, CLIENT_ID, DEMO_USERNAME, PASSWORD_SECRET_ARN (default process.env)
 * options.cognito  (commandName, input) => Promise<output>   (default: the Cognito SDK client)
 * options.secrets  (secretId) => Promise<string>             (default: the Secrets Manager SDK client)
 * options.now      () => epoch ms                            (default Date.now)
 */
export function buildApp(options = {}) {
  const env = options.env ?? process.env;
  const cognito = options.cognito ?? liveCognito();
  const secrets = options.secrets ?? liveSecrets();
  const now = options.now ?? (() => Date.now());
  let held = null; // { token, until, checked }

  const signIn = async (password) => cognito('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: env.CLIENT_ID,
    AuthParameters: { USERNAME: env.DEMO_USERNAME, PASSWORD: password },
  });

  const freshToken = async () => {
    const password = await secrets(env.PASSWORD_SECRET_ARN);
    let out;
    try {
      out = await signIn(password);
    } catch (e) {
      if (e.name !== 'UserNotFoundException') throw e;
      await cognito('AdminCreateUser', { UserPoolId: env.USER_POOL_ID, Username: env.DEMO_USERNAME, MessageAction: 'SUPPRESS' });
      await cognito('AdminSetUserPassword', { UserPoolId: env.USER_POOL_ID, Username: env.DEMO_USERNAME, Password: password, Permanent: true });
      out = await signIn(password);
    }
    const r = out.AuthenticationResult;
    return { token: r.AccessToken, until: now() + r.ExpiresIn * 1000, checked: now() };
  };

  const app = Fastify({ logger: options.logger ?? false });
  // The route never reads a body: accept any content type as raw bytes instead of parsing it.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    if (!env.ORIGIN_SECRET || request.headers['x-origin-verify'] !== env.ORIGIN_SECRET) {
      return json(reply, 403, { error: 'missing or wrong x-origin-verify header' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(reply, 405, { error: 'GET only' });
  });

  app.all('/*', async (request, reply) => {
    try {
      if (held && held.until - now() >= MARGIN_MS && now() - held.checked >= CHECK_MS) {
        // Anyone holding the token can revoke it (GlobalSignOut): ask Cognito once a minute.
        held.checked = now();
        await cognito('GetUser', { AccessToken: held.token }).catch((e) => {
          if (e.name === 'NotAuthorizedException' || e.name === 'UserNotFoundException') held = null;
        });
      }
      if (!held || held.until - now() < MARGIN_MS) held = await freshToken();
    } catch (e) {
      request.log.error({ error: e.name, message: e.message }, 'token_unavailable');
      return json(reply, 503, { error: 'token_unavailable' });
    }
    return json(reply, 200, {
      access_token: held.token,
      token_type: 'Bearer',
      expires_in: Math.floor((held.until - now()) / 1000),
      username: env.DEMO_USERNAME,
      note: 'A real Cognito access token for the demo user, shared by every caller. Send it as Authorization: Bearer to /patterns/cognito-auth/whoami.',
    });
  });

  return app;
}

const json = (reply, statusCode, body) => reply
  .code(statusCode)
  .type('application/json')
  .header('cache-control', 'no-store')
  .send(JSON.stringify(body, null, 2));

// The SDK clients load on first use, so tests that inject fakes never import them.
function liveCognito() {
  let sdk;
  return async (name, input) => {
    if (!sdk) {
      const mod = await import('@aws-sdk/client-cognito-identity-provider');
      sdk = { mod, client: new mod.CognitoIdentityProviderClient({}) };
    }
    return sdk.client.send(new sdk.mod[`${name}Command`](input));
  };
}

function liveSecrets() {
  let sdk;
  return async (id) => {
    if (!sdk) {
      const mod = await import('@aws-sdk/client-secrets-manager');
      sdk = { mod, client: new mod.SecretsManagerClient({}) };
    }
    return (await sdk.client.send(new sdk.mod.GetSecretValueCommand({ SecretId: id }))).SecretString;
  };
}
