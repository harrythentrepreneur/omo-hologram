// public/preview-bridge.js — voice-control bridge inside preview iframes.
//
// Loaded into every same-origin omo HTML page (auto-injected by the
// server) and optionally into user pages that opt in with a script tag.
// Listens for postMessage commands from window.parent and executes them
// against the local DOM, then posts a result back. The parent (the
// /preview pane) relays into the holo dispatcher, where voice tools
// originate and final results land.
//
// Message protocol — every command carries an `id` so the caller can
// match the async reply:
//   ← parent: { type: 'omo.preview.cmd', id, command, ...args }
//   → parent: { type: 'omo.preview.ack', id, ok, result?, error? }
//
// The bridge also emits unsolicited events:
//   → parent: { type: 'omo.preview.ready', url, title }   (once on load)
//   → parent: { type: 'omo.preview.nav',   url, title }   (on SPA nav)
//
// Hard rule: never break the host page. Every command is wrapped in
// try/catch; failures return { ok:false, error } instead of throwing.

(() => {
  if (window.__omoPreviewBridge) return;
  window.__omoPreviewBridge = { v: 1 };

  const ALLOWED_ORIGIN = (() => {
    // Replies always go to window.parent; we accept commands from any
    // parent because the /preview pane lives at the same origin as omo
    // (parent.origin === omo.origin), while the host (this page) might
    // be cross-origin. window.parent.postMessage with targetOrigin '*'
    // would be unsafe for replies that carry page content; instead we
    // mirror the parent's origin if same-origin (we can read it), else
    // fall back to '*' — the data is only ever DOM info, not secrets.
    try { return window.parent?.location?.origin || '*'; }
    catch { return '*'; }
  })();

  function send(msg) {
    try { window.parent?.postMessage(msg, ALLOWED_ORIGIN); } catch {}
  }

  function ack(id, ok, payload) {
    send({ type: 'omo.preview.ack', id, ok, ...(ok ? { result: payload } : { error: payload }) });
  }

  // ── DOM resolution helpers ──────────────────────────────────────────
  // Strategy: cheap exact matches first, then progressively-fuzzy. The
  // first non-empty match wins; ties broken by visibility + DOM order.

  function visible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = window.getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    return true;
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
  }

  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function accessibleName(el) {
    // Best-effort accessibility name — covers ~90% of real-world cases.
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/);
      const labels = ids.map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      if (labels) return labels;
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      // <label for="id">
      if (el.id) {
        const lab = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
        if (lab) return textOf(lab);
      }
      // <label><input></label>
      const wrap = el.closest('label');
      if (wrap) return textOf(wrap);
      if (el.placeholder) return el.placeholder;
      if (el.name) return el.name;
    }
    if (el.alt) return el.alt;
    if (el.title) return el.title;
    return textOf(el);
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\\n\r]/g, '\\$&');
  }

  // Score a candidate against a query string. Higher = better fit.
  function scoreMatch(el, queryLower) {
    if (!visible(el)) return 0;
    const name = accessibleName(el).toLowerCase();
    if (!name) return 0;
    if (name === queryLower) return 100;
    if (name.startsWith(queryLower)) return 80;
    if (name.includes(queryLower)) return 60;
    // Word-boundary token match — "sign" → "Sign in", "Sign up" both rank.
    const queryWords = queryLower.split(/\s+/).filter(Boolean);
    const nameWords = name.split(/\s+/);
    const hits = queryWords.filter((q) => nameWords.some((n) => n.startsWith(q))).length;
    if (hits === queryWords.length) return 40;
    if (hits > 0) return 20 + hits;
    return 0;
  }

  // Confidence threshold — scores >= this count as "we got the right
  // thing". Below it we return suggestions instead so omo can ask the
  // user to pick. 40 corresponds to a token-overlap match where every
  // word in the query was a prefix of some word in the candidate name.
  const CONFIDENT_SCORE = 40;
  const SUGGESTION_CAP = 5;

  // Pull the top-N most prominent visible candidates (regardless of
  // semantic match) as suggestions when nothing scored well. Used as a
  // fallback so the user always has something to pick from.
  function topVisibleNames(elements, n = SUGGESTION_CAP) {
    const out = [];
    for (const el of elements) {
      if (!visible(el)) continue;
      const name = accessibleName(el);
      if (!name) continue;
      out.push({ name: name.slice(0, 60), inView: inViewport(el) });
      if (out.length >= n * 3) break;     // small headroom for sort
    }
    out.sort((a, b) => (b.inView === a.inView) ? 0 : (b.inView ? 1 : -1));
    return out.slice(0, n).map((x) => x.name);
  }

  // Generic finder that returns { best, suggestions, all }. Callers
  // decide whether to act on `best` (high enough confidence) or punt to
  // `suggestions`.
  function findRanked(elements, query, { index = 1 } = {}) {
    const q = String(query || '').toLowerCase();
    const scored = [];
    for (const el of elements) {
      const s = scoreMatch(el, q);
      if (s > 0) scored.push({ el, score: s, inView: inViewport(el) });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.inView !== b.inView) return a.inView ? -1 : 1;
      return 0;
    });
    const pick = scored[Math.max(0, index - 1)] || null;
    const suggestions = scored.slice(0, SUGGESTION_CAP).map((s) => accessibleName(s.el).slice(0, 60));
    return { best: pick?.el || null, score: pick?.score || 0, suggestions, all: scored };
  }

  // Find the best clickable element matching the query. Considers
  // buttons, links, inputs[type=submit/button], roles, and any element
  // with onclick. Returns { best, suggestions, score } — caller checks
  // score against CONFIDENT_SCORE.
  function findClickable(query, { index = 1 } = {}) {
    if (!query) return { best: null, score: 0, suggestions: [] };
    const sel = 'button, [role="button"], a, input[type="submit"], input[type="button"], summary, [onclick], label[for]';
    const candidates = Array.from(document.querySelectorAll(sel));
    const ranked = findRanked(candidates, query, { index });
    if (ranked.score === 0) {
      // No semantic hits — last-resort fallback: any visible leaf
      // containing the phrase (catches e.g. inline <span> click targets
      // with no role). If still nothing, surface the most prominent
      // clickables as suggestions so the user has options.
      const q = String(query).toLowerCase();
      const leaves = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (!visible(el)) return false;
        if (el.children.length > 0) return false;
        return textOf(el).toLowerCase().includes(q);
      });
      if (leaves.length > 0) {
        return { best: leaves[Math.max(0, index - 1)] || leaves[0], score: 15, suggestions: [] };
      }
      return { best: null, score: 0, suggestions: topVisibleNames(candidates) };
    }
    return ranked;
  }

  // Find an input/textarea/select matching the query.
  function findField(query) {
    if (!query) {
      const focused = document.activeElement?.matches('input,textarea,select,[contenteditable]')
        ? document.activeElement : null;
      return { best: focused, score: focused ? 100 : 0, suggestions: [] };
    }
    const sel = 'input:not([type="submit"]):not([type="button"]):not([type="hidden"]), textarea, select, [contenteditable=""], [contenteditable="true"]';
    const fields = Array.from(document.querySelectorAll(sel));
    const ranked = findRanked(fields, query);
    if (ranked.score === 0) {
      return { best: null, score: 0, suggestions: topVisibleNames(fields) };
    }
    return ranked;
  }

  function findScrollAnchor(query) {
    if (!query) return { best: null, score: 0, suggestions: [] };
    // Prefer headings & landmark roles first — what a user usually means
    // when they say "scroll to pricing" / "scroll to the FAQ".
    const heads = Array.from(document.querySelectorAll('h1, h2, h3, h4, [role="heading"], section[id], section[aria-labelledby], [aria-label]'));
    const ranked = findRanked(heads, query);
    if (ranked.score > 0) return ranked;
    // Plain text fallback — any visible leaf containing the phrase.
    const q = String(query).toLowerCase();
    for (const el of document.querySelectorAll('*')) {
      if (!visible(el)) continue;
      if (el.children.length > 0) continue;
      if (textOf(el).toLowerCase().includes(q)) {
        return { best: el, score: 10, suggestions: [] };
      }
    }
    // Nothing matched — suggest the page's top headings.
    return { best: null, score: 0, suggestions: topVisibleNames(heads) };
  }

  // ── Commands ────────────────────────────────────────────────────────

  function cmd_click({ target, index = 1 }) {
    if (!target) return { ok: false, error: 'click needs a target' };
    const { best, score, suggestions } = findClickable(target, { index });
    if (!best || score < CONFIDENT_SCORE && score < 15) {
      // Either nothing matched, or matches were too weak. Return
      // suggestions so omo can ask the user to pick.
      return {
        ok: false,
        error: `no clickable element confidently matches "${target}"`,
        suggestions: suggestions || [],
      };
    }
    best.scrollIntoView({ block: 'center', behavior: 'instant' });
    flashOutline(best);
    best.focus?.();
    // Fire a proper synthetic event chain.
    best.click();
    return { ok: true, result: { tag: best.tagName.toLowerCase(), name: accessibleName(best), score } };
  }

  function cmd_type({ text, target, replace = false, submit = false }) {
    const { best: el, score, suggestions } = findField(target);
    if (!el) {
      return {
        ok: false,
        error: target ? `no input matching "${target}"` : 'no focused input — say which field',
        suggestions: suggestions || [],
      };
    }
    if (target && score < CONFIDENT_SCORE) {
      // Weak match — surface suggestions; don't silently type into the
      // wrong field. omo can ask "did you mean X, Y, or Z?"
      return {
        ok: false,
        error: `no input confidently matches "${target}"`,
        suggestions: suggestions || [],
      };
    }
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    flashOutline(el);
    el.focus();
    const str = String(text ?? '');
    if (el.isContentEditable) {
      if (replace) el.textContent = '';
      document.execCommand('insertText', false, str);
    } else if (el.tagName === 'SELECT') {
      const opt = Array.from(el.options).find((o) =>
        o.label.toLowerCase().includes(str.toLowerCase()) ||
        o.value.toLowerCase() === str.toLowerCase()
      );
      if (!opt) return { ok: false, error: `no option matching "${str}"` };
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const next = replace ? str : (el.value || '') + str;
      if (setter) setter.call(el, next); else el.value = next;
      // React listens on these — fire both for max compat.
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: str }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (submit) {
      el.form?.requestSubmit?.() || el.form?.submit?.();
    }
    return { ok: true, result: { name: accessibleName(el), value: el.value } };
  }

  function cmd_scroll({ direction, to, amount }) {
    if (to) {
      const { best, score, suggestions } = findScrollAnchor(to);
      if (!best) {
        return {
          ok: false,
          error: `nothing on the page matches "${to}"`,
          suggestions: suggestions || [],
        };
      }
      best.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flashOutline(best);
      return { ok: true, result: { to: textOf(best).slice(0, 80), score } };
    }
    if (direction === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return { ok: true }; }
    if (direction === 'bottom') { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); return { ok: true }; }
    const step = Math.max(0, Number(amount)) || Math.floor(window.innerHeight * 0.85);
    const delta = direction === 'up' ? -step : step;
    window.scrollBy({ top: delta, behavior: 'smooth' });
    return { ok: true, result: { delta } };
  }

  // ── Inline visual feedback (layer B) ────────────────────────────────
  // A brief, non-blocking outline on whichever element the bridge just
  // touched — scrolled-to anchor, soon also click target and typed-into
  // field. We inject a tiny <style> block once into the host page so
  // even iframe content with strict CSP can opt out via meta tags
  // (the styles are scoped to a class we add to ELEMENTS, no globals).
  let flashStyleInstalled = false;
  function installFlashStyle() {
    if (flashStyleInstalled) return;
    flashStyleInstalled = true;
    const css = `
      @keyframes __omo_flash {
        0%   { box-shadow: 0 0 0 0   rgba(227, 117, 83, 0.55), 0 0 0 0  rgba(227, 117, 83, 0.30); }
        30%  { box-shadow: 0 0 0 4px rgba(227, 117, 83, 0.45), 0 0 0 12px rgba(227, 117, 83, 0.20); }
        100% { box-shadow: 0 0 0 4px rgba(227, 117, 83, 0.00), 0 0 0 16px rgba(227, 117, 83, 0.00); }
      }
      .__omo-flash {
        animation: __omo_flash 1400ms cubic-bezier(0.2, 0.7, 0.2, 1) 1 both !important;
        border-radius: 6px;
      }
    `;
    const style = document.createElement('style');
    style.setAttribute('data-omo-bridge', '');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }
  function flashOutline(el) {
    if (!el || !(el instanceof Element)) return;
    installFlashStyle();
    // Restart the animation if the same element was just flashed.
    el.classList.remove('__omo-flash');
    // Force reflow so the keyframe restarts cleanly.
    void el.offsetWidth;
    el.classList.add('__omo-flash');
    setTimeout(() => el.classList.remove('__omo-flash'), 1500);
  }

  function cmd_navigate({ url, path, action }) {
    if (action === 'back')    { history.back();    return { ok: true }; }
    if (action === 'forward') { history.forward(); return { ok: true }; }
    if (action === 'reload')  { location.reload(); return { ok: true }; }
    if (path)                 { location.assign(path); return { ok: true, result: { url: path } }; }
    if (url)                  { location.assign(url);  return { ok: true, result: { url } }; }
    return { ok: false, error: 'navigate needs url, path, or action' };
  }

  function cmd_submit() {
    const form = document.activeElement?.closest('form') || document.querySelector('form');
    if (!form) return { ok: false, error: 'no form on the page' };
    form.requestSubmit?.() || form.submit?.();
    return { ok: true };
  }

  function cmd_focus({ target }) {
    if (!target) return { ok: false, error: 'focus needs a target' };
    const f = findField(target);
    const c = f.score === 0 ? findClickable(target) : null;
    const pick = (f.score > 0 ? f : c) || f;
    const { best, score, suggestions } = pick;
    if (!best || (score < CONFIDENT_SCORE && score < 15)) {
      return {
        ok: false,
        error: `nothing confidently matches "${target}"`,
        suggestions: suggestions || [],
      };
    }
    best.scrollIntoView({ block: 'center', behavior: 'instant' });
    flashOutline(best);
    best.focus?.();
    return { ok: true, result: { name: accessibleName(best), score } };
  }

  function cmd_describe() {
    // Compact JSON summary of the page — what omo can read out / reason
    // over. Capped sizes prevent runaway output.
    const out = {
      url: location.href,
      title: document.title,
      headings: [],
      links: [],
      buttons: [],
      fields: [],
      landmarks: [],
    };
    for (const el of document.querySelectorAll('h1, h2, h3')) {
      if (!visible(el)) continue;
      const t = textOf(el);
      if (t) out.headings.push({ level: el.tagName.toLowerCase(), text: t.slice(0, 120) });
      if (out.headings.length >= 30) break;
    }
    for (const el of document.querySelectorAll('a[href]')) {
      if (!visible(el)) continue;
      const name = accessibleName(el);
      if (!name) continue;
      out.links.push({ text: name.slice(0, 80), href: el.getAttribute('href').slice(0, 200) });
      if (out.links.length >= 40) break;
    }
    for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')) {
      if (!visible(el)) continue;
      const name = accessibleName(el);
      if (!name) continue;
      out.buttons.push({ text: name.slice(0, 60) });
      if (out.buttons.length >= 30) break;
    }
    for (const el of document.querySelectorAll('input:not([type=hidden]), textarea, select')) {
      if (!visible(el)) continue;
      const name = accessibleName(el);
      out.fields.push({ name: name.slice(0, 60), type: el.type || el.tagName.toLowerCase(), value: (el.value || '').slice(0, 80) });
      if (out.fields.length >= 20) break;
    }
    for (const el of document.querySelectorAll('nav, main, aside, header, footer, [role="navigation"], [role="main"], [role="banner"]')) {
      if (!visible(el)) continue;
      const name = accessibleName(el);
      if (name) out.landmarks.push({ role: el.tagName.toLowerCase(), name: name.slice(0, 60) });
      if (out.landmarks.length >= 10) break;
    }
    return { ok: true, result: out };
  }

  function cmd_wait({ ms }) {
    // Clamped server-side too, but defending here keeps a misbehaving
    // caller from hanging the bridge for minutes.
    const dur = Math.max(0, Math.min(5000, Number(ms) || 400));
    return new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true, result: { waitedMs: dur } }), dur);
    });
  }

  const HANDLERS = {
    click:    cmd_click,
    type:     cmd_type,
    scroll:   cmd_scroll,
    navigate: cmd_navigate,
    submit:   cmd_submit,
    focus:    cmd_focus,
    describe: cmd_describe,
    wait:     cmd_wait,
    ping:     () => ({ ok: true, result: { v: 1, ts: Date.now() } }),
  };

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object' || m.type !== 'omo.preview.cmd') return;
    const handler = HANDLERS[m.command];
    if (!handler) return ack(m.id, false, `unknown command: ${m.command}`);
    let out;
    try { out = handler(m); }
    catch (err) { return ack(m.id, false, String(err?.message || err)); }
    if (out && typeof out.then === 'function') {
      out.then((r) => ack(m.id, !!r?.ok, r?.ok ? r.result : r?.error))
         .catch((err) => ack(m.id, false, String(err?.message || err)));
    } else {
      ack(m.id, !!out?.ok, out?.ok ? out.result : out?.error);
    }
  });

  // ── Announce / re-announce ──────────────────────────────────────────
  // The parent uses `omo.preview.ready` (first announcement) and
  // `omo.preview.nav` (subsequent) to drive the tier indicator and to
  // sync the address bar after SPA route changes. We cast a wide net for
  // detecting "the page just navigated":
  //
  //   1. DOMContentLoaded → first ready.
  //   2. popstate         → user clicked back/forward, fragment changed.
  //   3. pushState/replaceState (monkey-patched) → most SPA routers.
  //   4. <title> changes  → fallback for routers that bypass history
  //                         (some old Angular setups, custom routers).
  //   5. document.location.href poll @ 500ms → last-resort fallback for
  //                         everything else (hashchange, fragments,
  //                         routers that update only the URL bar via
  //                         tricks). Cheap; doesn't block anything.
  //
  // All paths funnel through `announceNav` which debounces a 250ms
  // window so a single navigation that triggers two of the above
  // (e.g. pushState + title change) only fires one nav event.

  let lastAnnouncedUrl = null;
  let lastAnnouncedTitle = null;
  let announceTimer = 0;

  function announceReady() {
    lastAnnouncedUrl = location.href;
    lastAnnouncedTitle = document.title;
    send({ type: 'omo.preview.ready', url: location.href, title: document.title });
  }
  function announceNav() {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      announceTimer = 0;
      // Skip if neither URL nor title actually changed since last announce.
      if (location.href === lastAnnouncedUrl && document.title === lastAnnouncedTitle) return;
      lastAnnouncedUrl = location.href;
      lastAnnouncedTitle = document.title;
      send({ type: 'omo.preview.nav', url: location.href, title: document.title });
    }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceReady, { once: true });
  } else {
    announceReady();
  }
  window.addEventListener('popstate',   announceNav);
  window.addEventListener('hashchange', announceNav);
  // Monkey-patch pushState/replaceState so client-side SPA routers
  // emit a nav event we can pick up.
  for (const k of ['pushState', 'replaceState']) {
    const orig = history[k];
    history[k] = function (...args) {
      const r = orig.apply(this, args);
      announceNav();
      return r;
    };
  }
  // Title MutationObserver — many routers set document.title on route
  // change without touching history. Watches both <title> creation and
  // text mutation.
  function watchTitle() {
    const head = document.head;
    if (!head) return;
    const titleEl = document.querySelector('title');
    if (titleEl) new MutationObserver(announceNav).observe(titleEl, { childList: true, characterData: true, subtree: true });
    // Catch <title> being replaced wholesale.
    new MutationObserver(() => {
      const t = document.querySelector('title');
      if (t) announceNav();
    }).observe(head, { childList: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchTitle, { once: true });
  } else {
    watchTitle();
  }
  // Last-resort: poll the URL every 500ms. If something changed without
  // any of the hooks firing, catch it here. Cheap (one string compare)
  // and stops after the page is hidden.
  setInterval(() => {
    if (document.hidden) return;
    if (location.href !== lastAnnouncedUrl) announceNav();
  }, 500);
})();
