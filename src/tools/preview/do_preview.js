// src/tools/do_preview.js — compound multi-step voice operations.
//
// One tool call → a sequence of bridge commands. The classic use:
//   "fill in the email and password and submit"
//     →  click email field
//        type "user@example.com"
//        click password field
//        type "secret"
//        click submit
//
// Each step is shaped the same as a single-shot tool ({action, target,
// text, ...}). We fire serially via the same bus + ack pipeline so each
// step reflects the bridge's truthful reply. On the first failure we
// halt — the rest of the sequence likely depends on the failed step
// (you can't submit a form you didn't fill).
//
// Optional "wait" action lets compound flows pause between steps for
// transitions / animations / async-loaded targets.

import { dispatch } from '../../preview/dispatch.js';

// What an individual step can do. Mirrors the single-shot tools so the
// model doesn't need a separate mental model.
const STEP_ACTIONS = new Set([
  'click', 'type', 'submit', 'focus',         // interact_preview
  'scroll',                                    // scroll_preview
  'navigate',                                  // navigate_preview
  'wait',                                      // compound-only: pause between steps
]);

// Per-action timeout. Navigate gets less (browser unloads almost
// instantly), describe-like commands aren't valid here, the rest get
// the default. Compound steps need slightly tighter caps than single
// shots because the user is waiting for ALL of them to finish.
function timeoutFor(action) {
  if (action === 'navigate') return 2000;
  if (action === 'wait')     return 6000;   // covers the 5s bridge clamp + slack
  return 3000;
}

// Translate a step's shape into a bridge command envelope. Drops keys
// the bridge doesn't recognise so we don't leak the model's hallucinated
// extras.
function envelopeFor(step) {
  const { action } = step;
  const env = { command: action };
  // Whitelist per-action so future bridge changes are explicit.
  switch (action) {
    case 'click':
    case 'focus':
      if (step.target) env.target = String(step.target);
      if (step.index)  env.index  = Number(step.index) || undefined;
      break;
    case 'type':
      if (step.text != null) env.text = String(step.text);
      if (step.target)       env.target = String(step.target);
      if (step.replace != null) env.replace = !!step.replace;
      if (step.submit != null)  env.submit  = !!step.submit;
      break;
    case 'submit':
      // no args
      break;
    case 'scroll':
      if (step.direction) env.direction = String(step.direction);
      if (step.to)        env.to = String(step.to);
      if (step.amount)    env.amount = Number(step.amount) || undefined;
      break;
    case 'navigate':
      if (step.path)   env.path = String(step.path);
      if (step.url)    env.url  = String(step.url);
      if (step.action_kind) env.action = String(step.action_kind);
      break;
    case 'wait':
      env.ms = Math.max(50, Math.min(5000, Number(step.ms) || 400));
      break;
  }
  return env;
}

function summariseStep(step, result) {
  // One-liner per step suitable for the spoken summary at the end.
  const a = step.action;
  const ok = result?.ok !== false;
  const what =
    a === 'click'    ? `click "${step.target || '?'}"` :
    a === 'type'     ? `type into "${step.target || 'focused'}"` :
    a === 'submit'   ? 'submit form' :
    a === 'focus'    ? `focus "${step.target || '?'}"` :
    a === 'scroll'   ? (step.to ? `scroll to "${step.to}"` : `scroll ${step.direction || 'down'}`) :
    a === 'navigate' ? (step.path || step.url || step.action_kind || 'navigate') :
    a === 'wait'     ? `wait ${result?.id ? '' : ''}` :
                       a;
  if (ok) return `✓ ${what}`;
  return `✗ ${what} — ${result?.error || 'failed'}`;
}

