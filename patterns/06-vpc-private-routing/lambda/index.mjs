// Private service behind the internal ALB for 06-vpc-private-routing.
// Reachable only through the CloudFront VPC origin; it has no public address.
//
// GET /route?tenant=<x>                        -> { tenant, backend: "blue" | "green" }
// GET /patterns/vpc-private-routing/blue/*     -> echo from the "blue" backend
// GET /patterns/vpc-private-routing/green/*    -> echo from the "green" backend
// anything else                                -> echo with backend "none" (the function did not rewrite)
export const handler = async (event) => {
  const path = event.path ?? '/';
  const query = event.queryStringParameters ?? {};
  const headers = event.headers ?? {};

  if (path === '/route') {
    const tenant = query.tenant ?? '';
    if (!tenant) return json(400, { error: 'tenant query parameter is required' });
    return json(200, { tenant, backend: backendFor(tenant) });
  }

  const backend = backendFromPath(path);
  const fromFunction = Object.fromEntries(
    Object.entries(headers).filter(([k]) => k === 'x-backend' || k === 'x-tenant' || k.startsWith('x-vpc-private-routing-')),
  );
  return json(200, { backend, path, headersFromFunction: fromFunction, at: new Date().toISOString() });
};

/** Simple, stable rule: sum of the tenant's character codes, even -> blue, odd -> green. */
export function backendFor(tenant) {
  let sum = 0;
  for (const ch of tenant) sum += ch.codePointAt(0);
  return sum % 2 === 0 ? 'blue' : 'green';
}

/** `/patterns/vpc-private-routing/blue/x` -> `blue`; anything else -> `none`. */
export function backendFromPath(path) {
  const m = /^\/patterns\/vpc-private-routing\/(blue|green)(\/|$)/.exec(path);
  return m ? m[1] : 'none';
}

// ALB Lambda-target response shape. `statusDescription` is optional and, if set,
// must read like "200 OK"; a bare "200" makes the ALB answer 502. So it is left out.
const json = (statusCode, body) => ({
  statusCode,
  isBase64Encoded: false,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body, null, 2),
});
