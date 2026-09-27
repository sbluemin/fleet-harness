// Per-keystroke cost: node cdp-type-bench.mjs <pageWs> <composer|control|terminal> <chars> [bucket=20]
// Inserts one character at a time and waits for the next frame; prints latency and main-thread cost per character.
const [wsUrl, target, count, bucketArg] = process.argv.slice(2);
const bucket = Number(bucketArg ?? 20);
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
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
await send('Performance.enable', { timeDomain: 'timeTicks' });

const visible = `(r) => r.width > 50 && r.bottom > 0 && r.top < innerHeight && r.left < innerWidth && r.right > 0`;
const pick = {
  composer: `(() => { const ok = ${visible}; const t = [...document.querySelectorAll('textarea[aria-label="메시지 입력"], textarea[aria-label="Message input"]')].find((t) => !t.closest('[inert]') && ok(t.getBoundingClientRect())); if (!t) return 'none'; t.focus(); return document.activeElement === t ? 'ok' : 'nofocus'; })()`,
  control: `(() => { let t = document.getElementById('perf-bench-control'); if (!t) { t = document.createElement('textarea'); t.id = 'perf-bench-control'; t.style.cssText = 'position:fixed;left:40px;top:40px;width:500px;height:200px;z-index:99999'; document.body.appendChild(t); } t.value = ''; t.focus(); return document.activeElement === t ? 'ok' : 'nofocus'; })()`,
  terminal: `(() => { const ok = ${visible}; const t = [...document.querySelectorAll('textarea[aria-label="Terminal input"]')].find((t) => !t.closest('[inert]') && t.closest('.xterm') && ok(t.closest('.xterm').getBoundingClientRect())); if (!t) return 'none'; t.focus(); return document.activeElement === t ? 'ok' : 'nofocus'; })()`,
}[target];
if (!pick) throw new Error(`unknown target ${target}`);
const focus = await evaluate(pick);
console.log('focus', focus);
if (focus !== 'ok') { sock.close(); process.exit(2); }
const startLength = await evaluate('document.activeElement.value?.length ?? null');

const text = '가나다라마바사아자차카타파하 ';
const latencies = [];
const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
let before = await metrics();
for (let i = 0; i < Number(count); i++) {
  const t0 = performance.now();
  await send('Input.insertText', { text: text[i % text.length] });
  await evaluate('new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))');
  latencies.push(performance.now() - t0);
  if ((i + 1) % bucket === 0) {
    const after = await metrics();
    const slice = latencies.slice(-bucket).sort((a, b) => a - b);
    const per = (key) => ((after[key] - before[key]) * 1000 / bucket).toFixed(1);
    console.log(`chars ${i + 1}: median ${slice[Math.floor(bucket / 2)].toFixed(1)}ms p90 ${slice[Math.floor(bucket * 0.9)].toFixed(1)}ms  task ${per('TaskDuration')}ms/char script ${per('ScriptDuration')} style ${per('RecalcStyleDuration')} layout ${per('LayoutDuration')}`);
    before = after;
  }
}
if (target !== 'terminal') {
  const typed = (await evaluate('document.activeElement.value?.length ?? null')) - (startLength ?? 0);
  console.log(typed === Number(count) ? `typed ${typed} (valid)` : `typed ${typed} of ${count} (INVALID: input went elsewhere)`);
  // Leave nothing behind in the page's draft.
  await evaluate(`(() => { const t = document.activeElement; if (t && 'value' in t) { t.value = t.value.slice(0, ${startLength ?? 0}); t.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
}
sock.close();
