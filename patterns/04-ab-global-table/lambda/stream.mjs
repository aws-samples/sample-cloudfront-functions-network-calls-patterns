// DynamoDB stream -> KVS. INSERT fills the key, MODIFY rewrites it, REMOVE evicts it. See plan.mjs.
import { planChanges } from './plan.mjs';
import { updateKeys } from './kvs.mjs';

export const handler = async (event) => {
  const plan = planChanges(event.Records ?? []);
  await updateKeys(plan);
  return { puts: plan.puts.length, deletes: plan.deletes.length };
};
