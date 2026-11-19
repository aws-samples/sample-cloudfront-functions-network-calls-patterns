# Adding a pattern

1. Copy `patterns/00-hello-fetch/` to `patterns/<nn>-<name>/`. A pattern is `pattern.ts`, `function.js`, `demo.json`,
   `README.md` and its tests.
2. `pattern.ts` exports `pattern: Pattern` (the contract is in `infra/lib/pattern.ts`). `id` equals the folder name without
   the `<nn>-` prefix, and the origin you return uses `originId: '<id>'`. The stack discovers the folder; do not edit
   `infra/` or another pattern's folder.
3. **Shared KVS.** Set `keyValueStore: true` to associate the function with it (`cf.kvs()` then works), and read
   `ctx.keyValueStore` in `origin(scope, ctx)` for a backend that reads or writes it. List every key you read in
   [docs/deploy.md](deploy.md#the-kvs-keys).
4. **A call target viewers never hit** (an identity provider, a queue API): implement `extraOrigins(scope, ctx)` and return
   `[{ id: '<origin-id>', origin }]`, each origin created with `originId: '<origin-id>'`. It is added to the distribution
   with no cache behavior.
   A demo-only helper route viewers DO hit, that must not run your function (01's token route): implement
   `extraBehaviors(scope, ctx)` and return `[{ path: '/patterns/<id>/<route>', id: '<origin-id>', origin }]`. Each gets its
   own cache behavior, added before `/patterns/<id>/*` so it wins: no function, no caching, GET and HEAD only, the shared
   Server-Timing policy. Keep it out of the pattern's lesson and say in the README why it exists.
5. **A call on the way out**: add `response-function.js` and set `responseFunctionCode`. It becomes a second function
   (`network-calls-<id>-response`) on the same behavior as `viewer-response`, and `keyValueStore: true` associates the KVS
   with both. Set `"hooks": ["viewer-request", "viewer-response"]` in `demo.json`. Then remember:
   - A request and its response are two invocations, one call each.
   - `viewer-response` runs on cache hits too. Gate the call (status, path, an explicit header) or you pay a call per hit.
   - `viewer-response` does not run when the origin returns 400 or higher.
   - The function cannot read the origin's response body, only replace it. Decide from status and headers.
6. **AWS WAF rules**: implement `webAclRules()` and return `CfnWebACL` rule objects (priority 0; they are numbered in
   pattern order). They join one shared web ACL on the distribution (default action Allow), which exists only while some
   pattern contributes rules. Scope every rule down to your pattern's path so no other pattern is affected.
7. **Response headers**: every behavior gets the shared Server-Timing response headers policy. A pattern that needs its
   own sets `behavior.responseHeadersPolicy` to a `cloudfront.ResponseHeadersPolicy` it creates in `origin()` (hand it
   over with a `behavior` getter, as 11 does for its origin request policy); Server-Timing is merged into it. A managed
   or imported policy is rejected at synth, because it cannot be edited. Do not time anything in the function to add
   Server-Timing entries: `Date.now()` does not advance across an awaited `cf.fetch`.
8. Run `npm run demo:index`. It validates `demo.json` and writes `demo/patterns.json` (commit it; `npm test` fails when it
   is stale). Add a row for the pattern to the root README's **Patterns** table, and keep `expect` in `demo.json` in line with your README's **Try it**.

## Function rules

Code against [docs/api.md](api.md). The checks catch some of these; reviews catch the rest.

- Call `cf.fetch` (or `cf.beacon`) inside a `try`, with `originId` set to the origin id.
- Set `includeBody: true` whenever you read the body; it defaults to `false`.
- No `timeout` option exists; the fixed 1 s `TimeoutError` is the budget. Do not time the call with `Date.now()`: it returns
  the function's start time for the whole run ([documented](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-10.html#writing-functions-javascript-features-restricted-features)).
- Read the body as `const text = await res.text()`, then `JSON.parse(text)`. Never put `await` inside call arguments,
  template literals, arrays, objects or ternaries passed as arguments: Node runs it, CloudFront rejects it when the function
  is published (`npm run check:no-await-in-args`).
- No `for (... of ...)` loops: Node runs them and publishing succeeds, but the runtime fails to compile the function, so
  every request is a 503 (`SyntaxError: Token "of" not supported`). Use an index loop or `some`/`find`/`forEach`
  (`npm run check:no-for-of`).
- Identify errors by `name` (`TypeError`, `TimeoutError`, `InternalError`, `SyntaxError`) and decide on purpose whether the
  pattern fails open or closed. A `TypeError` is either a bad call or an origin the edge could not reach
  (`... could not be completed due to OriginDnsError`); check the message if the two need different handling.
- Read response headers with `res.headers.get(name)`: `headers` is a `Headers` object, not a method.
- Never send a body on `GET` or `HEAD` (the default method included): the call throws `TypeError`.
- No `Math.random()` or other random values before the call.
- Delete viewer-supplied copies of every header your function sets for the origin to trust.
- Keep each function under the 10 KB CloudFront Functions size limit (`npm run check:function-size`).

## Function code style

Each function is its pattern's lesson: readers copy it from the README and read it on the demo page. Write it so it reads
without the comments. [03](../patterns/03-bot-check-fail-open/function.js) is the reference.

- **Layout, top to bottom**: imports; a header comment listing the outcomes in a few lines (the README's tables carry the
  detail); named constants; helpers; `handler` last.
- **Named constants** in `UPPER_SNAKE_CASE` for every value a reader would otherwise have to decode: origin ids
  (`VENDOR_ORIGIN_ID`), call paths (`CHECK_PATH`), KVS keys (`BOT_POLICY_KEY`), the pattern's own header and cookie names
  (`VERDICT_HEADER`, `TICKET_COOKIE`), thresholds and lifetimes with the unit in the name (`ADMIT_SECONDS`, `STALE_MS`),
  defaults (`DEFAULT_POLICY`), and status sets the code decides on (`FAILOVER_STATUS_CODES`). Names someone else owns
  stay literal: standard HTTP headers (`content-type`, `authorization`), CloudFront's and AWS WAF's (`aws-waf-token`). So
  does a status code the function returns (`deny(401, 'missing_token')`): it already says what it is.
- **Intention-revealing names**: name what a value is. What `cf.fetch` returns is `vendorResponse` or
  `authorizerResponse`, never `res`; the parsed body is what it holds (`user`, `decision`, `answer`), never `data`; the
  `catch` variable is `error`; settled promises are `vendorResult` and `policyResult`. No single letters except loop
  indexes.
- **One helper per real step**: the call (`askVendor`, `lookupBackend`, `drawTicket`), reading an input
  (`readBearerToken`, `readTenant`), a decision (`shouldSignal`, `isAgent`), building a response (`deny`, `blockPage`,
  `waitingPage`). A helper that makes the call resolves to the answer or throws, so `handler` keeps the `try`/`catch`, and
  with it the fail-open or fail-closed decision, in plain sight. When the handler answers a non-2xx differently from a
  failure, the helper resolves to `{ ok, status, decision }` instead ([02](../patterns/02-authorizer-headers/function.js)).
  Do not wrap a single line in a helper.
- **`handler` reads as the steps**: strip the viewer-supplied headers, guard clauses that `return` early, the call, the
  decision. Deep nesting means a helper is missing.
- **Comments say why**: why a header is stripped, why `allSettled`, why fail open, not what the next line does. Keep
  the runtime traps on the line they guard (`// assign first: no await inside call arguments`,
  `// default false; the verdict is in the body`): that line is the one readers copy.
- **Each file stands alone**: no shared module, so one file can be copied. Small helpers such as `headerValue` and
  `describeError` repeat across files on purpose; a file that needs one only once writes the line inline.
- **`cloudfront-js-2.0` syntax only.** `const`, `let`, arrow functions, `async`/`await`, `Promise.allSettled` and
  computed keys (`{ [VERDICT_HEADER]: ... }`) work. Like `for...of`, optional chaining (`a?.b`) and spread (`{ ...a }`)
  run in Node and fail in CloudFront with a `SyntaxError` (checked with TestFunction on 2026-10-28).
- **Size budget**: most functions are 1 to 5 KB. [11](../patterns/11-edge-waiting-room/function.js) is at 9,465
  bytes of the 10,240 limit, so it folds one-line steps back into `handler` rather than shorten names. A new pattern that
  passes about 6 KB is doing too much in one function.

## Pattern README skeleton

Match [patterns/00-hello-fetch/README.md](../patterns/00-hello-fetch/README.md), in this order:

```markdown
# <nn> · <name>

One line: what the function decides.

Tags: ... · Hooks: viewer-request · Path: `/patterns/<name>/*`

## What it does
## Architecture        (architecture.png, drawn from the Mermaid flowchart below it by npm run diagrams)
## Sequence diagram
## The function        (link function.js; never paste its code)
## Prerequisites
## Deploy this pattern (npx cdk deploy -c patterns=<name>)
## Try it
## How it fails
## Cost
## Security
## Limits and notes
## Clean up
```

## Before you open a pull request

```sh
npm run build
npm test                    # function checks, unit tests, infra synth test
```
