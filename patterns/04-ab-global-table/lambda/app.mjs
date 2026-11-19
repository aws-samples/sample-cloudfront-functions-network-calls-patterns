// Origin for 04-ab-global-table, a Fastify server on a Lambda Web Function (IamAuth + OAC),
// plus the x-origin-verify secret header.
//   POST /assign/<uid>  -> assign once in DynamoDB, return { variant }; the table's stream fills KVS
//   anything else       -> echo what the CloudFront Function added (cookies are set by the viewer-response function, not here)
import { DynamoDBClient, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import Fastify from 'fastify';
import { isValidUid, newItem } from './assign.mjs';

export function buildApp(options = {}) {
  const secret = options.secret ?? process.env.ORIGIN_SECRET;
  const TableName = options.tableName ?? process.env.TABLE_NAME;
  const ddb = options.ddb ?? new DynamoDBClient({});
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook('onRequest', async (request, reply) => {
    if (!secret || request.headers['x-origin-verify'] !== secret) {
      return send(reply, 403, { error: 'missing or wrong x-origin-verify header' });
    }
  });

  app.post('/assign/:uid', async (request, reply) => {
    const { uid } = request.params;
    if (!isValidUid(uid)) return send(reply, 400, { error: 'uid must be 16 lowercase hex chars' });
    const now = Math.floor(Date.now() / 1000);
    const item = newItem(uid, now);
    let variant = item.variant.S;
    let created = true;
    try {
      // Only the FIRST writer assigns. An expired-but-not-yet-deleted item counts as absent.
      await ddb.send(new PutItemCommand({
        TableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(uid) OR #ttl < :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':now': { N: String(now) } },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }));
    } catch (e) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      created = false;
      const existing = e.Item ?? (await ddb.send(new GetItemCommand({ TableName, Key: { uid: { S: uid } }, ConsistentRead: true }))).Item;
      variant = existing?.variant?.S ?? variant;
    }

    // No KVS write here: the DynamoDB stream consumer (a plain Lambda) fills KVS from the INSERT.
    // A KVS write signed from a Lambda Web Function fails with AccessDeniedException "Authentication
    // failed" (the KVS data plane needs SigV4a), and one writer is simpler anyway.
    return send(reply, 200, { variant, uid, created });
  });

  app.all('/*', async (request, reply) => {
    const headers = request.headers;
    const fromFunction = Object.fromEntries(
      Object.entries(headers)
        .filter(([k]) => k.startsWith('x-ab-') || k === 'x-origin-verify')
        .map(([k, v]) => [k, k === 'x-origin-verify' ? '<present>' : v]),
    );
    return send(reply, 200, { path: request.url.split('?')[0], variant: headers['x-ab-variant'] ?? null, headersFromFunction: fromFunction });
  });

  return app;
}

function send(reply, statusCode, body) {
  return reply.code(statusCode)
    .header('content-type', 'application/json')
    .header('cache-control', 'no-store')
    .send(JSON.stringify(body, null, 2));
}
