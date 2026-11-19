import cf from 'cloudfront';

// Viewer-request function on /patterns/markdown-on-demand/*.
// AI agents get a markdown copy of a page, made the first time one asks for it:
//   not an agent, or not a page -> x-markdown: skipped, no call
//   KVS has md:<uri>            -> URI rewritten to the .md object, x-markdown: served, no call
//   no key yet                  -> the HTML as usual, plus one cf.beacon { uri } to the queue,
//                                  x-markdown: queued (x-markdown: failed if cf.beacon threw)
//   GET reset?page=guide.html   -> one cf.beacon { action: reset } to the same queue, a JSON
//                                  answer from the function itself, x-markdown: reset
// A worker behind the queue converts the page, then writes the .md and the KVS key; a reset
// deletes the key, so the next agent request is queued again.
// KVS answers "does markdown exist yet" without spending the one network call.

const QUEUE_ORIGIN_ID = 'markdown-on-demand-queue';
const CONVERT_PATH = '/patterns/convert';
const PAGE_DIR = '/patterns/markdown-on-demand/';
const RESET_URI = PAGE_DIR + 'reset';
const INDEX_DOCUMENT = 'index.html';
const MARKDOWN_KEY_PREFIX = 'md:'; // md:<page uri> -> the .md object's URI, written by the worker
const MARKDOWN_TYPE = 'text/markdown';
const MS_PER_MINUTE = 60000;
// .html under this path only, no dots elsewhere: the worker accepts exactly the same URIs.
const PAGE = /^\/patterns\/markdown-on-demand\/[\w\/-]{1,200}\.html$/;
// An agent says so with Accept, or AWS WAF Bot Control labels it an AI bot. The web ACL writes
// this header on every request here (the bot's name, or none), overwriting any viewer copy.
const WAF_AGENT_HEADER = 'x-amzn-waf-ai-agent';
const NOT_AN_AGENT = 'none';
const MARKDOWN_HEADER = 'x-markdown';
const ERROR_HEADER = 'x-markdown-error';

function headerValue(headers, name) {
  return headers[name] ? headers[name].value : '';
}

function describeError(error) {
  return error.name + ': ' + error.message;
}

function isAgent(headers) {
  const wafAgent = headerValue(headers, WAF_AGENT_HEADER);
  return headerValue(headers, 'accept').indexOf(MARKDOWN_TYPE) !== -1 || (wafAgent !== '' && wafAgent !== NOT_AN_AGENT);
}

// The function's own answer to a reset: JSON, never cached.
function jsonReply(statusCode, verdict, body) {
  return {
    statusCode: statusCode,
    headers: {
      'content-type': { value: 'application/json' },
      'cache-control': { value: 'no-store' },
      [MARKDOWN_HEADER]: { value: verdict },
    },
    body: JSON.stringify(body),
  };
}

// The one network call, fire-and-forget. Throws only for an invalid call (TypeError):
// a bad option, or a second call in one invocation.
function sendToQueue(message) {
  cf.beacon(CONVERT_PATH, {
    originId: QUEUE_ORIGIN_ID,
    method: 'POST',
    headers: { 'content-type': 'application/json' }, // plain strings, not { value } objects
    body: JSON.stringify(message),
    logDeliveryErrors: true, // a delivery failure after the function returned goes to CloudWatch Logs
  });
}

// Forget a page's markdown so the next agent request is queued again. Anyone may ask;
// it only ever names md:<page> for a page this function would convert.
function resetPage(request) {
  const page = request.querystring.page ? PAGE_DIR + request.querystring.page.value : '';
  if (!PAGE.test(page)) return jsonReply(400, 'invalid', { error: 'page must be a .html page under ' + PAGE_DIR });
  try {
    // at: each reset is its own message, never deduplicated with an earlier one.
    sendToQueue({ action: 'reset', uri: page, at: Date.now() });
  } catch (error) {
    return jsonReply(500, 'failed', { error: describeError(error) });
  }
  return jsonReply(200, 'reset', { reset: 'queued', uri: page, note: 'the edge sees it in about a minute' });
}

async function handler(event) {
  const request = event.request;
  const headers = request.headers;
  // Only this function tells the response side what happened: drop viewer-supplied copies.
  delete headers[MARKDOWN_HEADER];
  delete headers[ERROR_HEADER];

  if (request.uri === RESET_URI) return resetPage(request);

  // S3 has no index document below the root: a folder means its index.html.
  if (request.uri.endsWith('/')) request.uri += INDEX_DOCUMENT;
  const uri = request.uri;
  if (!isAgent(headers) || !PAGE.test(uri)) {
    headers[MARKDOWN_HEADER] = { value: 'skipped' };
    return request;
  }

  // 1. KVS. A missing key, or no KVS associated, throws: not converted yet.
  try {
    request.uri = await cf.kvs().get(MARKDOWN_KEY_PREFIX + uri);
    headers[MARKDOWN_HEADER] = { value: 'served' };
    return request;
  } catch (error) {
    // KeyNotFound: fall through and ask for a conversion.
  }

  // 2. Miss: the HTML goes out as usual; one message asks for markdown.
  try {
    // The URI and the minute: the FIFO queue dedups on the body, so a burst is one message,
    // and a page reset a minute ago is not dropped as a repeat of its first conversion.
    sendToQueue({ uri: uri, minute: Math.floor(Date.now() / MS_PER_MINUTE) });
    headers[MARKDOWN_HEADER] = { value: 'queued' };
  } catch (error) {
    headers[MARKDOWN_HEADER] = { value: 'failed' };
    headers[ERROR_HEADER] = { value: describeError(error) };
  }
  return request;
}
