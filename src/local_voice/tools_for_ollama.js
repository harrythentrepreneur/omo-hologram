// src/local_voice/tools_for_ollama.js — adapt omo's tool registry to
// the Ollama / OpenAI-style nested function-call schema.
//
// omo's TOOLS constant ships in the flattened Gemini form
//   { type: "function", name, description, parameters }
// because GEMINI_FUNCTION_DECLARATIONS strips the outer wrapper that
// Gemini Live doesn't want. Ollama (and most local tool-calling models
// trained against the OpenAI schema) DO want the wrapper:
//   { type: "function", function: { name, description, parameters } }
// So we re-wrap here and re-export. We also re-export MOMO_INSTRUCTIONS
// so the local-voice module has a single place to grab everything.

import { TOOLS as FLAT_TOOLS } from "../tools/index.js";
import { MOMO_INSTRUCTIONS as FULL_INSTRUCTIONS } from "../session.js";

export const TOOLS = FLAT_TOOLS.map((def) => {
  // Already nested — leave it alone (defensive in case someone adds a
  // tool that already exports the OpenAI shape).
  if (def && def.function && def.function.name) {
    return { type: "function", function: def.function };
  }
  const { type: _t, name, description, parameters } = def || {};
  return {
    type: "function",
    function: {
      name,
      description: description || "",
      parameters: parameters || { type: "object", properties: {}, additionalProperties: false },
    },
  };
});

// We keep the exact persona for the local path so behaviour matches the
// cloud Gemini path — same voice, same rules, same tool contract. Append
// a small note that we're running locally so the model can shorten its
// replies for voice latency if it wants.
export const MOMO_INSTRUCTIONS = `${FULL_INSTRUCTIONS}

──
LOCAL VOICE MODE: You are running on a local model with text-in / text-out. Keep replies SHORT (1-3 sentences) since they will be spoken aloud by the browser's TTS. Save long detail for cards (call viz / a card tool) rather than narrating.`;
