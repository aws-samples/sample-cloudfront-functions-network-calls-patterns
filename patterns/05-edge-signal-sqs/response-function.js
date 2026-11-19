import cf from 'cloudfront';

// Viewer-response function on /patterns/edge-signal-sqs/*: the way out.
// The viewer-response hook runs on every response, cache hits included, so a call here
// must be rare by construction: it fires only when the origin answered 5xx, or when the
// viewer asked for a sample (x-signal-sample: 1). Everything else gets
// x-signal-served: skipped and no call.
// CloudFront does not run viewer-response functions when the origin returns 400 or
// higher, so when you try it, the sample switch is what makes the call visible.

const QUEUE_ORIGIN_ID = 'edge-signal-sqs';
const SIGNAL_PATH = '/patterns/signal';
const MAX_DEDUP_ID_LENGTH = 128; // SQS FIFO limit
const FIRST_SERVER_ERROR = 500;
const SAMPLE_HEADER = 'x-signal-sample';
const SIGNAL_ID_HEADER = 'x-signal-id';
const SERVED_HEADER = 'x-signal-served';
const ERROR_HEADER = 'x-signal-served-error';

function headerValue(headers, name) {
  return headers[name] ? headers[name].value : '';
}

// Rare by construction: an origin 5xx, or an explicit sample request.
function shouldSignal(request, status) {
  return status >= FIRST_SERVER_ERROR || headerValue(request.headers, SAMPLE_HEADER) === '1';
}

function servedSignal(request, status) {
  const uri = request.uri.slice(0, MAX_DEDUP_ID_LENGTH);
  return {
    kind: 'served',
    uri: uri,
    status: status,
    // Correlates with the "requested" event that function.js sent on the way in.
    signalId: headerValue(request.headers, SIGNAL_ID_HEADER) || uri,
    // Its own FIFO dedup id, so it never collapses into the "requested" event.
    dedupId: ('served:' + uri + ':' + status).slice(0, MAX_DEDUP_ID_LENGTH),
    ts: Date.now(),
  };
}

async function handler(event) {
  const request = event.request;
  const response = event.response;
  const status = response.statusCode;

  if (!shouldSignal(request, status)) {
    response.headers[SERVED_HEADER] = { value: 'skipped' };
    return response;
  }

  try {
    cf.beacon(SIGNAL_PATH, {
      originId: QUEUE_ORIGIN_ID,
      method: 'POST',
      headers: { 'content-type': 'application/json' }, // plain strings, not { value } objects
      body: JSON.stringify(servedSignal(request, status)),
      logDeliveryErrors: true, // a delivery failure after the function returned goes to CloudWatch Logs
    });
    response.headers[SERVED_HEADER] = { value: 'beacon' };
  } catch (error) {
    response.headers[SERVED_HEADER] = { value: 'failed' };
    response.headers[ERROR_HEADER] = { value: error.name + ': ' + error.message };
  }
  return response;
}
