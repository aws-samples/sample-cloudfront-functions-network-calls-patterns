import cf from 'cloudfront';
import crypto from 'crypto';

// Viewer-request function on /patterns/edge-signal-sqs/*.
// Fires a small JSON signal at this pattern's origin (API Gateway -> SQS FIFO, no Lambda)
// with cf.beacon, then forwards the request whatever happened.
//   x-signal: beacon -> handed off; nothing to await, no response to read
//   x-signal: failed -> cf.beacon threw (x-signal-error)
// cf.beacon still counts as the one network call per invocation.

const QUEUE_ORIGIN_ID = 'edge-signal-sqs';
const SIGNAL_PATH = '/patterns/signal';
const MAX_DEDUP_ID_LENGTH = 128; // SQS FIFO limit
const MAX_USER_AGENT_LENGTH = 200;
const VIEWER_HASH_LENGTH = 16;
const SIGNAL_ID_HEADER = 'x-signal-id';
const SIGNAL_HEADER = 'x-signal';
const ERROR_HEADER = 'x-signal-error';

// Never ship the raw viewer IP: a truncated hash is enough to tell viewers apart.
function hashViewerIp(ip) {
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, VIEWER_HASH_LENGTH);
}

function requestedSignal(event, signalId) {
  const userAgent = event.request.headers['user-agent'] ? event.request.headers['user-agent'].value : '';
  return {
    kind: 'requested',
    uri: signalId,
    ip: hashViewerIp(event.viewer.ip),
    ua: userAgent.slice(0, MAX_USER_AGENT_LENGTH),
    ts: Date.now(),
  };
}

async function handler(event) {
  const request = event.request;

  // FIFO dedup id (the API Gateway mapping uses it).
  const signalId = request.uri.slice(0, MAX_DEDUP_ID_LENGTH);
  // Carried forward so response-function.js can correlate its "served" event.
  request.headers[SIGNAL_ID_HEADER] = { value: signalId };

  try {
    cf.beacon(SIGNAL_PATH, {
      originId: QUEUE_ORIGIN_ID,
      method: 'POST',
      headers: { 'content-type': 'application/json' }, // plain strings, not { value } objects
      body: JSON.stringify(requestedSignal(event, signalId)),
      logDeliveryErrors: true, // a delivery failure after the function returned goes to CloudWatch Logs
    });
    request.headers[SIGNAL_HEADER] = { value: 'beacon' };
  } catch (error) {
    // Only invalid calls throw here (TypeError): a bad option, or a second call in one invocation.
    request.headers[SIGNAL_HEADER] = { value: 'failed' };
    request.headers[ERROR_HEADER] = { value: error.name + ': ' + error.message };
  }
  return request;
}
