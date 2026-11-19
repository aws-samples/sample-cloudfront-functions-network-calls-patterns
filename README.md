# CloudFront Functions network-call patterns

> **Sample code, not for production use.** These patterns show an idea at the edge; review, test and harden them
> (authentication, encryption in transit, logging, limits, cost) before you use any part of them in production.

Small, deployable patterns where a CloudFront Function makes **one network call** (`cf.fetch` or `cf.beacon`) to an
origin on its own distribution, then decides what happens to the viewer request or response.

These are patterns to spark ideas, not a complete catalog or a product. Each one shows a way to use the network call as a
live decision layer at the edge: on **viewer request**, before the cache and the origin, and on **viewer response**, on
the way back to the viewer. Take one as a starting point for your own use case. New patterns are added over time; see
[CONTRIBUTING](CONTRIBUTING.md) to add one.

## Why

A network call lets a CloudFront Function ask a live service on every request, at the edge and before the cache, without
moving to Lambda@Edge: authorize an AI agent or an API call right now, ask a bot-management service, hold a launch crowd
in a waiting room, or route, configure, log and fail over on live data. Use a KeyValueStore (KVS) when the data is static
or changes rarely; use a network call when the answer must be current. A function can do both.

## Patterns

| # | Pattern | What the function decides | Fails |
|---|---|---|---|
| 00 | [hello-fetch](patterns/00-hello-fetch/) | Nothing: the smallest round trip, one JSON field copied into a header | open |
| 01 | [cognito-auth](patterns/01-cognito-auth/) | Is this Cognito access token valid? Forward with `x-user-sub`, or 401 | closed |
| 02 | [authorizer-headers](patterns/02-authorizer-headers/) | Allow or deny, and which identity headers (`x-tenant`, `x-role`) the origin gets | closed |
| 03 | [bot-check-fail-open](patterns/03-bot-check-fail-open/) | Bot or human, failing open past the 1 s timeout; block or tag by a KVS policy | open |
| 04 | [ab-global-table](patterns/04-ab-global-table/) | Which sticky A/B variant a user gets; calls only on a KVS miss | open (`control`) |
| 05 | [edge-signal-sqs](patterns/05-edge-signal-sqs/) | Nothing: fire-and-forget an event into SQS with `cf.beacon` | open |
| 06 | [vpc-private-routing](patterns/06-vpc-private-routing/) | Which private backend a tenant belongs to, asked of an internal ALB | open |
| 07 | [kvs-config-plus-fetch](patterns/07-kvs-config-plus-fetch/) | Which config applies to a key: KVS first, one call on a miss, hot keys promoted to KVS | open |
| 08 | [origin-health-fallback](patterns/08-origin-health-fallback/) | Is the primary healthy? If not, send the POST to a secondary | open (primary) |
| 09 | [agent-authz](patterns/09-agent-authz/) | May this AI agent read or write this resource right now? Forward, or 401 / 403 | closed |
| 10 | [markdown-on-demand](patterns/10-markdown-on-demand/) | Is there a markdown copy of this page for this AI agent? Serve it, or serve the HTML and `cf.beacon` a conversion job | open (HTML) |
| 11 | [edge-waiting-room](patterns/11-edge-waiting-room/) | May this viewer in yet? One call draws a ticket, then a signed cookie is compared with a KVS watermark; no call while waiting | closed |

## Full solutions built on these ideas

Two standalone samples take a pattern further, each in its own repository:

| Sample | What it adds | Related pattern |
|---|---|---|
| [Automated format conversion for AI agents](https://github.com/aws-samples/sample-automated-markdowns-for-agents-using-cloudfront-and-waf) | AWS WAF detects AI agents and CloudFront serves them a generated markdown copy of each page, with the generation pipeline and a dashboard | [10](patterns/10-markdown-on-demand/) |
| [AI maze](https://github.com/arditti/sample-cloudfront-waf-ai-agents-maze) | AWS WAF Bot Control flags unwanted AI crawlers and a CloudFront Function serves model-generated decoy pages in place, with read-back beacons | none: a decoy maze |

## What is in each pattern folder

Every pattern is self-contained in `patterns/<nn>-<name>/`. Start with its README:

| File | What it is |
|---|---|
| `README.md` | What it does, the architecture diagram, the sequence of calls, how to deploy and try it, how it fails, cost, security, limits and clean-up |
| `architecture.png` | The architecture diagram, drawn from the Mermaid flowchart in the README |
| `function.js` | The CloudFront Function (viewer request); `response-function.js` when the pattern also runs on viewer response |
| `pattern.ts` | The pattern's CDK code: its origin, backend and cache behavior |
| `lambda/` | The origin or backend code, when the pattern has one |
| `test/` or `*.test.mjs` | Unit tests for the function and the backend (`npm test` runs them all) |

Also: [anti-patterns](patterns/ANTI-PATTERNS.md) and the [network call API](docs/api.md).

## Quickstart

You need Node.js 22+, AWS credentials for an account, and Docker or npm for Lambda bundling. Everything deploys to
`us-east-1`.

```sh
npm ci
npx cdk bootstrap aws://<account-id>/us-east-1
npm run deploy
```

`npm run deploy` runs `cdk deploy`: one stack with one CloudFront distribution and one cache behavior per pattern under
`/patterns/<name>/*`. To deploy only some patterns, name them: `npx cdk deploy -c patterns=hello-fetch,agent-authz`. Then try a pattern with the `DistributionDomain` output:

```sh
curl -s https://<distribution domain>/patterns/hello-fetch/
```

Each pattern README has its own **Deploy this pattern**, **Try it** and **Clean up** sections. Deploy details, the KVS keys and tear-down for the whole stack are in [docs/deploy.md](docs/deploy.md).

## Limits

One network call per invocation, a fixed 1 s timeout, a target that is an origin on the same distribution, and 10 KB
bodies. The full list, the options, the response object and the errors are in [docs/api.md](docs/api.md).

## Learn more

- [docs/api.md](docs/api.md): the `cf.fetch` and `cf.beacon` API as these patterns use it
- [docs/deploy.md](docs/deploy.md): architecture, deploy, KVS keys, tests, tear down
- [docs/ai-workloads.md](docs/ai-workloads.md): the patterns in front of model endpoints, LLM proxies and MCP servers
- [patterns/ANTI-PATTERNS.md](patterns/ANTI-PATTERNS.md): what a network call looks able to do and should not
- [CloudFront Functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.html) and
  [KeyValueStore](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html) in the
  CloudFront Developer Guide

## Contributing

See [docs/adding-a-pattern.md](docs/adding-a-pattern.md) to add a pattern and [CONTRIBUTING](CONTRIBUTING.md) for pull requests. Report security issues as described in [SECURITY](SECURITY.md).

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
