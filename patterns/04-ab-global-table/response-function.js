// Viewer-response function on /patterns/ab-global-table/*.
// The request function decided (KVS first, ONE cf.fetch on a miss) and left the
// decision on the request as x-ab-set-uid / x-ab-set-variant. This side only
// turns those into cookies. No cf.fetch, no KVS: this hook runs on cache hits
// too, so it must stay cheap.

const SET_UID_HEADER = 'x-ab-set-uid';
const SET_VARIANT_HEADER = 'x-ab-set-variant';
const HOOKS_HEADER = 'x-ab-hooks';
const UID_COOKIE = 'uid';
const VARIANT_COOKIE = 'ab';
const UID_PATTERN = /^[a-f0-9]{16}$/;
const COOKIE_ATTRIBUTES = 'Path=/patterns/ab-global-table/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax';

function headerValue(headers, name) {
  return headers[name] ? headers[name].value : '';
}

function handler(event) {
  const requestHeaders = event.request.headers;
  const response = event.response;
  const uid = headerValue(requestHeaders, SET_UID_HEADER);
  const variant = headerValue(requestHeaders, SET_VARIANT_HEADER);

  if (UID_PATTERN.test(uid)) response.cookies[UID_COOKIE] = { value: uid, attributes: COOKIE_ATTRIBUTES };
  if (variant === 'A' || variant === 'B') {
    response.cookies[VARIANT_COOKIE] = { value: variant, attributes: COOKIE_ATTRIBUTES };
  }
  response.headers[HOOKS_HEADER] = { value: 'request+response' };
  return response;
}
