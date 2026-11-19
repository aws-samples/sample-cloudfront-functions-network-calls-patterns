// The SQS worker's logic, with S3, KVS and the converter injected so the unit tests
// need no SDK. index.mjs wires the real clients.

// The pages function.js beacons for: .html under the pattern's path, no dots elsewhere,
// so a message can never name an object outside it.
export const PAGE = /^\/patterns\/markdown-on-demand\/[\w\/-]{1,200}\.html$/;
export const kvsKey = (uri) => 'md:' + uri;
export const markdownUri = (uri) => uri.replace(/\.html$/, '.md');

// deps: { read(key) -> string | null, write(key, markdown), putKey(key, value), deleteKey(key),
//         listKeys(prefix) -> [key], toMarkdown(html) }
// deleteKey succeeds when there is nothing to delete.
export function makeHandler(deps) {
  // A message is { uri, minute } (convert) or { action: 'reset', uri, at }.
  // Returns what happened: invalid | missing | converted | reset. Throws to retry.
  async function handleOnce(body) {
    let msg = {};
    try { msg = JSON.parse(body) || {}; } catch (e) { /* not JSON: invalid */ }
    const uri = msg.uri;
    if (typeof uri !== 'string' || !PAGE.test(uri)) return 'invalid';
    const md = markdownUri(uri);

    // Reset: the key only. Edges keep the old key for about a minute after the delete, so the
    // .md stays where they point; the next conversion overwrites it.
    if (msg.action === 'reset') {
      await deps.deleteKey(kvsKey(uri));
      return 'reset';
    }

    // Every convert message converts and overwrites: the FIFO queue already makes a burst one
    // message a minute, and after a reset the page may have changed.
    const html = await deps.read(uri.slice(1));
    if (html === null) return 'missing'; // an agent asked for a page that does not exist
    await deps.write(md.slice(1), deps.toMarkdown(html));
    // Last: function.js serves markdown only once this key reaches the edge.
    await deps.putKey(kvsKey(uri), md);
    return 'converted';
  }

  // The hourly sweep: every md:<page> key, so the demo starts over on its own. The .md
  // files stay, for the same reason as a reset. The store is shared with other patterns:
  // only keys for this pattern's pages.
  async function sweep() {
    const keys = (await deps.listKeys('md:')).filter((k) => PAGE.test(k.slice(3)));
    for (let i = 0; i < keys.length; i++) await deps.deleteKey(keys[i]);
    console.log(JSON.stringify({ sweep: { keys: keys.length } }));
    return { keys: keys.length };
  }

  // The page URI of a message, only once it passes the same check the handler applies.
  const pageOf = (body) => {
    try {
      const { uri } = JSON.parse(body);
      return typeof uri === 'string' && PAGE.test(uri) ? uri : undefined;
    } catch {
      return undefined;
    }
  };

  // FIFO + ReportBatchItemFailures: on the first failure, hand back it and everything after it.
  // The EventBridge schedule has no Records: that is the sweep.
  return async function handler(event) {
    if (!event.Records) return sweep();
    const records = event.Records;
    for (let i = 0; i < records.length; i++) {
      try {
        const result = await handleOnce(records[i].body);
        // Metadata only, never the raw body: part of it comes from the viewer (the reset page name).
        console.log(JSON.stringify({ messageId: records[i].messageId, result, uri: pageOf(records[i].body) }));
      } catch (e) {
        console.log(JSON.stringify({ messageId: records[i].messageId, error: e.name + ': ' + e.message }));
        return { batchItemFailures: records.slice(i).map((r) => ({ itemIdentifier: r.messageId })) };
      }
    }
    return { batchItemFailures: [] };
  };
}
