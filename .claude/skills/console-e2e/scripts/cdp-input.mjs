#!/usr/bin/env node
/**
 * Exact CDP input for references/cdp-input.md: one key press, and a coarse-pointer/touch emulation holder.
 *
 *   node cdp-input.mjs key   --cdp <port|ws-url> --url-prefix <prefix> --key <key> [--modifiers Alt,Control,Meta,Shift]
 *                            [--settle-ms 500] [--emulate-focus]
 *   node cdp-input.mjs hold  --cdp <port|ws-url> --url-prefix <prefix> --log <abs.jsonl> [--interval-ms 500] [--max-minutes 60]
 *   node cdp-input.mjs probe --cdp <port|ws-url> --url-prefix <prefix>
 *
 * `--cdp` is a loopback DevTools port or the browser WebSocket URL (`agent-browser get cdp-url`). `--url-prefix`
 * must match exactly one page target, normally `http://127.0.0.1:<port>/console/`. Targets are reported as
 * origin + pathname only.
 *
 * key   sends exactly one keyDown/keyUp pair. Modifiers ride on that pair as flags; no separate modifier key events
 *       are sent. For --settle-ms it counts keydown/keyup/keypress in the page's main frame with a capture-phase
 *       window listener plus a temporary wrap of Event stopPropagation/stopImmediatePropagation, so an event a page
 *       handler swallows still counts (as consumedByPage); both are removed afterwards. Exit 0 when exactly one
 *       keydown and one keyup arrived, 2 otherwise.
 * hold  keeps one CDP session attached and holds pointer:coarse, hover:none and touch emulation. Overrides die with
 *       the session, so the process must stay alive for the whole scenario. It re-checks every --interval-ms and
 *       re-applies when another client reset the state, logging a `reapplied` event. Stop it with SIGTERM.
 * probe read-only: prints the page's pointer/hover/touch state from a separate session and changes nothing.
 *       Exit 0 when coarse, hover:none and touch points are all present, 2 otherwise.
 *
 * No call activates a window or tab: Page.bringToFront, Target.activateTarget and Browser.setWindowBounds are
 * refused by the client itself. Exit 1 means the helper failed, not that the page misbehaved.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';

const FORBIDDEN_METHODS = new Set(['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds']);
const COMMAND_TIMEOUT_MS = 10_000;
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

// key -> [code, windowsVirtualKeyCode, text?, location?]
const NAMED_KEYS = {
  Escape: ['Escape', 27], Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Backspace: ['Backspace', 8],
  Delete: ['Delete', 46], Insert: ['Insert', 45], ' ': ['Space', 32, ' '], Space: ['Space', 32, ' '],
  ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
  Alt: ['AltLeft', 18, undefined, 1], Control: ['ControlLeft', 17, undefined, 1],
  Meta: ['MetaLeft', 91, undefined, 1], Shift: ['ShiftLeft', 16, undefined, 1],
  '/': ['Slash', 191, '/'], '.': ['Period', 190, '.'], ',': ['Comma', 188, ','], '-': ['Minus', 189, '-'],
  '=': ['Equal', 187, '='], ';': ['Semicolon', 186, ';'], "'": ['Quote', 222, "'"], '`': ['Backquote', 192, '`'],
  '[': ['BracketLeft', 219, '['], ']': ['BracketRight', 221, ']'], '\\': ['Backslash', 220, '\\'],
};
for (let n = 1; n <= 12; n += 1) NAMED_KEYS[`F${n}`] = [`F${n}`, 111 + n];

const MEDIA_FEATURES = [
  { name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' },
  { name: 'any-pointer', value: 'coarse' }, { name: 'any-hover', value: 'none' },
];

const STATE_EXPRESSION = `(() => {
  const m = (q) => matchMedia(q).matches;
  return {
    pointerCoarse: m('(pointer: coarse)'), pointerFine: m('(pointer: fine)'),
    hoverNone: m('(hover: none)'), anyPointerCoarse: m('(any-pointer: coarse)'), anyHoverNone: m('(any-hover: none)'),
    maxTouchPoints: navigator.maxTouchPoints, touchEvents: 'ontouchstart' in window,
    viewport: [innerWidth, innerHeight], visibilityState: document.visibilityState,
  };
})()`;

function fail(message) {
  process.stderr.write(`cdp-input: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!flag.startsWith('--')) fail(`unexpected argument ${JSON.stringify(flag)}`);
    const name = flag.slice(2);
    if (name === 'emulate-focus') { options[name] = true; continue; }
    if (i + 1 >= rest.length) fail(`${flag} needs a value`);
    options[name] = rest[i + 1];
    i += 1;
  }
  return { mode, options };
}

function positiveInt(value, fallback, label) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) fail(`${label} must be a positive integer`);
  return n;
}

function isLoopback(hostname) {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
}

async function browserWsUrl(cdp) {
  if (/^\d+$/.test(cdp)) {
    const port = Number(cdp);
    if (port < 1 || port > 65535) fail('--cdp port is out of range');
    const url = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) })
      .then((response) => response.json())
      .then((version) => version.webSocketDebuggerUrl)
      .catch((error) => fail(`cannot read DevTools port ${port}: ${error.message}`));
    if (typeof url !== 'string') fail('the DevTools port did not report a browser WebSocket URL');
    cdp = url;
  }
  let parsed;
  try { parsed = new URL(cdp); } catch { fail('--cdp must be a port or a ws:// URL'); }
  if (parsed.protocol !== 'ws:' || !isLoopback(parsed.hostname)) fail('--cdp must point at a loopback ws:// endpoint');
  return cdp;
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
      for (const listener of this.listeners) listener({ method: 'cdp-input.closed' });
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out')), COMMAND_TIMEOUT_MS);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP connection failed')); };
    });
    return new CdpClient(ws);
  }

  send(method, params = {}, sessionId) {
    if (FORBIDDEN_METHODS.has(method)) return Promise.reject(new Error(`${method} would take window focus; refused`));
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${COMMAND_TIMEOUT_MS / 1000}s`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.ws.onclose = null;
    this.ws.close();
  }
}

function describeTarget(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

async function attachPage(client, prefix) {
  const { targetInfos } = await client.send('Target.getTargets');
  const pages = targetInfos.filter((target) => target.type === 'page' && target.url.startsWith(prefix));
  if (pages.length !== 1) {
    fail(`--url-prefix matched ${pages.length} page targets; it must match exactly one`);
  }
  const { sessionId } = await client.send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true });
  return { sessionId, targetId: pages[0].targetId, target: describeTarget(pages[0].url) };
}

async function evaluate(client, sessionId, expression) {
  const reply = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (reply.exceptionDetails) throw new Error(`page evaluation failed: ${reply.exceptionDetails.text}`);
  return reply.result.value;
}

function keyDefinition(key, modifierNames) {
  let modifiers = 0;
  for (const name of modifierNames) {
    if (!(name in MODIFIER_BITS)) fail(`unknown modifier ${JSON.stringify(name)}; use Alt, Control, Meta, Shift`);
    modifiers |= MODIFIER_BITS[name];
  }
  let code;
  let keyCode;
  let text;
  let location;
  if (key in NAMED_KEYS) {
    [code, keyCode, text, location] = NAMED_KEYS[key];
  } else if (/^[a-zA-Z]$/.test(key)) {
    code = `Key${key.toUpperCase()}`;
    keyCode = key.toUpperCase().charCodeAt(0);
    text = key;
  } else if (/^\d$/.test(key)) {
    code = `Digit${key}`;
    keyCode = key.charCodeAt(0);
    text = key;
  } else {
    fail(`unsupported key ${JSON.stringify(key)}; use a named key (Escape, Enter, Tab, ArrowUp, F1, Alt, ...) or one ASCII letter, digit, or punctuation mark`);
  }
  // A command chord produces no character, so it is a raw key down like Escape.
  if (modifiers & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) text = undefined;
  // No nativeVirtualKeyCode: macOS Chromium reads it as a mac key code, and Escape's Windows code 27 is kVK_ANSI_Minus,
  // which floods thousands of Unidentified/Minus keydowns that never stop.
  const base = {
    // DOM의 스페이스 키 값은 " "이다. 별칭 "Space"를 그대로 보내면 event.key가 비어 `e.key === " "` 핸들러가 놓친다.
    key: code === 'Space' ? ' ' : key, code, modifiers, windowsVirtualKeyCode: keyCode,
    autoRepeat: false, isKeypad: false, ...(location ? { location } : {}),
  };
  return {
    down: { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}) },
    up: { ...base, type: 'keyUp' },
  };
}

function counterScript(runId) {
  return `(() => {
  const describe = (el) => el ? { tag: el.tagName, id: el.id || undefined, class: el.getAttribute?.('class') || undefined } : null;
  const rec = { keydown: 0, keyup: 0, keypress: 0, consumedByPage: 0, samples: [] };
  const types = new Set(['keydown', 'keyup', 'keypress']);
  const seen = new WeakSet();
  const count = (e, via) => {
    if (seen.has(e)) return;
    seen.add(e);
    rec[e.type] += 1;
    if (via !== 'listener') rec.consumedByPage += 1;
    if (rec.samples.length < 12) {
      rec.samples.push({ type: e.type, key: e.key, code: e.code, repeat: e.repeat, trusted: e.isTrusted,
        alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, target: describe(e.target)?.tag, via });
    }
  };
  // A page listener registered earlier on window capture (Console's global shortcuts) can stopImmediatePropagation
  // before this counter runs. Seeing the stop call counts the event anyway; the WeakSet keeps it counted once.
  const proto = Event.prototype;
  const originals = { stopImmediatePropagation: proto.stopImmediatePropagation, stopPropagation: proto.stopPropagation };
  const wrappers = {};
  for (const name of Object.keys(originals)) {
    wrappers[name] = function (...args) {
      if (this instanceof KeyboardEvent && types.has(this.type)) count(this, name);
      return originals[name].apply(this, args);
    };
    proto[name] = wrappers[name];
  }
  const handler = (e) => count(e, 'listener');
  for (const type of types) window.addEventListener(type, handler, true);
  (window.__fleetCdpInput ||= {})[${JSON.stringify(runId)}] = {
    rec,
    stop() {
      for (const type of types) window.removeEventListener(type, handler, true);
      for (const name of Object.keys(originals)) if (proto[name] === wrappers[name]) proto[name] = originals[name];
      return rec;
    },
  };
  return { hasFocus: document.hasFocus(), visibilityState: document.visibilityState, activeElement: describe(document.activeElement) };
})()`;
}

function collectScript(runId) {
  return `(() => {
  const entry = window.__fleetCdpInput?.[${JSON.stringify(runId)}];
  if (!entry) return null;
  delete window.__fleetCdpInput[${JSON.stringify(runId)}];
  return entry.stop();
})()`;
}

async function runKey(client, options) {
  if (!options.key) fail('key needs --key');
  const modifierNames = options.modifiers ? options.modifiers.split(',').map((name) => name.trim()).filter(Boolean) : [];
  const definition = keyDefinition(options.key, modifierNames);
  const settleMs = positiveInt(options['settle-ms'], 500, '--settle-ms');
  const { sessionId, target } = await attachPage(client, options['url-prefix']);
  if (options['emulate-focus']) await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  const runId = `run-${process.pid}-${Date.now()}`;
  const before = await evaluate(client, sessionId, counterScript(runId));
  await client.send('Input.dispatchKeyEvent', definition.down, sessionId);
  await client.send('Input.dispatchKeyEvent', definition.up, sessionId);
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  // A navigation caused by the key itself wipes the counter; report that rather than a zero count.
  const observed = await evaluate(client, sessionId, collectScript(runId)).catch((error) => ({ error: error.message }));
  await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  const exact = observed?.keydown === 1 && observed?.keyup === 1;
  const result = {
    target,
    sent: { pairs: 1, key: definition.down.key, code: definition.down.code, type: definition.down.type, modifiers: modifierNames },
    before,
    observed: observed ?? { error: 'counter missing after settle; the page navigated or reloaded' },
    settleMs,
    verdict: exact ? 'exact' : (observed?.keydown > 1 ? 'flood' : 'mismatch'),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return exact ? 0 : 2;
}

function isHeld(state) {
  return Boolean(state?.pointerCoarse && state.hoverNone && state.maxTouchPoints > 0);
}

async function applyCoarse(client, sessionId) {
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
  await client.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }, sessionId);
  await client.send('Emulation.setEmulatedMedia', { features: MEDIA_FEATURES }, sessionId);
}

async function runHold(client, options) {
  const log = options.log;
  if (!log || !path.isAbsolute(log)) fail('hold needs an absolute --log path (session scratchpad)');
  const intervalMs = positiveInt(options['interval-ms'], 500, '--interval-ms');
  const maxMinutes = positiveInt(options['max-minutes'], 60, '--max-minutes');
  const { sessionId, targetId, target } = await attachPage(client, options['url-prefix']);
  const emit = (event, extra = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...extra });
    appendFileSync(log, `${line}\n`);
    process.stdout.write(`${line}\n`);
  };

  let reapplied = 0;
  let stopping = false;
  const finish = (code, event, extra) => {
    if (stopping) return;
    stopping = true;
    emit(event, { reapplied, ...extra });
    client.send('Target.detachFromTarget', { sessionId }).catch(() => {}).finally(() => {
      client.close();
      process.exit(code);
    });
    setTimeout(() => process.exit(code), 2_000).unref();
  };

  client.listeners.add((message) => {
    if (message.method === 'cdp-input.closed') finish(3, 'cdp-closed');
    else if (message.method === 'Target.detachedFromTarget' && message.params.sessionId === sessionId) finish(3, 'detached');
    else if (message.method === 'Target.targetDestroyed' && message.params.targetId === targetId) finish(3, 'target-destroyed');
    else if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) {
      evaluate(client, sessionId, STATE_EXPRESSION).then((state) => emit('load', { held: isHeld(state), state })).catch(() => {});
    }
  });
  await client.send('Target.setDiscoverTargets', { discover: true });
  await client.send('Page.enable', {}, sessionId);
  await applyCoarse(client, sessionId);
  const initial = await evaluate(client, sessionId, STATE_EXPRESSION);
  emit('ready', { pid: process.pid, target, held: isHeld(initial), state: initial });

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => finish(0, 'stopped', { signal }));
  setTimeout(() => finish(0, 'expired', { maxMinutes }), maxMinutes * 60_000);

  let busy = false;
  setInterval(async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      const state = await evaluate(client, sessionId, STATE_EXPRESSION);
      if (!isHeld(state)) {
        await applyCoarse(client, sessionId);
        reapplied += 1;
        const after = await evaluate(client, sessionId, STATE_EXPRESSION);
        emit('reapplied', { count: reapplied, before: state, held: isHeld(after), state: after });
      }
    } catch {
      // A reload destroys the execution context mid-check; the next tick reads the new document.
    } finally {
      busy = false;
    }
  }, intervalMs);
  return new Promise(() => {});
}

async function runProbe(client, options) {
  const { sessionId, target } = await attachPage(client, options['url-prefix']);
  const state = await evaluate(client, sessionId, STATE_EXPRESSION);
  await client.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  process.stdout.write(`${JSON.stringify({ target, held: isHeld(state), state })}\n`);
  return isHeld(state) ? 0 : 2;
}

async function main() {
  const { mode, options } = parseArgs(process.argv.slice(2));
  const run = { key: runKey, hold: runHold, probe: runProbe }[mode];
  if (!run) fail('expected a mode: key, hold, or probe');
  if (!options.cdp || !options['url-prefix']) fail(`${mode} needs --cdp and --url-prefix`);
  const client = await CdpClient.connect(await browserWsUrl(options.cdp));
  const code = await run(client, options);
  client.close();
  process.exit(code);
}

main().catch((error) => fail(error.message));
