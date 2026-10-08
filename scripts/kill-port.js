// Kill any process bound to $PORT (default 8080) before boot. Runs as
// a `predev` / `prestart` hook so stale watch-child processes from the
// previous session don't cause EADDRINUSE. Silent if nothing is bound.

import { execSync } from 'node:child_process';

const port = process.env.PORT || 8080;

try {
  const out = execSync(`lsof -ti:${port}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (!out) process.exit(0);
  const pids = out.split('\n').filter(Boolean);
  execSync(`kill -9 ${pids.join(' ')}`);
  console.log(`[kill-port] freed :${port} (pid ${pids.join(', ')})`);
} catch {
  // lsof exits 1 when nothing is bound — that's fine.
}
