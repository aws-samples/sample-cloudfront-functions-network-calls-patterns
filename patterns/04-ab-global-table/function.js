import cf from 'cloudfront';
import crypto from 'crypto';

// Viewer-request function on /patterns/ab-global-table/*.
// Sticky A/B: the uid cookie names the user, the KVS holds the warm working set,
// DynamoDB (global table) behind the origin is the source of truth.
//   KVS hit  -> x-ab-variant from KVS, no network call
//   KVS miss -> one call: POST /assign/<uid> on this pattern's origin
//   failure  -> x-ab-variant: control and x-ab-error, request still forwarded
// This side never sets a cookie: response-function.js turns x-ab-set-uid and
// x-ab-set-variant into Set-Cookie.

const ASSIGNER_ORIGIN_ID = 'ab-global-table';
const ASSIGN_PATH = '/assign/';
const UID_COOKIE = 'uid';
const UID_PATTERN = /^[a-f0-9]{16}$/;
const UID_LENGTH = 16;
const FALLBACK_VARIANT = 'control';
// Read by response-function.js: only this function may set them.
const SET_UID_HEADER = 'x-ab-set-uid';
const SET_VARIANT_HEADER = 'x-ab-set-variant';
// Forwarded to the origin.
const UID_HEADER = 'x-ab-uid';
const NEW_UID_HEADER = 'x-ab-uid-new';
const KVS_HEADER = 'x-ab-kvs';
const VARIANT_HEADER = 'x-ab-variant';
const SOURCE_HEADER = 'x-ab-source';
const ERROR_HEADER = 'x-ab-error';

function isVariant(value) {
  return value === 'A' || value === 'B';
}

// Unique enough per browser. Not Math.random(): a function cannot make a network call
// after generating random values, so it hashes the request id instead.
function newUid(event) {
  const seed = event.context.requestId + event.viewer.ip + Date.now();
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, UID_LENGTH);
}

// The viewer's uid cookie, or a new uid that the response side will set as a cookie.
function readOrIssueUid(event) {
  const request = event.request;
  const cookie = request.cookies[UID_COOKIE];
  const uid = cookie ? cookie.value : '';
  if (UID_PATTERN.test(uid)) return uid;

  const issued = newUid(event);
  request.cookies[UID_COOKIE] = { value: issued };
  request.headers[NEW_UID_HEADER] = { value: '1' };
  request.headers[SET_UID_HEADER] = { value: issued };
  return issued;
}

// The one network call, on a KVS miss. Resolves to A or B, or throws.
async function assignVariant(uid) {
  const assignResponse = await cf.fetch(ASSIGN_PATH + uid, {
    originId: ASSIGNER_ORIGIN_ID,
    method: 'POST',
    includeBody: true, // default false; the variant is in the body
  });
  const text = await assignResponse.text(); // assign first: no await inside call arguments
  const assignment = JSON.parse(text);
  if (!isVariant(assignment.variant)) throw new Error('bad assign response, status ' + assignResponse.status);
  return assignment.variant;
}

async function handler(event) {
  const request = event.request;
  const headers = request.headers;
  // Only this function may talk to the response side: drop viewer-supplied copies.
  delete headers[SET_UID_HEADER];
  delete headers[SET_VARIANT_HEADER];

  const uid = readOrIssueUid(event);
  headers[UID_HEADER] = { value: uid };

  // 1. KVS. A missing key, or no KVS associated, throws: that is a miss.
  let variant = '';
  let source = 'kvs';
  try {
    variant = await cf.kvs().get(uid);
    headers[KVS_HEADER] = { value: 'hit' };
  } catch (error) {
    headers[KVS_HEADER] = { value: 'miss: ' + error.message };
  }

  // 2. Miss: one call to the assigner.
  if (!isVariant(variant)) {
    try {
      variant = await assignVariant(uid);
      source = 'origin';
    } catch (error) {
      // TypeError, TimeoutError, InternalError, or a bad body: forward as control.
      variant = FALLBACK_VARIANT;
      source = 'fallback';
      headers[ERROR_HEADER] = { value: error.name + ': ' + error.message };
    }
  }

  headers[VARIANT_HEADER] = { value: variant };
  headers[SOURCE_HEADER] = { value: source };
  if (variant !== FALLBACK_VARIANT) headers[SET_VARIANT_HEADER] = { value: variant };
  return request;
}
