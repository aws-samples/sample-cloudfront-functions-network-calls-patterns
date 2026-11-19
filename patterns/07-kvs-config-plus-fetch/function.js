import cf from 'cloudfront';

// Viewer-request function on /patterns/kvs-config-plus-fetch/<key>.
// Read-through config per key (a tenant, an API key, a model route):
//   fresh KVS entry -> use it, no network call
//   miss or expired -> one call: GET /config/<key> on this pattern's origin
//   call fails      -> the expired KVS entry if there is one, else DEFAULT_CONFIG; the request is never blocked
// The origin counts reads per key, and hot keys are written to KVS off the request path,
// so their next reads are KVS hits. The result is forwarded in the x-config-* headers.

const CONFIG_ORIGIN_ID = 'kvs-config-plus-fetch';
const PATH_PREFIX = '/patterns/kvs-config-plus-fetch/';
const CONFIG_PATH = '/config/';
const KVS_KEY_PREFIX = 'cfg-'; // the promoter writes { exp, config } under cfg-<key>
const DEFAULT_KEY = 'default';
const KEY_PATTERN = /^[a-z0-9-]{1,32}$/;
const DEFAULT_CONFIG = { plan: 'free', model: 'small', rateLimit: 10 };
const CONFIG_HEADER = 'x-config';
const KEY_HEADER = 'x-config-key';
const SOURCE_HEADER = 'x-config-source';
const HITS_HEADER = 'x-config-hits';
const ERROR_HEADER = 'x-config-error';
const OWN_HEADERS = [CONFIG_HEADER, KEY_HEADER, SOURCE_HEADER, HITS_HEADER, ERROR_HEADER];

function badKey() {
  return { statusCode: 400, statusDescription: 'Bad Request', body: 'key must be 1-32 characters of a-z, 0-9 and -' };
}

// A missing key, or no KVS associated, throws: that is a miss.
async function readCachedEntry(key) {
  try {
    return await cf.kvs().get(KVS_KEY_PREFIX + key, { format: 'json' });
  } catch (error) {
    return null;
  }
}

// exp is in seconds, as the promoter writes it.
function isFresh(entry) {
  return entry.exp * 1000 > Date.now();
}

// The one network call, which also counts the read. Resolves to { config, hits, threshold }, or throws.
async function fetchConfig(key) {
  const configResponse = await cf.fetch(CONFIG_PATH + key, {
    originId: CONFIG_ORIGIN_ID,
    includeBody: true, // default false; the config is in the body
  });
  if (!configResponse.ok) throw new Error('origin returned ' + configResponse.status);
  const text = await configResponse.text(); // assign first: no await inside call arguments
  const answer = JSON.parse(text);
  if (!answer.config) throw new Error('no config in the origin response');
  return answer;
}

async function handler(event) {
  const request = event.request;
  const headers = request.headers;
  // Only this function may set these for the origin: drop viewer-supplied copies.
  OWN_HEADERS.forEach((name) => delete headers[name]);

  const key = request.uri.slice(PATH_PREFIX.length).split('/')[0] || DEFAULT_KEY;
  if (!KEY_PATTERN.test(key)) return badKey();

  const cached = await readCachedEntry(key);
  let config = DEFAULT_CONFIG;
  let source = 'default';
  if (cached && isFresh(cached)) {
    config = cached.config;
    source = 'kvs';
  } else {
    try {
      const fetched = await fetchConfig(key);
      config = fetched.config;
      source = 'origin';
      if (typeof fetched.hits === 'number') headers[HITS_HEADER] = { value: fetched.hits + '/' + fetched.threshold };
    } catch (error) {
      // TypeError, TimeoutError, InternalError, a bad status or body: fail open, stale beats default.
      headers[ERROR_HEADER] = { value: error.name + ': ' + error.message };
      if (cached) {
        config = cached.config;
        source = 'kvs-stale';
      }
    }
  }

  headers[KEY_HEADER] = { value: key };
  headers[SOURCE_HEADER] = { value: source };
  headers[CONFIG_HEADER] = { value: JSON.stringify(config) };
  return request;
}
