// introduce_agent — Momo spins up a companion sub-agent and materializes
// it orbiting beside her so the user can SEE that help has arrived.
// The companion is a small holographic avatar with its own name, role,
// and personality; when the sub-agent speaks, its mouth drives from
// its own audio analyser (future: the sub-agent gets its own Gemini
// Live session; for now the client fakes the analyser from the parent
// session's audio so the visual beat still lands).
//
// This tool just allocates the projectable — the actual sub-agent
// runtime (separate voice channel, separate tool belt) would be a
// follow-on. What this delivers today: the visual flourish.

import * as projectables from '../../store/projectables.js';

const VALID_ROLES = new Set([
  'analyst',     // data crunch companion (cyan, crystal avatar)
  'courier',     // inbound / notifications (pink accent)
  'scribe',      // drafting / composition helper (white-accented)
  'generic',
]);

const MAX_NAME_LEN = 20;
const MAX_GREETING_LEN = 120;

// Where the companion orbits relative to Momo, in avatar-local radians.
// 0 = directly in front; positive = to her right from the user's view.
// Two slots so two introductions don't overlap.
const SLOTS = ['left', 'right'];

export const definition = {
  type: 'function',
  name: 'introduce_agent',
  description:
    'Spin up a companion sub-agent and materialize it orbiting next to you. Use when a task warrants a specialist: spinning up an analyst to crunch a complex dataset, a courier to watch for inbound emails, etc. The companion has its own name and role and visibly appears beside you. Keep it rare — one at a time reads best.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: `Companion short name, ≤${MAX_NAME_LEN} chars (e.g. "Ani", "Kit", "小书"). omo references this when talking to the user.`,
      },
      role: {
        type: 'string',
        enum: ['analyst', 'courier', 'scribe', 'generic'],
        description: 'Companion specialty — picks palette + avatar silhouette. analyst=cyan crystal, courier=pink orb, scribe=white-accented.',
      },
      greeting: {
        type: 'string',
        description: `Optional one-liner omo narrates alongside the entrance (≤${MAX_GREETING_LEN} chars). Kept short; the visual beat does most of the work.`,
      },
      slot: {
        type: 'string',
        enum: ['left', 'right'],
        description: 'Which side of omo the companion materializes on. Default "right".',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

export async function run(args) {
  const name = String(args?.name || '').trim().slice(0, MAX_NAME_LEN);
  if (!name) return { error: 'name is required' };

  const roleRaw = String(args?.role || 'generic').trim();
  const role = VALID_ROLES.has(roleRaw) ? roleRaw : 'generic';
  const greeting = String(args?.greeting || '').trim().slice(0, MAX_GREETING_LEN);
  const slot = SLOTS.includes(args?.slot) ? args.slot : 'right';

  const projectable_id = projectables.put('agent', {
    meta: { name, role, greeting, slot },
  });

  return {
    projectable_id,
    kind: 'agent',
    name,
    role,
    greeting: greeting || null,
    slot,
    note: 'Companion has materialized beside you. Narrate the intro in one short cute sentence if you set a greeting.',
  };
}

// Shared so the client-side agent.js can read the same slot definitions.
export { SLOTS };
