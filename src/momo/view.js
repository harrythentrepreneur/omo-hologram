// Tiny module that holds "what's on screen right now" so Momo (via the
// get_screen_context tool) can understand what the user is looking at when
// they say "this" / "that one" / "tell me more".
//
// State flows in from the browser: the /hq iframe POSTs /omo/ingest/view
// whenever its focused panel or drill-down target changes, and pane-layer
// POSTs a clear when the user dismisses the pane entirely. Last-write-wins;
// no history, no event log — it's a live pointer, not a stream.

let current = null;

export function setView(view) {
  if (!view || typeof view !== 'object') {
    current = null;
    return;
  }
  current = { ...view, updated_at: Date.now() };
}

export function clearView() {
  current = null;
}

export function getView() {
  return current;
}
