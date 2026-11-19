// Admission Lambda for pattern 11, run once a minute by EventBridge. Logic: admission.mjs.
import { randomBytes } from 'node:crypto';
import { BatchGetItemCommand, DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SHARDS, makeHandler } from './admission.mjs';
import { getKey, updateKeys } from './kvs.mjs';

const ddb = new DynamoDBClient({});
const TableName = process.env.TABLE_NAME;

// The counter items of one epoch, pk "e<epoch>-<shard>", attribute n. A missing item is 0.
async function getCounts(epoch) {
  const pks = Array.from({ length: SHARDS }, (_, s) => `e${epoch}-${s}`);
  const res = await ddb.send(new BatchGetItemCommand({
    RequestItems: { [TableName]: { Keys: pks.map((pk) => ({ pk: { S: pk } })), ConsistentRead: true } },
  }));
  const found = Object.fromEntries((res.Responses?.[TableName] ?? []).map((i) => [i.pk.S, Number(i.n.N)]));
  return pks.map((pk) => found[pk] ?? 0);
}

// Tickets freed with /leave: number set `freed` on pk "e<epoch>-left", which the function's beacon adds to.
async function getLeft(epoch) {
  const res = await ddb.send(new GetItemCommand({ TableName, Key: { pk: { S: `e${epoch}-left` } }, ConsistentRead: true }));
  return (res.Item?.freed?.NS ?? []).map(Number);
}

// Demo only: add simulated tickets, the same ADD n the enqueue integration does.
async function addTickets(epoch, add) {
  await Promise.all(add.flatMap((k, s) => (k > 0 ? [ddb.send(new UpdateItemCommand({
    TableName,
    Key: { pk: { S: `e${epoch}-${s}` } },
    UpdateExpression: 'ADD n :k',
    ExpressionAttributeValues: { ':k': { N: String(k) } },
  }))] : [])));
}

export const handler = makeHandler({
  getKey,
  getCounts,
  getLeft,
  updateKeys,
  randomSecret: () => randomBytes(32).toString('base64url'),
  addTickets,
  demoLine: Number(process.env.DEMO_LINE ?? 0),
  step: Number(process.env.STEP),
});
