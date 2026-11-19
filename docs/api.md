# The network call API

What `cf.fetch` and `cf.beacon` accept and return, as every pattern in this repo uses them. The pattern READMEs link here
instead of repeating it.

## The shape of a call

```js
import cf from 'cloudfront';

async function handler(event) {
  try {
    const res = await cf.fetch('/path?query', {
      originId: '<origin id on this distribution>',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'edge' }),
      includeBody: true,                // default false
    });
    if (!res.ok) console.log('status ' + res.status + ' cfId ' + res.headers.get('x-amz-cf-id'));
    const text = await res.text();      // a promise: assign first
    const data = JSON.parse(text);
  } catch (e) {
    // e.name === 'TypeError' (a bad call, or the edge could not reach the origin) | 'TimeoutError' | 'InternalError' | 'SyntaxError'
  }
  return event.request;
}
```

## Reference

| | |
|---|---|
| Call | `cf.fetch(path, options)` from `import cf from 'cloudfront'`, returns a promise. `path` starts with `/` and may carry a query string (8 KB max). Call it inside the handler; at top level it throws. Runtime `cloudfront-js-2.0`, viewer request and viewer response |
| Target | An origin on the same distribution, named by its origin id (the console's origin **Name**). No host names, no URLs. A target viewers never reach can be an origin with no cache behavior |
| Options | `originId`, `method` (`GET` default, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, upper case), `headers` (a plain string map, `{ 'content-type': 'application/json' }`; the event's `{ value }` shape throws `TypeError`), `body` (a string, `ArrayBuffer` or typed array, 10 KB max; not allowed on `GET` or `HEAD`, the default `GET` included, which throws `TypeError`), `includeBody` (default **`false`**; set `true` whenever you read the body). Names are case sensitive and **unknown options are ignored silently**: `Method: 'POST'` sends a GET, and `timeout` does nothing. Header values must be strings and go out as Latin-1, one byte per character; a character above U+00FF throws `TypeError`. A string body with no `content-type` is sent as `text/plain;charset=UTF-8`, a binary body with none |
| Timeout | No option. A fixed **1 s** from sending to the last byte, not extended by the origin's response timeout; then `TimeoutError`. That 1 s is the only budget: by design every `Date` call returns the function's start time for the whole run ([CloudFront Functions restricted features](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-10.html#writing-functions-javascript-features-restricted-features)), so `Date.now()` does not advance across an awaited `cf.fetch` and a self-timed budget never fires. Handle `TimeoutError` (fail open in [03](../patterns/03-bot-check-fail-open/), fail over in [08](../patterns/08-origin-health-fallback/)) |
| Response | `status`, `ok` (2xx), `bodyUsed`, `headers` (a read-only `Headers` object, not a method: `get(name)` is case-insensitive, joins repeated values with `, ` and returns `null` when absent; also `has`, `getSetCookie()`, `forEach`, `keys`, `values`, `entries`; values decode as Latin-1), and the **promises** `text()`, `json()` (rejects with `SyntaxError`), `bytes()`, `arrayBuffer()`. `text()` and `json()` decode UTF-8. No `statusText`, `url`, `redirected` or `clone()`. Any status the origin sends resolves, and CloudFront custom error responses do not apply to it. The body is read once; a second read rejects with `TypeError`. Read with `const text = await res.text()`, then `JSON.parse(text)` in a `try` |
| Fire-and-forget | `cf.beacon(path, options)`, available wherever `cf.fetch` is: same `path`, `originId`, `method`, `headers`, `body`; returns `undefined` at once. `includeBody` throws; `logDeliveryErrors: true` writes late delivery failures to CloudWatch Logs, the only way to see them ([05](../patterns/05-edge-signal-sqs/)) |
| Calls per invocation | One, `cf.fetch` or `cf.beacon`; a second call throws, inside `Promise.all` too. A request and its response are two invocations |
| Built from scratch | The viewer's headers, cookies and query string are **not** copied; pass what the origin needs. `X-Forwarded-For` (the viewer's, with the viewer IP appended), `Via` and `CDN-Loop` are carried over (yours are ignored); no `CloudFront-*` viewer headers are added. `Accept-Encoding`, `Content-Length`, `Connection`, `Proxy-Connection`, `Keep-Alive`, `TE`, `Transfer-Encoding` and `Upgrade` throw `TypeError`, and so do `X-Amz-Cf-*` and `X-Edge-*` (`HeaderDisallowed`) |
| Origin access control | A call to an origin behind OAC is signed like a viewer request and carries the origin's custom headers. The Lambda origins in this repo are Lambda Web Functions with an `IamAuth` endpoint and an OAC that signs with `always-amz-auth`: CloudFront signs `POST`, `PUT` and `PATCH` with an unsigned payload, so no `x-amz-content-sha256` is needed, and the viewer's `Authorization` header reaches the origin unchanged ([OAC for Lambda Web Functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda-web.html)). A Lambda function URL behind OAC is different: a `POST` or `PUT` must send `x-amz-content-sha256`, the SHA-256 of its body ([OAC for Lambda function URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html#create-oac-overview-lambda)) |
| Limits | 10 KB request body, 10 KB response body, 10 KB of request headers (256 bytes per name, 1,783 per value), 10 KB of response headers in total, 8 KB path and query string, 2,000 in-flight calls per function per CloudFront host. Responses must be UTF-8; no streaming |
| Errors | `TypeError`: the call is invalid (bad argument, disallowed header, too large, unknown origin id, a distribution or plan that does not support network calls); retrying will not help. **Also `TypeError`** when the edge could not reach the origin: `The request could not be completed due to OriginDnsError` (or `OriginConnectError` for TLS, `OriginCommError`, `OriginHeaderTooBigError`, `AbortedOrigin`), the `x-edge-detailed-result-type` your logs show; a 502 the origin sends itself still resolves. Tell the two apart by that message when it matters ([08](../patterns/08-origin-health-fallback/)). `TimeoutError`. `InternalError`: treat it like a timeout. `SyntaxError` from `json()`. Identify errors by `name`. A non-2xx answer resolves with `ok: false`. An uncaught error is a viewer 503 |
| Randomness | No network call after generating random values (`Math.random()`, `crypto.getRandomValues()`) or a non-deterministic crypto operation; webcrypto works only after the call ([04](../patterns/04-ab-global-table/) hashes the request id instead of using `Math.random()`) |
| Not supported | Connection functions, distributions with continuous deployment, the free pricing plan, test invocations (the call throws `TypeError`) |
| Tracing | The response carries its own `x-amz-cf-id`, not the viewer request's; log `res.headers.get('x-amz-cf-id')` on failures |
| Compile-time trap | `await` inside call arguments (`JSON.parse(await res.text())`) runs in Node but is rejected when the function is published (`SyntaxError: await in arguments not supported`). `npm run check:no-await-in-args` catches it. **Observed 2026-10-27**: a `for (... of ...)` loop publishes fine, then every request is a 503 `FunctionExecutionError` (`SyntaxError: Token "of" not supported in this version`); `npm run check:no-for-of` catches it |

## Using KVS next to a call

A KVS read is not a network call, so a function may read KVS and make its one call in the same invocation, even in
parallel. Use `Promise.allSettled`, not `Promise.all`: a missing key rejects, and `Promise.all` would drop the call's result
([03](../patterns/03-bot-check-fail-open/)). When the KVS value decides whether to call at all (a kill switch, or a read-through cache), read it first
([06](../patterns/06-vpc-private-routing/), [07](../patterns/07-kvs-config-plus-fetch/)).
