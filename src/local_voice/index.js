// src/local_voice/index.js — HTTP surface for the local-voice path.
//
// Three routes:
//   GET  /local/health       Ollama reachability + model presence
//   POST /local/chat         { messages?, userText } → { reply, messages, toolCalls }
//   GET  /local-voice        the browser page that drives mic + speechSynthesis
//
// State is held entirely client-side: the browser owns the conversation
// array and resends it each turn. Server is stateless beyond the
// shared in-process tool registry — this matches the cloud /tool flow.

import { chatTurn, health } from "./ollama_chat.js";
import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function mountRoutes(app) {
  app.get("/local/health", async (_req, res) => {
    const h = await health();
    res.json(h);
  });

  app.post("/local/chat", express.json({ limit: "1mb" }), async (req, res) => {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userText = typeof body.userText === "string" ? body.userText : "";
    if (!userText.trim()) return res.status(400).json({ ok: false, error: "userText required" });
    try {
      const out = await chatTurn({ messages, userText });
      res.json(out);
    } catch (err) {
      console.error("[local_voice] chat error:", err);
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // The browser page lives in public/holo_local.html so it shares the
  // existing static-asset pipeline (Cache-Control: no-store etc.). This
  // route is here purely so the URL `/local-voice` reads naturally next
  // to `/agents-grid`.
  app.get("/local-voice", (_req, res) => res.redirect("/holo_local.html"));
}
