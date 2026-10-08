// public/momo-reactions.js — turns Gemini Live transcripts into cute
// reactions on the avatar. Zero allocations in the hot path; throttled
// per kind so a long "hahahahaha" doesn't fire 30 giggles.
//
// Usage — one-liner from any hologram page after the avatar exists:
//
//   import { attachMomoReactions } from '/momo-reactions.js';
//   const reactions = attachMomoReactions({ avatar });
//   // inside handleLiveMessage(msg):
//   reactions.onLiveMessage(msg);
//
// Mirrors the shape of momo-ingest.js so pages can fan out incoming
// live messages to multiple taps without duplication.

// ── Keyword / pattern banks ─────────────────────────────────────────────
// All checks run as RegExp.test() on lowercased text. Chinese patterns
// bypass the lowercase since Han chars aren't cased. Patterns are ranked
// by "intensity" so the strongest wins on the same chunk.
//
// Each entry: { re, reaction, action?, weight }.
//   reaction — one of 'happy' | 'delighted' | 'concerned' (avatar.reactX)
//   action   — optional idle-action kind to force at the same time
//   weight   — tie-breaker when multiple fire on one chunk
const PATTERNS = [
  // Laughter & joy — the marquee case. Any of these = full delighted + giggle.
  { re: /\bha ?ha(?: ?ha)*\b|\bhe ?he(?: ?he)*\b|\blol\b|\blmao\b|\brofl\b|哈哈+|嘻嘻|呵呵|嘿嘿|😂|🤣|😆/iu,
    reaction: 'delighted', action: 'giggle', weight: 10 },

  // Cute / affection — "so cute", "love it", "adorable", hearts emoji.
  { re: /\b(so )?cute\b|\badorable\b|\blove (it|this|you|her|him)\b|❤️|♥|💕|💖|😍|🥰|好可爱|超可爱|太可爱|可爱爱|萌/iu,
    reaction: 'delighted', action: 'peekBoop', weight: 9 },

  // Praise / amazement — "amazing", "wonderful", "wow", "incredible".
  { re: /\b(amazing|wonderful|incredible|awesome|fantastic|brilliant|perfect)\b|wow+|🤩|✨|太棒|好棒|厉害|哇+/iu,
    reaction: 'delighted', action: 'yay', weight: 8 },

  // Gratitude — "thanks", "thank you", "谢谢".
  { re: /\bthank(?: ?you| ?s)?\b|谢谢|多谢|感谢/iu,
    reaction: 'happy', action: 'happyHeart', weight: 7 },

  // Mild positive — "nice", "good", "cool", "great", "yes", "okay".
  { re: /\b(nice|good|great|cool|yes|yep|okay|ok|sweet|lovely)\b|好的|不错|棒+|可以+|对+/iu,
    reaction: 'happy', action: 'nodYes', weight: 4 },

  // Joke / funny setup — user is priming a laugh. Soft smile anticipation.
  { re: /\b(joke|funny|hilarious|silly|haha setup)\b|笑话|好笑|搞笑/iu,
    reaction: 'happy', action: 'twinkle', weight: 5 },

  // Surprise / exclamation — 3+ exclamation marks or "oh!" / "wow!".
  { re: /!{3,}|[！]{3,}|\boh!+|\bwhoa\b|\byay\b|🎉|🥳/iu,
    reaction: 'happy', action: 'chirp', weight: 6 },

  // Concern / apology — "sorry", "oh no", "uh oh", error language.
  { re: /\b(sorry|apolog\w*|oh no|uh oh|yikes|bad news|sad|error|problem|fail(?:ed|ing)?)\b|😢|😞|💔|糟糕|糟了|对不起|抱歉|不好意思|难过|不好了/iu,
    reaction: 'concerned', action: null, weight: 7 },
];

// Throttles (ms). Low enough for responsiveness, high enough to avoid
// stacking a 2nd giggle on top of a still-running one.
const GLOBAL_MIN_MS = 350;          // no more than ~3 reactions/sec overall
const PER_KIND_MIN_MS = 1400;       // same reaction repeats at most ~every 1.4s
const ACTION_MIN_MS = 900;          // same forced action repeats at most ~every 0.9s

