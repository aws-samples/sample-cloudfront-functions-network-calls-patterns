import cf from 'cloudfront';

// Viewer-request function on /patterns/authorizer-headers/*.
// The API Gateway "Lambda authorizer + context" pattern at the edge: one call POSTs the
// viewer context to /authorize, the authorizer answers { allow, headers }, and the
// function copies those identity headers onto the request (allow) or answers 403 (deny).
// An authorizer that cannot be asked fails closed with 503.

const AUTHORIZER_ORIGIN_ID = 'authorizer-headers';
const AUTHORIZE_PATH = '/authorize';
// The only headers the authorizer may set. Viewers can never supply them.
const IDENTITY_HEADERS = ['x-tenant', 'x-role'];
const ERROR_HEADER = 'x-authorizer-headers-error';
const STATUS_TEXT = { 403: 'Forbidden', 503: 'Service Unavailable' };

function headerValue(headers, name) {
  return headers[name] ? headers[name].value : '';
}

// Never trust identity headers coming from the viewer.
function stripIdentityHeaders(headers) {
  for (let i = 0; i < IDENTITY_HEADERS.length; i++) delete headers[IDENTITY_HEADERS[i]];
}

// What the authorizer decides on: who is asking, for what.
function viewerContext(event) {
  const request = event.request;
  return {
    ip: event.viewer.ip,
    uri: request.uri,
    method: request.method,
    headers: {
      authorization: headerValue(request.headers, 'authorization'),
      'user-agent': headerValue(request.headers, 'user-agent'),
    },
  };
}

// The one network call. Resolves to { ok, status, decision }; throws when the authorizer
// cannot be asked or its answer is not JSON.
async function askAuthorizer(context) {
  const body = JSON.stringify(context);
  const authorizerResponse = await cf.fetch(AUTHORIZE_PATH, {
    originId: AUTHORIZER_ORIGIN_ID,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body,
    includeBody: true, // default false; the decision is in the body
  });
  if (!authorizerResponse.ok) return { ok: false, status: authorizerResponse.status };
  const text = await authorizerResponse.text(); // assign first: no await inside call arguments
  return { ok: true, status: authorizerResponse.status, decision: JSON.parse(text) };
}

// Copy only the allowlisted identity headers, lowercased.
function grantIdentityHeaders(headers, granted) {
  for (const name in granted) {
    const lowerName = name.toLowerCase();
    if (IDENTITY_HEADERS.indexOf(lowerName) !== -1) headers[lowerName] = { value: String(granted[name]) };
  }
}

function deny(status, code, error) {
  const headers = {
    'content-type': { value: 'application/json' },
    'cache-control': { value: 'no-store' },
  };
  if (error) headers[ERROR_HEADER] = { value: error };
  return {
    statusCode: status,
    statusDescription: STATUS_TEXT[status],
    headers: headers,
    body: JSON.stringify({ error: code }),
  };
}

async function handler(event) {
  const request = event.request;
  const headers = request.headers;
  stripIdentityHeaders(headers);

  let answer;
  try {
    answer = await askAuthorizer(viewerContext(event));
  } catch (error) {
    // Fail closed: TypeError, TimeoutError, InternalError, or a body that is not JSON.
    return deny(503, 'authorizer_unavailable', error.name + ': ' + error.message);
  }
  if (!answer.ok) return deny(503, 'authorizer_unavailable', 'authorizer returned ' + answer.status);

  const decision = answer.decision;
  if (!decision || decision.allow !== true) return deny(403, 'forbidden');

  grantIdentityHeaders(headers, decision.headers || {});
  return request;
}
