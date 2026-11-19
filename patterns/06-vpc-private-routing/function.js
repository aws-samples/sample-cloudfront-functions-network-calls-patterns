import cf from 'cloudfront';

// Viewer-request function on /patterns/vpc-private-routing/*.
// 1. KVS kill switch: routing-kill-switch = off forwards unchanged, with no call.
// 2. One call: GET /route?tenant=<x> on the private ALB (a VPC origin).
// 3. Rewrite the URI to /patterns/vpc-private-routing/<backend>/... and set x-backend.
// Any failure forwards unchanged, with x-vpc-private-routing-error.

const ROUTER_ORIGIN_ID = 'vpc-private-routing';
const ROUTE_PATH = '/route?tenant=';
const PATH_PREFIX = '/patterns/vpc-private-routing';
const KILL_SWITCH_KEY = 'routing-kill-switch';
const BACKENDS = ['blue', 'green'];
const DEFAULT_TENANT = 'guest';
const TENANT_HEADER = 'x-tenant';
const BACKEND_HEADER = 'x-backend';
const KVS_ERROR_HEADER = 'x-vpc-private-routing-kvs-error';
const ERROR_HEADER = 'x-vpc-private-routing-error';

function describeError(error) {
  return error.name + ': ' + error.message;
}

// ?tenant=<x> wins, then an x-tenant header, else "guest".
function readTenant(request) {
  const fromQuery = request.querystring.tenant;
  if (fromQuery && fromQuery.value) return fromQuery.value;
  const fromHeader = request.headers[TENANT_HEADER];
  if (fromHeader && fromHeader.value) return fromHeader.value;
  return DEFAULT_TENANT;
}

// A missing key means routing is on. Any other KVS error also leaves routing on, and is reported.
async function routingSwitchedOff(headers) {
  try {
    const killSwitch = await cf.kvs().get(KILL_SWITCH_KEY);
    return killSwitch === 'off';
  } catch (error) {
    if (error.message.indexOf('KeyNotFound') === -1) headers[KVS_ERROR_HEADER] = { value: describeError(error) };
    return false;
  }
}

// The one network call. Resolves to blue or green, or throws.
async function lookupBackend(tenant) {
  const routeResponse = await cf.fetch(ROUTE_PATH + encodeURIComponent(tenant), {
    originId: ROUTER_ORIGIN_ID,
    includeBody: true, // default false; the backend is in the body
  });
  if (!routeResponse.ok) throw new Error('route service returned ' + routeResponse.status);
  const text = await routeResponse.text(); // assign first: no await inside call arguments
  const route = JSON.parse(text);
  if (BACKENDS.indexOf(route.backend) === -1) throw new Error('unknown backend ' + route.backend);
  return route.backend;
}

async function handler(event) {
  const request = event.request;
  const headers = request.headers;
  const tenant = readTenant(request);
  headers[TENANT_HEADER] = { value: tenant };

  if (await routingSwitchedOff(headers)) {
    headers[BACKEND_HEADER] = { value: 'off' };
    return request;
  }

  try {
    const backend = await lookupBackend(tenant);
    request.uri = PATH_PREFIX + '/' + backend + request.uri.slice(PATH_PREFIX.length);
    headers[BACKEND_HEADER] = { value: backend };
  } catch (error) {
    // TypeError, TimeoutError, InternalError, or a bad answer: forward unchanged.
    headers[ERROR_HEADER] = { value: describeError(error) };
  }
  return request;
}
