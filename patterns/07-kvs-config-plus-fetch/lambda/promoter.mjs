// DynamoDB stream -> marker items and KVS writes, off the request path. See planStream in hot.mjs.
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { planStream } from './hot.mjs';
import { lookup } from './source.mjs';
import { updateKeys } from './kvs.mjs';

const ddb = new DynamoDBClient({});
const TableName = process.env.TABLE_NAME;

export const handler = async (event) => {
  const plan = planStream(event.Records ?? [], Math.floor(Date.now() / 1000), lookup);
  // A marker's own stream record is what puts the key into KVS, on a later invocation.
  for (const m of plan.markers) {
    await ddb.send(new PutItemCommand({
      TableName,
      Item: { pk: { S: m.pk }, ttl: { N: String(m.ttl) }, value: { S: m.value } },
    }));
  }
  await updateKeys(plan);
  return { markers: plan.markers.length, puts: plan.puts.length, deletes: plan.deletes.length };
};
