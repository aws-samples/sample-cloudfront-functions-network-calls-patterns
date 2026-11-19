# Anti-patterns

Things `cf.fetch` in a CloudFront Function looks able to do and should not. Each line is a rule the pattern READMEs already
encode; this page is the short list.

- **Prompt-aware logic.** The function cannot read the request body, so prompt moderation, guardrails and token counting
  cannot happen here. They belong to Lambda@Edge or to the origin. What the function can decide on: method, path, query
  string, headers, cookies.
- **A fetch on every response.** `viewer-response` runs on cache hits too, so an ungated `cf.fetch` there turns every hit into
  an origin round trip. Gate it on status, path or an explicit header ([05](05-edge-signal-sqs/)).
- **Fixing errors in `viewer-response`.** CloudFront does not invoke viewer-response functions when the origin returns 400 or
  higher. Recovery is decided on the request side ([08](08-origin-health-fallback/)).
- **Relying on origin groups for POST.** Origin groups, static or built with `cf.createRequestOriginGroup`, fail over only
  GET, HEAD and OPTIONS. A POST to an endpoint that is down just fails, and AI traffic is almost all POST. Decide before the
  request is sent: probe, then `cf.selectRequestOriginById` a secondary ([08](08-origin-health-fallback/)).
- **An awaited `cf.fetch` for a signal nobody reads.** Use `cf.beacon`: fire-and-forget, nothing to await, still the one call.
  It takes the same options as `cf.fetch` and is available wherever `cf.fetch` is; set `logDeliveryErrors: true` to see
  late failures ([05](05-edge-signal-sqs/)).
- **Calling `json()` (or `text()`) without `await`.** Both return promises. `const data = res.json()` is a pending
  promise, `data.variant` is `undefined`, and the code quietly takes the wrong branch. Assign first,
  `const text = await res.text()`, then `JSON.parse(text)` in a `try`, so a bad body is handled in one place. And never
  `JSON.parse(await res.text())`: `await` inside call arguments is rejected when the function is published
  (`npm run check:no-await-in-args`).
- **Relying on `timeout`.** There is no such option: every call can take up to a fixed 1 s, the origin's own response
  timeout does not extend it, then it rejects with `TimeoutError`. Treat that 1 s as the budget, decide on `TimeoutError` (fail open or fail over), and gate slow calls behind KVS ([03](03-bot-check-fail-open/), [08](08-origin-health-fallback/)).
- **Timing the call with `Date.now()`.** By design `Date` returns the function's start time for the whole run
  ([CloudFront Functions restricted features](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-10.html#writing-functions-javascript-features-restricted-features)), so across an awaited `cf.fetch`
  `Date.now() - started` does not measure how long the origin took, and a self-timed budget never fires.
- **Passing `{ value }` header objects to the fetch.** The event uses `{ value }` objects, the fetch does not: its `headers`
  is a plain string map, `{ 'content-type': 'application/json' }`. An object value throws `TypeError`.
- **Forgetting `includeBody: true`.** It defaults to `false`: CloudFront does not read the response body unless asked. Set
  it on every call whose body you read; leave it `false` when the status is the answer
  ([08](08-origin-health-fallback/)).
- **A misspelled option.** Option names are case sensitive and unknown ones are ignored without an error: `Method: 'POST'`
  sends a GET. Copy the names from the [API reference](../docs/api.md#reference).
- **Random values before the call.** A function cannot make a network call after generating random values (`Math.random()`,
  `crypto.getRandomValues()`) or a non-deterministic crypto operation, and webcrypto works only after the call. Derive ids
  from the request instead ([04](04-ab-global-table/) hashes the CloudFront request id).
- **`Promise.all` with a KVS read.** A KVS miss rejects the whole thing and the fetch result is lost. Use `Promise.allSettled`
  ([03](03-bot-check-fail-open/)), or read KVS first when it is the kill switch ([06](06-vpc-private-routing/)).
- **Fail closed on a third-party check.** A slow vendor must not take the site down. Fail open unless the
  call is the authorization decision itself ([03](03-bot-check-fail-open/) versus [01](01-cognito-auth/), [02](02-authorizer-headers/)).
- **Fetching what KVS can hold.** A value under 1 KB that may lag seconds belongs in KVS; fetch only on a miss or when the
  value must be live ([04](04-ab-global-table/), [07](07-kvs-config-plus-fetch/)).
- **Depending on a fetch-level cache.** There are no cache options on `cf.fetch`, so every call goes to the origin. Treat KVS as the durable cache and `cf.fetch` as the live call
  ([07](07-kvs-config-plus-fetch/)).
- **Signing requests yourself.** There is no SDK and no SigV4 in a CloudFront Function. Put API Gateway in front of
  SigV4-only services ([05](05-edge-signal-sqs/)), or call token-authenticated endpoints ([01](01-cognito-auth/)).
