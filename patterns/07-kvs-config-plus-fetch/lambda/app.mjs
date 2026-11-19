// Origin for 07-kvs-config-plus-fetch, a Fastify server on a Lambda Web Function (IamAuth + OAC).
//   GET /config/<key> -> the key's config, and one more hit on the key's counter
//   anything else     -> echo the x-config-* headers the CloudFront Function added
// Counting is all it does for promotion: promoter.mjs reads the counters off the table's stream.
import Fastify from 'fastify';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { THRESHOLD, counterItem, isValidKey } from './hot.mjs';
import { lookup } from './source.mjs';

// Module scope: created once per execution environment, so warm requests reuse its connections.
const defaultDdb = new DynamoDBClient({});

export function buildApp(options = {}) {
  const ddb = options.ddb ?? defaultDdb;
  const TableName = options.tableName ?? process.env.TABLE_NAME;
  const app = Fastify({ logger: options.logger ?? false });

  const json = (reply, statusCode, body) => reply
    .code(statusCode)
    .header('content-type', 'application/json')
    .header('cache-control', 'no-store')
    .send(Buffer.from(JSON.stringify(body, null, 2))); // a Buffer, so Fastify adds no charset

  const echo = (request, reply) => {
    const headersFromFunction = Object.fromEntries(
      Object.entries(request.headers).filter(([k]) => k.startsWith('x-config')));
    return json(reply, 200, { path: request.url.split('?')[0], headersFromFunction });
  };

  app.get('/config/:key', async (request, reply) => {
    const { key } = request.params;
    if (key === '') return echo(request, reply); // /config/ with no key is not a config read
    if (!isValidKey(key)) return json(reply, 400, { error: 'key must be 1-32 characters of a-z, 0-9 and -' });
    let hits = null;
    try {
      const { pk, ttl } = counterItem(key, Math.floor(Date.now() / 1000));
      const res = await ddb.send(new UpdateItemCommand({
        TableName,
        Key: { pk: { S: pk } },
        UpdateExpression: 'ADD hits :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': { N: '1' }, ':ttl': { N: String(ttl) } },
        ReturnValues: 'UPDATED_NEW',
      }));
      hits = Number(res.Attributes.hits.N);
    } catch (e) {
      // The config is still served; this read just is not counted.
      request.log.error({ err: e }, 'counter update failed');
    }
    return json(reply, 200, { config: lookup(key), hits, threshold: THRESHOLD });
  });

  app.all('/*', async (request, reply) => echo(request, reply));

  return app;
}
