// agent-browser --init-script for a measurement client attached to a live Console.
// It must be impossible for this client to change server state, spawn a session, or reach a PTY.
(() => {
  const state = window.__fleetE2E = { errors: [], rejections: [], sockets: [], blockedFetch: [], blockedWs: 0, viewerTickets: 0 };
  addEventListener('error', (e) => state.errors.push({ message: e.message }));
  addEventListener('unhandledrejection', (e) => state.rejections.push(String((e.reason && e.reason.message) || e.reason)));

  // POST routes that only read. Add one only after reading its server handler.
  const READ_RPC = /\/plugins\/objectives\/(state|objective\/get)$/;
  const TICKET = /\/api\/v1\/agent\/ticket$/;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    const url = String((input && input.url) || input);
    const body = init && typeof init.body === 'string' ? init.body : '';
    if (method === 'GET' || method === 'HEAD') return nativeFetch(input, init);
    // Chat tickets are refused by the server for dormant sessions, so they cannot resume one.
    if (method === 'POST' && TICKET.test(url) && /"channel":"chat"/.test(body) && !/"role"/.test(body)) return nativeFetch(input, init);
    // Terminal tickets become viewer tickets: live PTYs only, no input, no resize, no spawn.
    if (method === 'POST' && TICKET.test(url) && body) {
      try {
        const parsed = JSON.parse(body);
        parsed.role = 'viewer';
        state.viewerTickets += 1;
        return nativeFetch(input, { ...init, body: JSON.stringify(parsed) });
      } catch {}
    }
    if (method === 'POST' && READ_RPC.test(url)) return nativeFetch(input, init);
    state.blockedFetch.push(`${method} ${url}`);
    return Promise.resolve(new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } }));
  };
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (String(method).toUpperCase() !== 'GET') { state.blockedFetch.push(`XHR ${method} ${url}`); url = 'about:blank'; }
    return nativeOpen.call(this, method, url, ...rest);
  };
  if (navigator.sendBeacon) navigator.sendBeacon = () => { state.blockedFetch.push('beacon'); return true; };

  const Native = window.WebSocket;
  const nativeSend = Native.prototype.send;
  Native.prototype.send = function (data) {
    // Terminal and chat sockets: nothing leaves (keystrokes, xterm query replies, commands, resize).
    if (/terminal|pty|agent/i.test(String(this.url || ''))) { state.blockedWs += 1; return; }
    if (typeof data === 'string' && /"type"\s*:\s*"resize"/.test(data)) { state.blockedWs += 1; return; }
    return nativeSend.call(this, data);
  };
  function Tracked(...args) {
    const socket = new Native(...args);
    const record = { url: String(args[0]).replace(/(ticket|token)=[^&]+/, '$1=<redacted>'), closed: false };
    state.sockets.push(record);
    socket.addEventListener('close', () => { record.closed = true; });
    return socket;
  }
  Tracked.prototype = Native.prototype;
  Object.setPrototypeOf(Tracked, Native);
  window.WebSocket = Tracked;
})();