export function attachMomoReactions({ avatar, debug = true } = {}) {
  if (!avatar) return { onLiveMessage() {} };

  if (debug) console.log('[momo-reactions] attached — will react to conversation');

  // Expose a manual test hook so you can verify the avatar wiring from the
  // browser console without waiting for Gemini to laugh:
  //   __momoTest('delighted')   // fires a reaction
  //   __momoTest('giggle')      // forces a cute action
  //   __momoTest('yay'|'peekBoop'|'hop'|'chirp'|'twinkle'|'nodYes'|...)
  // Available on every hologram page the moment the module loads.
  if (typeof window !== 'undefined') {
    window.__momoTest = (kind = 'delighted') => {
      try {
        if (kind === 'delighted' || kind === 'happy' || kind === 'concerned') {
          const fnName = 'react' + kind[0].toUpperCase() + kind.slice(1);
          avatar[fnName]?.('manual test');
        } else if (avatar.playCuteAction) {
          avatar.playCuteAction(kind, { interrupt: true });
        }
        console.log('[__momoTest] fired', kind);
      } catch (e) { console.warn('[__momoTest] failed', e); }
    };
    window.__momoJoke = () => {
      // Full "she laughed at your joke" sequence — what a successful
      // delighted reaction should look like end-to-end.
      try {
        avatar.reactDelighted?.('test joke');
        avatar.playCuteAction?.('giggle', { interrupt: true });
        console.log('[__momoJoke] giggle sequence fired');
      } catch {}
    };
  }

  // Per-turn text buffers — we scan the *full* accumulated turn each chunk
  // and remember what we've already matched on, so a pattern fires once
  // per turn even when transcription chunks split a laugh in two.
  let turnUser = '';
  let turnMomo = '';
  let firedThisTurn = new Set();     // pattern index → fired
  let lastFireMs = 0;
  const lastKindMs = Object.create(null);   // reaction kind → ms
  const lastActionMs = Object.create(null); // action kind → ms

  function maybeFire(text, side) {
    if (!text) return;
    const now = performance.now();
    // Scan remaining patterns in weight order. Highest wins.
    let best = -1, bestWeight = -1;
    for (let i = 0; i < PATTERNS.length; i++) {
      if (firedThisTurn.has(i)) continue;
      const p = PATTERNS[i];
      if (p.weight <= bestWeight) continue;
      if (p.re.test(text)) { best = i; bestWeight = p.weight; }
    }
    if (best < 0) return;
    const pat = PATTERNS[best];
    // Global + per-kind throttle.
    if (now - lastFireMs < GLOBAL_MIN_MS) return;
    if ((lastKindMs[pat.reaction] || 0) && now - lastKindMs[pat.reaction] < PER_KIND_MIN_MS) return;

    firedThisTurn.add(best);
    lastFireMs = now;
    lastKindMs[pat.reaction] = now;

    try {
      if (pat.reaction === 'delighted' && avatar.reactDelighted) avatar.reactDelighted(side);
      else if (pat.reaction === 'happy' && avatar.reactHappy) avatar.reactHappy(side);
      else if (pat.reaction === 'concerned' && avatar.reactConcerned) avatar.reactConcerned(side);
    } catch {}

    if (pat.action && avatar.playCuteAction) {
      const gap = now - (lastActionMs[pat.action] || 0);
      if (gap > ACTION_MIN_MS) {
        try { avatar.playCuteAction(pat.action, { interrupt: true }); } catch {}
        lastActionMs[pat.action] = now;
      }
    }

    if (debug) {
      // eslint-disable-next-line no-console
      console.log('[reactions]', side, pat.reaction, pat.action || '—', '←', text.slice(-60));
    }
  }

  function resetTurn() {
    turnUser = '';
    turnMomo = '';
    firedThisTurn.clear();
  }

  function onLiveMessage(msg) {
    if (!msg) return;
    const sc = msg.serverContent;
    if (!sc) return;
    const inT = sc.inputTranscription?.text;
    const outT = sc.outputTranscription?.text;
    if (typeof inT === 'string' && inT) {
      turnUser += (turnUser ? ' ' : '') + inT;
      maybeFire(turnUser, 'user');
    }
    if (typeof outT === 'string' && outT) {
      turnMomo += (turnMomo ? ' ' : '') + outT;
      maybeFire(turnMomo, 'momo');
    }
    if (sc.turnComplete || sc.generationComplete || sc.interrupted) resetTurn();
  }

  return { onLiveMessage };
}
