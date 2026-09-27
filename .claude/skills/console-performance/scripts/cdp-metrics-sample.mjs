// Growth over time: node cdp-metrics-sample.mjs <pageWs> <out.jsonl> <intervalSec> <count>
// Appends one JSON line per sample; per-interval deltas of the *Duration fields are the cost of that interval.
import fs from 'node:fs';
const [wsUrl, out, intervalSec, count] = process.argv.slice(2);
const sock = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, { resolve, reject });
  sock.send(JSON.stringify({ id: i, method, params }));
});
sock.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (!data.id || !pending.has(data.id)) return;
  const entry = pending.get(data.id);
  pending.delete(data.id);
  data.error ? entry.reject(new Error(data.error.message)) : entry.resolve(data.result);
};
await new Promise((resolve) => { sock.onopen = resolve; });
await send('Performance.enable', { timeDomain: 'timeTicks' });
for (let n = 0; n < Number(count); n++) {
  const metrics = Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const dom = await send('Memory.getDOMCounters');
  const page = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ liveNodes: document.getElementsByTagName('*').length, animations: document.getAnimations().length, openSockets: (window.__fleetE2E?.sockets ?? []).filter((s) => !s.closed).length })`,
    returnByValue: true,
  });
  fs.appendFileSync(out, `${JSON.stringify({
    t: new Date().toISOString().slice(11, 19),
    heapMB: +(metrics.JSHeapUsedSize / 1048576).toFixed(1),
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    taskS: +metrics.TaskDuration.toFixed(2),
    scriptS: +metrics.ScriptDuration.toFixed(2),
    styleS: +metrics.RecalcStyleDuration.toFixed(2),
    layoutS: +metrics.LayoutDuration.toFixed(2),
    styleCount: metrics.RecalcStyleCount,
    ...JSON.parse(page.result.value),
  })}\n`);
  if (n < Number(count) - 1) await new Promise((resolve) => setTimeout(resolve, Number(intervalSec) * 1000));
}
sock.close();
