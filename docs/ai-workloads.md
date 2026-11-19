# Network calls in front of AI workloads

The CloudFront Function that already sits in front of a model endpoint, an LLM proxy or an MCP server can make one network
call per request and decide before the origin is reached. That makes it a small AI gateway at the edge. Every pattern tagged
`ai-gateway` has an **AI angle** in its README.

| Angle | Pattern |
|---|---|
| Bearer-token gate in front of an MCP server or model API | [01](../patterns/01-cognito-auth/) |
| Identity to model tier, allowed models and quota class, injected as trusted headers | [02](../patterns/02-authorizer-headers/) |
| Classify AI crawlers and agent traffic before an expensive endpoint, fail open | [03](../patterns/03-bot-check-fail-open/) |
| Sticky, globally consistent assignment of users to a model or prompt version | [04](../patterns/04-ab-global-table/) |
| Request telemetry for AI endpoints (path and identity only) | [05](../patterns/05-edge-signal-sqs/) |
| Tenant to a private model endpoint inside the VPC | [06](../patterns/06-vpc-private-routing/) |
| Per-tenant model route and quota, hot tenants served from KVS, the long tail read through | [07](../patterns/07-kvs-config-plus-fetch/) |
| Failover for POST inference calls | [08](../patterns/08-origin-health-fallback/) |

## What the function cannot do

**It cannot read the request body.** Nothing here is prompt-aware: no moderation, no guardrails, no token counting. Those
belong to Lambda@Edge or the origin (see [anti-patterns](../patterns/ANTI-PATTERNS.md)). The function decides from the
method, path, query string, headers and cookies.

## AI workloads are POST

Inference, chat completions, embeddings, MCP `tools/call`: almost every AI request is a POST, and three things CloudFront
does for GET stop applying:

- POST responses are not cached, so every request reaches the endpoint.
- Origin groups, static or built at runtime with `cf.createRequestOriginGroup`, fail over only GET, HEAD and OPTIONS.
- Viewer-response functions do not run when the origin returns 400 or higher, so nothing can repair the answer afterwards.

The viewer-request function is the only place to decide before the request is sent, and one network call (a health probe,
an authorizer, a routing lookup) lets it decide with live information. [08](../patterns/08-origin-health-fallback/) is that
story end to end.
