import { Helper } from "./helper-client.mjs";
const [exe, match, ...rest] = process.argv.slice(2);
const h = new Helper(exe);
await h.send("hello");
const w = (await h.send("windows", { query: match })).result.windows;
console.log("matches", w.map((x) => `${x.windowId}:${x.title}`).join(" | "));
const win = w[0];
const t0 = Date.now();
const r = await h.send("snapshot", { pid: win.pid, windowId: win.windowId, processStartedAt: win.processStartedAt, limit: 300, image: rest.includes("image") }, 30000);
console.log("snapshot ms", Date.now() - t0, r.ok ? `elements=${r.result.elements.length} complete=${r.result.complete} omitted=${r.result.omitted}` : JSON.stringify(r.error));
if (r.ok) {
  for (const e of r.result.elements.slice(0, 80)) console.log(" ".repeat(e.depth), e.ref, e.role, JSON.stringify(e.label ?? ""), e.value !== undefined ? "value=" + JSON.stringify(String(e.value).slice(0, 40)) : "", e.actions ? e.actions.join(",") : "", e.editable ? "editable" : "", e.focused ? "focused" : "", e.frame ? `${Math.round(e.frame.x)},${Math.round(e.frame.y)} ${Math.round(e.frame.w)}x${Math.round(e.frame.h)}` : "");
  if (r.result.image) { console.log("image", r.result.image.width, r.result.image.height, r.result.image.mime, r.result.image.data.length, "note", r.result.imageNote); (await import("node:fs")).writeFileSync(process.env.OUT ?? "snap.png", Buffer.from(r.result.image.data, "base64")); }
}
await h.stop();
