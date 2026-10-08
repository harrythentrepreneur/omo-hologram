// src/hermes/route.js — task-to-runtime classifier.
//
// When the model dispatches a task via spawn_agent_task WITHOUT specifying
// a runtime, we shouldn't blindly default to claude. Instead, peek at the
// task text and route by intent:
//   • coding / file-editing / debugging / refactoring / testing → claude
//   • research / prose / lookups / planning / thinking          → hermes
//
// The classifier is intentionally simple — regex over keywords. It's
// deterministic, fast, and explainable. The model still has full override
// via the explicit `runtime` arg; this just picks a smart default.
//
// Why not let the model decide? Two reasons:
//   1. The persona already tells it to choose, but compliance is variable.
//      Voice users say "have someone look at X" all the time without
//      specifying which engine; we want the right one picked automatically.
//   2. A deterministic seam is debuggable: we can log + show the user
//      WHY we routed to a given engine and let them correct it once.

// ── Coding signals: keywords that strongly suggest a Claude task ────────
// Verbs and nouns that imply touching code, files, or a repo. Word boundaries
// only — "test" inside "testimony" doesn't count.
const CODING_VERBS = [
  // Edit-shaped verbs
  "refactor", "rewrite", "fix", "debug", "patch", "implement", "build", "ship",
  "code", "write", "edit", "modify", "rename", "extract", "inline", "lint",
  "format", "type-check", "typecheck", "compile", "transpile", "minify", "bundle",
  // Test verbs
  "test", "unit-test", "integration-test", "e2e", "snapshot",
  // Repo / git
  "commit", "stage", "push", "merge", "rebase", "branch", "diff", "checkout",
  "revert", "cherry-pick", "stash",
  // Release / deploy
  "deploy", "release", "publish", "rollback", "migrate", "scaffold",
  // Run / exec
  "run", "exec", "invoke",
];

const CODING_NOUNS = [
  // File extensions (with leading dot)
  "\\.js", "\\.ts", "\\.tsx", "\\.jsx", "\\.py", "\\.rb", "\\.go", "\\.rs",
  "\\.java", "\\.kt", "\\.swift", "\\.c", "\\.cpp", "\\.h", "\\.hpp", "\\.cs",
  "\\.scala", "\\.clj", "\\.ex", "\\.exs", "\\.lua", "\\.sh", "\\.bash", "\\.zsh",
  "\\.fish", "\\.html", "\\.css", "\\.scss", "\\.sass", "\\.vue", "\\.svelte",
  "\\.yml", "\\.yaml", "\\.toml", "\\.json", "\\.xml", "\\.sql", "\\.md",
  // Code artifacts
  "function", "method", "class", "module", "component", "interface", "schema",
  "endpoint", "route", "handler", "middleware", "controller", "service", "store",
  "model", "view", "template", "fixture", "migration",
  // Test artifacts
  "spec", "fixture",
  // Repo artifacts
  "repo", "repository", "branch", "PR", "pull request", "merge request",
  "commit", "diff", "package.json", "pyproject", "cargo", "go\\.mod",
  // Bug / issue (often coding-flavoured)
  "bug", "stack trace", "stacktrace", "regression", "race condition", "deadlock",
  // Dev tooling
  "lint", "linter", "eslint", "prettier", "ruff", "mypy", "pytest", "jest",
  "vitest", "webpack", "vite", "rollup", "babel", "tsc",
];

const CODING_PHRASES = [
  // "the X file", "this codebase", "the repo"
  "\\bcodebase\\b",
  "\\bthe codebase\\b",
  "\\bsource code\\b",
  "\\bgit history\\b",
  "\\bunit tests?\\b",
  "\\bend[- ]to[- ]end tests?\\b",
  "\\brun the tests?\\b",
  "\\btest suite\\b",
  "\\bdev server\\b",
  "\\bbuild script\\b",
  // 中文
  "代码", "代码库", "仓库", "重构", "调试", "测试套件", "单元测试", "改一下",
  "写个", "实现", "跑一下", "跑测试", "fix 一下", "改 bug",
];

// ── Hermes signals: keywords that suggest non-coding work ───────────────
const HERMES_VERBS = [
  "research", "summarize", "summarise", "draft", "outline", "brainstorm",
  "compare", "explain", "describe", "analyze", "analyse", "look up", "search",
  "find", "browse", "read", "synthesize", "synthesise", "translate", "rephrase",
  "proofread", "edit prose", "edit copy",
];
const HERMES_NOUNS = [
  "memo", "email", "newsletter", "blog post", "essay", "tweet", "thread",
  "outline", "agenda", "summary", "report", "briefing", "recap", "digest",
  "competitive analysis", "market research", "case study", "interview",
  // 中文
  "调研", "整理", "总结", "写一篇", "稿子", "草稿", "邮件草稿", "市场调研",
  "推文", "新闻稿", "翻译",
];

const CODING_RE  = compileRe([...CODING_VERBS.map(wordBound), ...CODING_NOUNS, ...CODING_PHRASES]);
const HERMES_RE  = compileRe([...HERMES_VERBS.map(wordBound), ...HERMES_NOUNS]);

function wordBound(token) { return `\\b${token}\\b`; }
function compileRe(parts) {
  return new RegExp("(" + parts.join("|") + ")", "gi");
}

function countMatches(text, re) {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(text) !== null) {
    n += 1;
    if (n > 32) break; // bound the loop
  }
  return n;
}

// Classify a task into 'claude' | 'hermes', with the reason.
// Returns null when there's no strong signal in either direction — the
// caller should fall through to whatever default it prefers (revival
// continuity → identity's lastRuntime → server default).
export function classifyTask(task) {
  const text = String(task || "").trim();
  if (!text) return null;
  const codingHits = countMatches(text, CODING_RE);
  const hermesHits = countMatches(text, HERMES_RE);
  // Strong coding signal: at least one coding keyword AND no overwhelming
  // hermes signal. Coding tends to be specific (a file path, a function),
  // so even one hit is meaningful.
  if (codingHits >= 1 && codingHits >= hermesHits) {
    return {
      runtime: "claude",
      reason: `coding signal (${codingHits} match${codingHits === 1 ? "" : "es"}, hermes ${hermesHits})`,
      coding_hits: codingHits,
      hermes_hits: hermesHits,
    };
  }
  if (hermesHits >= 1 && hermesHits > codingHits) {
    return {
      runtime: "hermes",
      reason: `non-coding signal (${hermesHits} match${hermesHits === 1 ? "" : "es"}, coding ${codingHits})`,
      coding_hits: codingHits,
      hermes_hits: hermesHits,
    };
  }
  // No signals either way — caller picks.
  return null;
}
