// Which selectors invalidate whole subtrees: node cdp-invalidation-trace.mjs <pageWs> <chars>
// Types into the already-focused element with invalidation tracking on, then prints subtree-invalidating
// selectors, the most frequent invalidation records, and the stack of large style recalculations.
const [wsUrl, count] = process.argv.slice(2);
const sock = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const events = [];
let finished;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, { resolve, reject });
  sock.send(JSON.stringify({ id: i, method, params }));
});
sock.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.method === 'Tracing.dataCollected') events.push(...data.params.value);
  if (data.method === 'Tracing.tracingComplete') finished();
  if (!data.id || !pending.has(data.id)) return;
  const entry = pending.get(data.id);
  pending.delete(data.id);
  data.error ? entry.reject(new Error(data.error.message)) : entry.resolve(data.result);
};
await new Promise((resolve) => { sock.onopen = resolve; });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
console.log('focused', await evaluate('document.activeElement?.tagName + " " + (document.activeElement?.getAttribute("aria-label") ?? "")'));
await send('Tracing.start', {
  categories: 'devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking,disabled-by-default-devtools.timeline.stack',
  transferMode: 'ReportEvents',
});
for (let i = 0; i < Number(count); i++) {
  await send('Input.insertText', { text: '가' });
  await evaluate('new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))');
}
const complete = new Promise((resolve) => { finished = resolve; });
await send('Tracing.end');
await complete;

const selectors = new Map();
const records = new Map();
for (const event of events) {
  const data = event.args?.data ?? {};
  if (event.name === 'StyleInvalidatorInvalidationTracking' && /subtree/i.test(data.reason ?? '')) {
    for (const selector of data.selectors ?? []) selectors.set(selector.selector, (selectors.get(selector.selector) ?? 0) + 1);
  }
  if (/InvalidationTracking/.test(event.name)) {
    const key = `${event.name} | ${data.reason ?? ''} | ${(data.nodeName ?? '').slice(0, 60)}`;
    records.set(key, (records.get(key) ?? 0) + 1);
  }
}
console.log('\nsubtree-invalidating selectors:');
[...selectors].sort((a, b) => b[1] - a[1]).forEach(([selector, n]) => console.log(n, selector));
console.log('\nmost frequent invalidation records:');
[...records].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([key, n]) => console.log(n, key));
const large = events.filter((event) => event.name === 'UpdateLayoutTree' && (event.args?.elementCount ?? 0) > 1000);
console.log(`\nstyle recalcs over 1000 elements: ${large.length}`, large[0] ? JSON.stringify(large[0].args?.beginData?.stackTrace?.slice(0, 3) ?? null) : '');
sock.close();
