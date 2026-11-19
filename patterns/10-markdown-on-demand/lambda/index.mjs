// SQS worker for pattern 10: one message per page an agent asked for, { "uri": "/patterns/..." }.
// Reads the HTML from the pattern's bucket, writes <page>.md next to it, then sets md:<uri> in KVS.
// A reset message deletes the key; the hourly EventBridge schedule deletes all of them.
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import '@aws-sdk/signature-v4a'; // registers the pure-JS SigV4a signer the KVS data plane requires
import {
  CloudFrontKeyValueStoreClient, DeleteKeyCommand, DescribeKeyValueStoreCommand, ListKeysCommand, PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { toMarkdown } from './convert.mjs';
import { makeHandler } from './worker.mjs';

const s3 = new S3Client({});
const kvs = new CloudFrontKeyValueStoreClient({});
const Bucket = process.env.BUCKET_NAME;
const KvsARN = process.env.KVS_ARN; // the shared store, passed in by pattern.ts

const notFound = (e) => e.name === 'NotFound' || e.name === 'NoSuchKey';

// Every KVS write carries the store's current ETag; a stale one is rejected, so re-read and retry once.
async function withETag(command, missingIsDone = false) {
  for (let attempt = 0; ; attempt++) {
    const { ETag } = await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN }));
    try {
      await kvs.send(command(ETag));
      return;
    } catch (e) {
      if (missingIsDone && e.name === 'ResourceNotFoundException') return; // DeleteKey: already gone
      if (attempt >= 1) throw e;
    }
  }
}

export const handler = makeHandler({
  async read(Key) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket, Key }));
      return await res.Body.transformToString('utf-8');
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  },
  async write(Key, markdown) {
    await s3.send(new PutObjectCommand({ Bucket, Key, Body: markdown, ContentType: 'text/markdown; charset=utf-8' }));
  },
  putKey: (Key, Value) => withETag((IfMatch) => new PutKeyCommand({ KvsARN, Key, Value, IfMatch })),
  deleteKey: (Key) => withETag((IfMatch) => new DeleteKeyCommand({ KvsARN, Key, IfMatch }), true),
  async listKeys(prefix) {
    const keys = [];
    let NextToken;
    do {
      const res = await kvs.send(new ListKeysCommand({ KvsARN, NextToken }));
      for (const item of res.Items || []) if (item.Key.startsWith(prefix)) keys.push(item.Key);
      NextToken = res.NextToken;
    } while (NextToken);
    return keys;
  },
  toMarkdown,
});
