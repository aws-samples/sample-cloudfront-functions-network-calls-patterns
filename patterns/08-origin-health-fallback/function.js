import cf from 'cloudfront';

// Viewer-request function on /patterns/origin-health-fallback/*.
// Failover for POST, which origin groups cannot do: they only fail over GET, HEAD and
// OPTIONS, so a POST to a primary that is down simply fails. This function decides
// before the request leaves the edge, with one call: GET /health on the primary.
// "Slow" means the runtime's fixed 1 s TimeoutError (no option, and Date.now() does
// not advance across the await, so a tighter budget cannot be timed here).
//   2xx                                           -> x-route: primary
//   non-2xx, TimeoutError, InternalError, or a
//   TypeError "... due to <result type>" (the edge
//   could not reach the primary: DNS, TLS, connect) -> x-route: fallback
//       POST, PUT, PATCH, DELETE -> the secondary Lambda
//       GET, HEAD                -> the S3 mirror
//   any other TypeError (the call itself is invalid) -> x-route: primary (fail open)
// GET and HEAD on the primary route also get an origin group (primary, then the
// mirror on 5xx). The probe costs a call per request, so it runs only when the KVS
// key health-probe is on.

const PRIMARY_ORIGIN_ID = 'origin-health-fallback';
const MIRROR_ORIGIN_ID = 'origin-health-fallback-static';
const SECONDARY_ORIGIN_ID = 'origin-health-fallback-secondary';
const HEALTH_PATH = '/health';
const PROBE_SWITCH_KEY = 'health-probe';
const FAILOVER_STATUS_CODES = [500, 502, 503, 504];
const ROUTE_HEADER = 'x-route';
const ROUTE_ERROR_HEADER = 'x-route-error';
const PROBE_HEADER = 'x-health-probe';
const PROBE_ERROR_HEADER = 'x-health-probe-error';

function describeError(error) {
  return error.name + ': ' + error.message;
}

// The runtime also uses TypeError when the edge could not reach the origin, naming the
// x-edge-detailed-result-type: "The request could not be completed due to OriginDnsError".
// That says the primary is down, so it fails over; any other TypeError is a bad call.
function originUnreachable(error) {
  return error.name === 'TypeError' && error.message.indexOf('could not be completed due to') !== -1;
}

// Never trust routing headers coming from the viewer.
function stripRoutingHeaders(headers) {
  delete headers[ROUTE_HEADER];
  delete headers[ROUTE_ERROR_HEADER];
  delete headers[PROBE_HEADER];
  delete headers[PROBE_ERROR_HEADER];
}

// ?probe=on|off wins (for the demo), then the KVS key health-probe. Default off.
async function probeEnabled(request) {
  const fromQuery = request.querystring.probe;
  if (fromQuery && (fromQuery.value === 'on' || fromQuery.value === 'off')) return fromQuery.value === 'on';
  try {
    const probeSwitch = await cf.kvs().get(PROBE_SWITCH_KEY);
    return probeSwitch === 'on';
  } catch (error) {
    return false;
  }
}

// /health, plus ?simulate=<x> for the demo: it makes the primary slow or down.
function healthPath(request) {
  const simulate = request.querystring.simulate;
  return simulate ? HEALTH_PATH + '?simulate=' + simulate.value : HEALTH_PATH;
}

// The one network call. Resolves to { route, probe }; never throws.
async function probePrimary(request, headers) {
  try {
    // No body read (includeBody defaults to false): the status is the verdict.
    const healthResponse = await cf.fetch(healthPath(request), { originId: PRIMARY_ORIGIN_ID });
    if (!healthResponse.ok) return { route: 'fallback', probe: 'unhealthy:' + healthResponse.status };
    return { route: 'primary', probe: 'ok' };
  } catch (error) {
    headers[PROBE_ERROR_HEADER] = { value: describeError(error) };
    // A bad call says nothing about the origin: fail open.
    if (error.name === 'TypeError' && !originUnreachable(error)) return { route: 'primary', probe: 'unavailable' };
    return { route: 'fallback', probe: error.name === 'TimeoutError' ? 'unhealthy:timeout' : 'unhealthy:error' };
  }
}

// Fallback: the mirror can replay a GET or HEAD, only the secondary can take a write.
// Primary: a GET or HEAD still fails over to the mirror on 5xx.
function selectOrigins(route, replayable) {
  if (route === 'fallback') {
    cf.selectRequestOriginById(replayable ? MIRROR_ORIGIN_ID : SECONDARY_ORIGIN_ID);
  } else if (replayable) {
    cf.createRequestOriginGroup({
      originIds: [{ originId: PRIMARY_ORIGIN_ID }, { originId: MIRROR_ORIGIN_ID }],
      failoverCriteria: { statusCodes: FAILOVER_STATUS_CODES },
    });
  }
}

async function handler(event) {
  const request = event.request;
  const headers = request.headers;
  stripRoutingHeaders(headers);
  if (request.uri.slice(-1) === '/') request.uri += 'index.html';
  const replayable = request.method === 'GET' || request.method === 'HEAD';

  let health = { route: 'primary', probe: 'off' };
  if (await probeEnabled(request)) health = await probePrimary(request, headers);

  try {
    selectOrigins(health.route, replayable);
  } catch (error) {
    // The request still goes to the primary.
    headers[ROUTE_ERROR_HEADER] = { value: describeError(error) };
  }
  headers[ROUTE_HEADER] = { value: health.route };
  headers[PROBE_HEADER] = { value: health.probe };
  return request;
}
