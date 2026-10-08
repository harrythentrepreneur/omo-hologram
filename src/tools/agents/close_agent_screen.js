// src/tools/close_agent_screen.js
//
// Voice tool: dismiss the agent monitor on /squad. Broadcasts a
// `ui_close_screen` event; the squad page calls closeMonitor().

import * as hermes from "../../hermes/index.js";

export const definition = {
  type: "function",
  name: "close_agent_screen",
  description:
    "Close the floating agent monitor on /squad. Use when the user wants to dismiss the screen — e.g. 'close that', 'dismiss the screen', '关掉', '收起来', 'hide it', 'I'm done looking'. The agent keeps running underneath; you're only hiding the UI.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

export async function run() {
  try {
    hermes.broadcast({ type: "ui_close_screen", ts: Date.now() });
  } catch (err) {
    return {
      error: String(err?.message || err),
      note: "Could not close the screen — quote the error plainly.",
    };
  }
  return {
    ok: true,
    note:
      "Say one short cute line in the SAME language the user just used, like '好嘞~ 收起来啦~' or 'closed it ✨'. One sentence only.",
  };
}
