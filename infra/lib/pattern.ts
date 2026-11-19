import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

/** Shared resources a pattern may use from its `origin()` hook. */
export interface PatternContext {
  /** The one shared KeyValueStore (owned by FoundationStack). `keyValueStore.keyValueStoreArn` is the ARN. */
  readonly keyValueStore: cloudfront.IKeyValueStore;
}

/** An origin the function calls via `cf.fetch` but viewers never reach: on the distribution, no cache behavior. */
export interface ExtraOrigin {
  /** Exact CloudFront origin id (what the function passes as `originId` / `origin`). The origin MUST be created with `originId: id`. */
  readonly id: string;
  readonly origin: cloudfront.IOrigin;
}

/**
 * A cache behavior of its own, inside the pattern's path, that the pattern's function does NOT run on:
 * a demo-only helper route (01's token route). It takes precedence over `behaviorPath(pattern)`.
 */
export interface ExtraBehavior {
  /** Exact path, under `/patterns/<pattern id>/`. */
  readonly path: string;
  /** Exact CloudFront origin id. The origin MUST be created with `originId: id`. */
  readonly id: string;
  readonly origin: cloudfront.IOrigin;
}

/**
 * The contract every pattern folder fulfils.
 *
 * A pattern lives in `patterns/<nn>-<name>/` and exports `pattern: Pattern`
 * from its `pattern.ts`. Nothing else in the repo needs to change to add one.
 */
export interface Pattern {
  /** Short name, e.g. `hello-fetch`. Doubles as the CloudFront origin id the function passes to `cf.fetch`. */
  readonly id: string;
  /** Absolute path of the CloudFront Function source (runtime 2.0, viewer-request). */
  readonly functionCode: string;
  /**
   * Optional absolute path of a second CloudFront Function source (runtime 2.0) attached
   * to the same cache behavior as `viewer-response`. A request and its response are two
   * executions, so a pattern gets one `cf.fetch` on the way in and one on the way out.
   * Shares the `keyValueStore` association with the request function.
   */
  readonly responseFunctionCode?: string;
  /**
   * Create the pattern's backing resources (Lambda, API, table...) and return
   * the origin the distribution should call. `scope` is a construct named after the pattern.
   * `ctx` carries the shared KVS for backends that read or write it.
   * The returned origin MUST use `originId: pattern.id`.
   */
  origin(scope: Construct, ctx: PatternContext): cloudfront.IOrigin;
  /**
   * Optional additional origins for `cf.fetch` targets that are NOT behind this
   * pattern's behavior (e.g. an identity provider the function calls while viewers
   * hit a separate backend). Each is added to the distribution as a standalone
   * origin with exactly `id` as its origin id and no cache behavior.
   */
  extraOrigins?(scope: Construct, ctx: PatternContext): ExtraOrigin[];
  /**
   * Optional helper routes with their own cache behavior and origin, and no function (see
   * `ExtraBehavior`). No caching, GET and HEAD only.
   */
  extraBehaviors?(scope: Construct, ctx: PatternContext): ExtraBehavior[];
  /**
   * Set to `true` to associate the shared KeyValueStore with this pattern's
   * CloudFront Function (`import kvs from 'cloudfront/kvs'` then works).
   */
  readonly keyValueStore?: boolean;
  /**
   * Optional AWS WAF rules for the distribution's shared web ACL (default action Allow), which
   * exists only when some pattern returns rules. Scope every rule down to `behaviorPath(pattern)`
   * so other patterns are unaffected. Priorities are assigned in pattern order; leave them 0.
   */
  webAclRules?(): wafv2.CfnWebACL.RuleProperty[];
  /**
   * Set to `true` for AWS WAF Bot Control labels (common level, count) on this pattern's path.
   * The shared web ACL runs ONE Bot Control rule group, first, scoped to every pattern that asks,
   * so this pattern's `webAclRules` can match its labels.
   */
  readonly botControl?: boolean;
  /**
   * Optional overrides for the cache behavior. Defaults: no caching, forward everything, and the shared
   * Server-Timing response headers policy. A `responseHeadersPolicy` of your own must be a
   * `cloudfront.ResponseHeadersPolicy` you create; Server-Timing is merged into it.
   */
  readonly behavior?: Partial<cloudfront.AddBehaviorOptions>;
}

export const PATTERNS_DIR = path.resolve(__dirname, '..', '..', 'patterns');

/** Path pattern of a pattern's cache behavior on the shared distribution. */
export function behaviorPath(p: Pattern): string {
  return `/patterns/${p.id}/*`;
}

/**
 * Discover every `patterns/<nn>-<name>/pattern.ts`, sorted by folder name. `only` (a comma-separated
 * list of pattern ids) keeps just those; an id with no folder is an error.
 */
export function loadPatterns(only?: string): Pattern[] {
  const all = loadAllPatterns();
  if (only === undefined || only === '') return all;
  const wanted = String(only).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !all.some((p) => p.id === id));
  if (unknown.length) throw new Error(`unknown pattern(s): ${unknown.join(', ')} (known: ${all.map((p) => p.id).join(', ')})`);
  return all.filter((p) => wanted.includes(p.id));
}

function loadAllPatterns(): Pattern[] {
  if (!fs.existsSync(PATTERNS_DIR)) return [];
  const folders = fs
    .readdirSync(PATTERNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{2}-[a-z0-9-]+$/.test(d.name))
    .map((d) => d.name)
    .sort();

  const patterns: Pattern[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const file = path.join(PATTERNS_DIR, folder, 'pattern.ts');
    if (!fs.existsSync(file)) continue;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as { pattern?: Pattern };
    const p = mod.pattern;
    if (!p) throw new Error(`${file} must export \`pattern\``);
    const expectedId = folder.replace(/^\d{2}-/, '');
    if (p.id !== expectedId) throw new Error(`${file}: id "${p.id}" must equal folder name without prefix ("${expectedId}")`);
    if (seen.has(p.id)) throw new Error(`duplicate pattern id "${p.id}"`);
    seen.add(p.id);
    patterns.push(p);
  }
  return patterns;
}
