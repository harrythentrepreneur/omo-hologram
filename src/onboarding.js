// Onboarding (welcome flow) backend.
//
// Aggregates connector status into a single readiness payload the
// /welcome page polls, plus per-account management endpoints for the
// multi-account Google token store.

import express from 'express';

export function mountRoutes(app, deps) {
  const {
    google,
    gmailConnector,
    googleDrive,
    googleDocs,
    stripeConnector,
    metaConnector,
  } = deps || {};

  app.get('/omo/api/onboarding/state', (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(buildState({ google, gmailConnector, googleDrive, stripeConnector, metaConnector }));
    } catch (err) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/omo/api/onboarding/google/accounts/remove', express.json(), async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim();
      if (!email) return res.status(400).json({ ok: false, error: 'email required' });

      const before = google.listAccounts();
      const exists = before.some((a) => sameEmail(a.email, email));
      if (!exists) return res.status(404).json({ ok: false, error: 'account not found' });
      const wasPrimary = before.find((a) => sameEmail(a.email, email))?.primary === true;

      const result = google.removeAccount(email);
      if (wasPrimary) {
        await reconnectGoogleConnectors({ gmailConnector, googleDrive, googleDocs, emit: deps.emit });
      }
      res.json({
        ok: true,
        promoted: result?.promoted || null,
        accounts: google.listAccounts(),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  app.post('/omo/api/onboarding/google/accounts/primary', express.json(), async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim();
      if (!email) return res.status(400).json({ ok: false, error: 'email required' });
      const accounts = google.listAccounts();
      if (!accounts.some((a) => sameEmail(a.email, email))) {
        return res.status(404).json({ ok: false, error: 'account not found' });
      }
      const primary = google.setPrimary(email);
      await reconnectGoogleConnectors({ gmailConnector, googleDrive, googleDocs, emit: deps.emit });
      res.json({ ok: true, primary, accounts: google.listAccounts() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });
}

function sameEmail(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function buildState({ google, gmailConnector, googleDrive, stripeConnector, metaConnector }) {
  const accounts = safe(() => google.listAccounts(), []);
  const googleConfigured = safe(() => google.isConfigured(), false);

  const gmailStatus = safe(() => gmailConnector.getStatus(), { connected: false });
  const driveStatus = safe(() => googleDrive.getStatus(), { connected: false });
  const stripeStatus = safe(() => stripeConnector.getStatus(), { connected: false });
  const metaStatus = safe(() => metaConnector.getStatus(), { connected: false });

  const env = process.env || {};
  const googleEnv = !!env.GOOGLE_REFRESH_TOKEN;
  const stripeEnv = !!env.STRIPE_SECRET_KEY;
  const metaEnv   = !!(env.FB_ACCESS_TOKEN && env.FB_AD_ACCOUNT_ID);

  // "env" → credential is in process.env so the connector auto-starts on
  // boot and the user shouldn't be asked to paste it. "ui" → entered via
  // a /welcome modal or /hq form. "none" → not connected.
  const sourceOf = (connected, viaEnv) => (!connected ? 'none' : (viaEnv ? 'env' : 'ui'));

  const ready = {
    gmail: !!gmailStatus.connected,
    drive: !!driveStatus.connected,
    stripe: !!stripeStatus.connected,
    meta: !!metaStatus.connected,
  };

  const sources = {
    gmail:  sourceOf(ready.gmail,  googleEnv),
    drive:  sourceOf(ready.drive,  googleEnv),
    stripe: sourceOf(ready.stripe, stripeEnv),
    meta:   sourceOf(ready.meta,   metaEnv),
  };

  return {
    google: {
      configured: googleConfigured,
      accounts,
      env: googleEnv,
    },
    gmail: {
      connected: !!gmailStatus.connected,
      source: sources.gmail,
      email: gmailStatus.email || null,
      messages_total: gmailStatus.messages_total || null,
      threads_total: gmailStatus.threads_total || null,
    },
    drive: {
      connected: !!driveStatus.connected,
      source: sources.drive,
      user_email: driveStatus.user_email || null,
      files_count: safe(() => driveStatus.persisted?.file, null),
    },
    stripe: {
      connected: !!stripeStatus.connected,
      source: sources.stripe,
      account: stripeStatus.account_id || null,
      account_name: stripeStatus.account_name || null,
      livemode: stripeStatus.livemode ?? null,
      key_mask: stripeStatus.key_mask || null,
      connected_at: stripeStatus.connected_at || null,
    },
    meta: {
      connected: !!metaStatus.connected,
      source: sources.meta,
      account_id: metaStatus.account_id || null,
      name: metaStatus.account_name || null,
      currency: metaStatus.currency || null,
      connected_at: metaStatus.connected_at || null,
    },
    sources,
    ready,
    done: ready.gmail && ready.drive && ready.stripe && ready.meta,
    all_env: ready.gmail && ready.drive && ready.stripe && ready.meta &&
             sources.gmail === 'env' && sources.drive === 'env' &&
             sources.stripe === 'env' && sources.meta === 'env',
  };
}

async function reconnectGoogleConnectors({ gmailConnector, googleDrive, googleDocs, emit }) {
  try { gmailConnector?.disconnect?.(); } catch (err) { console.warn('[onboarding] gmail disconnect failed:', err?.message || err); }
  try { googleDrive?.disconnect?.(); } catch (err) { console.warn('[onboarding] drive disconnect failed:', err?.message || err); }
  // google_docs has no disconnect today; restarting start() is a no-op once
  // already started, but we still try to nudge it.
  Promise.resolve()
    .then(() => gmailConnector?.start?.({ emit }))
    .catch((err) => console.error('[onboarding] gmail restart failed:', err?.message || err));
  Promise.resolve()
    .then(() => googleDrive?.start?.({ emit }))
    .catch((err) => console.error('[onboarding] drive restart failed:', err?.message || err));
  Promise.resolve()
    .then(() => googleDocs?.start?.({ emit }))
    .catch((err) => console.error('[onboarding] docs restart failed:', err?.message || err));
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}
