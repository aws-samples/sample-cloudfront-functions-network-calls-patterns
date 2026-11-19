// The one place that writes to the foundation KVS. Same as patterns/04-ab-global-table/lambda/kvs.mjs.
import '@aws-sdk/signature-v4a'; // registers the pure-JS SigV4a signer the KVS data plane requires
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';

const kvs = new CloudFrontKeyValueStoreClient({});
const KvsARN = process.env.KVS_ARN; // the shared store, passed in by pattern.ts

// Puts and deletes in one call. Every KVS write must carry the store's current
// ETag; a stale one is rejected, so re-read the ETag and retry exactly once.
export async function updateKeys({ puts = [], deletes = [] }) {
  if (puts.length === 0 && deletes.length === 0) return;
  for (let attempt = 0; ; attempt++) {
    const { ETag } = await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN }));
    try {
      await kvs.send(new UpdateKeysCommand({
        KvsARN,
        IfMatch: ETag,
        Puts: puts.map(({ key, value }) => ({ Key: key, Value: value })),
        Deletes: deletes.map(({ key }) => ({ Key: key })),
      }));
      return;
    } catch (e) {
      if (attempt >= 1) throw e;
    }
  }
}
