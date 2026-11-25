import { Helper } from "./helper-client.mjs";
const h = new Helper(process.argv[2]);
await h.send("hello");
const win = (await h.send("windows", { query: process.argv[3] })).result.windows[0];
const addr = { pid: win.pid, windowId: win.windowId, processStartedAt: win.processStartedAt };
const t0 = Date.now();
for (let i = 0; i < 12; i++) {
  const r = await h.send("snapshot", { ...addr, limit: 1500 }, 30000);
  const els = r.result.elements;
  console.log(`+${Date.now() - t0}ms elements=${els.length} web=${els.some((e) => e.role === "AXWebArea")} button=${els.some((e) => e.label === "Press")}`);
  await new Promise((res) => setTimeout(res, 500));
}
await h.stop();
