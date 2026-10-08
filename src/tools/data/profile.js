import * as db from '../../db.js';
import * as store from '../../store/datasets.js';

export const definition = {
  type: 'function',
  name: 'get_user_profile',
  description: "Fetch the current user's profile (name, plan, joined date).",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

export async function run() {
  await db.ensureSchema();
  const [row] = await db.sql()`
    SELECT id, name, plan, joined::text AS joined FROM users WHERE id = ${db.currentUserId()}
  `;
  if (!row) return { error: 'user not found' };
  const profile = { name: row.name, plan: row.plan, joined: row.joined };
  const id = store.put('profile', profile);
  return { id, ...profile };
}
