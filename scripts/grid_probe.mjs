// Opens /agents-grid headlessly, dispatches a browser task, captures any
// console errors, and reports whether the iframe ever gets a real src.
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
const errors = [];
const logs = [];
page.on("console", (msg) => { logs.push(`[${msg.type()}] ${msg.text()}`); });
page.on("pageerror", (err) => { errors.push(`PAGEERROR: ${err.message}`); });

await page.goto("http://localhost:8080/agents-grid", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

// Dispatch via the grid's dev dispatcher endpoint (/tool POST)
const r = await fetch("http://localhost:8080/tool", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "spawn_browser_agent", arguments: { task: "Go to example.com and tell me the heading", agent: "atlas" } }),
});
const body = await r.json();
console.log("[probe] dispatch →", body.result?.task_id, "slot=" + body.result?.slot);

// Poll the iframe src over ~30s
let lastSrc = null, finalSrc = null, finalStatus = null;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const snap = await page.evaluate(() => {
    const win = document.querySelector('.win[data-slot="0"]');
    const iframe = win?.querySelector('.slot-live iframe');
    return {
      status: win?.dataset.status,
      runtime: win?.dataset.runtime,
      src: iframe?.src || null,
      pending: win?.querySelector('.slot-live')?.classList.contains('pending'),
    };
  });
  if (snap.src !== lastSrc) { console.log(`[probe] t=${i}s`, JSON.stringify(snap)); lastSrc = snap.src; }
  finalSrc = snap.src;
  finalStatus = snap.status;
}

console.log("\n=== RESULT ===");
console.log("final status:", finalStatus);
console.log("final iframe.src:", finalSrc);
console.log("page errors:", errors.length);
errors.forEach(e => console.log("  " + e));
console.log("relevant console logs:");
logs.filter(l => l.includes("[grid]") || l.toLowerCase().includes("error")).forEach(l => console.log("  " + l));

await browser.close();
process.exit(0);
