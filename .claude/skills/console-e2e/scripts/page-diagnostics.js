// agent-browser --init-script installed before the first page load (references/agent-browser.md#open-with-instrumentation).
// Pass scenario probes or fetch mocks as a second --init-script on the same open instead of editing a copy of this file.
(() => {
  const state = window.__fleetE2E = { errors: [], rejections: [], consoleErrors: [], sockets: [] };
  addEventListener('error', e => state.errors.push({ message: e.message, stack: e.error?.stack || '' }), true);
  addEventListener('unhandledrejection', e => state.rejections.push(String(e.reason?.stack || e.reason)));
  const nativeConsoleError = console.error.bind(console);
  console.error = (...args) => { state.consoleErrors.push(args.map(String).join(' ')); nativeConsoleError(...args); };
  const Native = window.WebSocket;
  function Tracked(...args) {
    const socket = new Native(...args);
    const target = new URL(String(args[0]), location.href);
    const record = { url: target.origin + target.pathname, closed: false }; // query can carry a WS ticket; never record it
    state.sockets.push(record);
    socket.addEventListener('close', () => { record.closed = true; });
    return socket;
  }
  Tracked.prototype = Native.prototype;
  Object.setPrototypeOf(Tracked, Native);
  window.WebSocket = Tracked;
})();
