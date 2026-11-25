// Chromium builds its web accessibility tree on the first UI Automation query, and only while the page is being rendered.
// Query a visible window once before it gets covered (a one-time cost per browser process; later pages are immediate).
import { Helper } from "./helper-client.mjs";
import { execFileSync } from "node:child_process";
const [exe, match, tool] = process.argv.slice(2);
const h = new Helper(exe);
await h.send("hello");
const win = (await h.send("windows", { query: match })).result.windows[0];
if (win && tool) console.log("raise:", execFileSync(tool, ["raise", win.windowId.toString(16)], { encoding: "utf8" }).trim()); // the test "person" looks at the page once
if (win) for (let i = 0; i < 8; i++) {
  const r = await h.send("snapshot", { pid: win.pid, windowId: win.windowId, processStartedAt: win.processStartedAt, limit: 1500 }, 30000);
  console.log(`prewarm attempt ${i}: elements=${r.result?.elements.length}`);
  if (r.ok && r.result.elements.some((e) => e.role === "AXWebArea")) { console.log("web tree ready"); break; }
}
await h.stop();
