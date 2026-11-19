import cf from 'cloudfront';

// Viewer-request function on /patterns/cognito-auth/*.
// Validates the viewer's Cognito access token with one call to Cognito GetUser
// (no SigV4: the token is the credential), then forwards the request with
// x-user-sub and x-user-name set. Anything else is denied before the origin:
//   no Bearer token          -> 401 missing_token, no call
//   token Cognito rejects    -> 401 invalid_token
//   Cognito cannot be asked  -> 503 auth_unavailable (fail closed)

const COGNITO_ORIGIN_ID = 'cognito-auth';
const GET_USER_TARGET = 'AWSCognitoIdentityProviderService.GetUser';
const BEARER_PREFIX = 'bearer ';
const IDENTITY_HEADER_PREFIX = 'x-user-';
const USER_SUB_HEADER = 'x-user-sub';
const USER_NAME_HEADER = 'x-user-name';
const ERROR_HEADER = 'x-cognito-auth-error';
const STATUS_TEXT = { 401: 'Unauthorized', 503: 'Service Unavailable' };

// Never trust identity headers coming from the viewer.
function stripIdentityHeaders(headers) {
  for (const name in headers) {
    if (name.indexOf(IDENTITY_HEADER_PREFIX) === 0) delete headers[name];
  }
}

// The token after "Bearer ", or null when the viewer sent no Bearer credential at all.
function readBearerToken(headers) {
  const authorization = headers.authorization ? headers.authorization.value : '';
  if (authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return null;
  return authorization.slice(BEARER_PREFIX.length).trim();
}

// The one network call. Resolves to the Cognito user, or null for a token Cognito rejects;
// throws when Cognito cannot be asked.
async function getCognitoUser(token) {
  const cognitoResponse = await cf.fetch('/', {
    originId: COGNITO_ORIGIN_ID,
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': GET_USER_TARGET,
    },
    body: JSON.stringify({ AccessToken: token }),
    includeBody: true, // default false; the user is in the body
  });
  // Cognito answers 400 NotAuthorizedException for a bad or expired token.
  if (!cognitoResponse.ok) return null;
  const text = await cognitoResponse.text(); // assign first: no await inside call arguments
  return JSON.parse(text);
}

// The value of a Cognito user attribute, '' when the user has none.
function userAttribute(user, name) {
  const attributes = user.UserAttributes || [];
  let value = '';
  for (let i = 0; i < attributes.length; i++) {
    if (attributes[i].Name === name) value = attributes[i].Value;
  }
  return value;
}

function deny(status, code, error) {
  const headers = {
    'content-type': { value: 'application/json' },
    'cache-control': { value: 'no-store' },
  };
  if (status === 401) headers['www-authenticate'] = { value: 'Bearer' };
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

  const token = readBearerToken(headers);
  if (token === null) return deny(401, 'missing_token');

  let user;
  try {
    user = await getCognitoUser(token);
  } catch (error) {
    // Fail closed: TypeError, TimeoutError, InternalError, or a body that is not JSON.
    return deny(503, 'auth_unavailable', error.name + ': ' + error.message);
  }

  const sub = user ? userAttribute(user, 'sub') : '';
  if (!sub) return deny(401, 'invalid_token');

  headers[USER_SUB_HEADER] = { value: sub };
  headers[USER_NAME_HEADER] = { value: String(user.Username) };
  return request;
}