export const definition = {
  type: 'function',
  name: 'do_preview',
  description:
    "Run a SEQUENCE of voice actions on the preview as one atomic flow. Use when the user describes a multi-step intent: \"sign in with my email and password\", \"fill out the contact form\", \"scroll to pricing then click upgrade\", \"打开 squad 然后点 Nimbus\". Each step is shaped like the single-shot tools (click/type/submit/focus/scroll/navigate) plus a 'wait' action for pauses. Steps fire serially and the sequence STOPS at the first failure (so omo can ask the user how to recover). Returns the full step-by-step outcome.",
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: "Ordered steps. Each {action, ...args}. Actions: 'click' {target, index?}; 'type' {text, target?, replace?, submit?}; 'submit'; 'focus' {target}; 'scroll' {direction? to? amount?}; 'navigate' {path? url? action_kind: 'back'|'forward'|'reload'}; 'wait' {ms: 50-5000}. Aim for 2-6 steps per call; longer flows are usually better split into two calls so the user can intervene between them.",
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['click', 'type', 'submit', 'focus', 'scroll', 'navigate', 'wait'] },
            target: { type: 'string' },
            text:   { type: 'string' },
            index:  { type: 'integer', minimum: 1 },
            replace: { type: 'boolean' },
            submit:  { type: 'boolean' },
            direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
            to:        { type: 'string' },
            amount:    { type: 'integer', minimum: 10 },
            path:      { type: 'string' },
            url:       { type: 'string' },
            action_kind: { type: 'string', enum: ['back', 'forward', 'reload'] },
            ms:        { type: 'integer', minimum: 50, maximum: 5000 },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
      continue_on_error: {
        type: 'boolean',
        description: "By default the sequence halts on the first failed step. Set true to run every step regardless (rarely the right call — usually you WANT to know step 2 missed before pressing step 3).",
      },
    },
    required: ['steps'],
    additionalProperties: false,
  },
};

export async function run(args = {}) {
  const stepsIn = Array.isArray(args.steps) ? args.steps : [];
  if (stepsIn.length === 0) return { ok: false, error: 'steps is required (and must be non-empty)' };

  const continueOnError = !!args.continue_on_error;
  const results = [];
  let stoppedAt = null;

  for (let i = 0; i < stepsIn.length; i++) {
    const step = stepsIn[i];
    if (!step || !STEP_ACTIONS.has(step.action)) {
      results.push({
        index: i,
        action: step?.action || null,
        ok: false,
        error: 'unknown_action',
        message: `step ${i + 1}: action "${step?.action}" isn't supported (use ${[...STEP_ACTIONS].join(', ')}).`,
      });
      if (!continueOnError) { stoppedAt = i; break; }
      continue;
    }
    const env = envelopeFor(step);
    const result = await dispatch(env, { timeoutMs: timeoutFor(step.action) });
    results.push({
      index: i,
      action: step.action,
      ok: !!result?.ok,
      result: result?.result ?? null,
      error: result?.ok ? null : (result?.error || 'failed'),
      message: result?.message ?? undefined,
      suggestions: result?.suggestions ?? undefined,
    });
    if (!result?.ok && !continueOnError) {
      stoppedAt = i;
      break;
    }
    // Small inter-step settle so DOM updates land before the next match
    // pass. Skip after explicit 'wait' steps (they already paused).
    if (i < stepsIn.length - 1 && step.action !== 'wait') {
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const totalCount = results.length;
  const summary = results.map((r) => summariseStep(stepsIn[r.index], r)).join('\n');

  return {
    ok: stoppedAt == null,
    steps: results,
    stopped_at: stoppedAt,
    summary,
    note:
      stoppedAt == null
        ? `All ${okCount} step${okCount === 1 ? '' : 's'} succeeded. Confirm in one short cute line; don't recite each step unless the user asks.`
        : `Stopped at step ${stoppedAt + 1} of ${stepsIn.length}: ${results[stoppedAt]?.error || 'unknown'}. Tell the user where it stopped and what went wrong — if the failed step has \`suggestions\`, offer those. Don't claim later steps happened.`,
  };
}
