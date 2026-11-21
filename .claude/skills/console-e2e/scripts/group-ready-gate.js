// Read-only readiness gate for a Console group conversation, judged in the page just before a measurement starts.
// Installs `window.__fleetGroupReady` = { judge, confirm, settle }. Procedure: references/seed.md (group-scale) — expectations come from `seed/group-scale.mjs`.
// Load it with agent-browser `--init-script` (or `eval --stdin < this-file`), then call `judge(<one group's "expect" object>)`.
//
// Contract. A verdict is `{ ok, reason, detail, docId, at, ... }`; `reason` is null only when ok.
//   wrong-document     the page is not the Console objectives route, or the tab is hidden
//   wrong-screen       the group conversation log is missing, inert or has no box (another screen is up)
//   no-active-group    the sidebar does not name exactly one active objective
//   short-control      the active objective is one of `expect.shortControlIds` (the short comparison group)
//   wrong-group        another objective is active, or the log carries messages of a participant outside this group
//   partial            the right group is active but its records are not all drawn: fewer rows, a missing first/last marker,
//                      aria-busy, or a truncation/unavailable notice. Row counts are floors, never exact counts.
//   viewport-unrendered  the rows at the current viewport are empty, skipped or have no height, or no expected marker is in view
//   stale-token        confirm() was handed a verdict from another document, an older moment, another viewport or another group
// Identification of the active screen (sidebar) and the row evidence (log) are separate checks; both must agree.
// Safety: it only reads. It never scrolls, clicks, types, fetches, or measures rows outside the viewport. Text is read from
// every row (no layout), but geometry only from the log box and from rows hit by points inside the viewport. CSS deferral
// values (data-defer-layout, content-visibility) appear in `diag` and never decide the verdict.
(() => {
  const ROUTE = /^\/(console\/)?objectives(\/|$)/;
  const MARKER = /GS-[A-Z]+-[a-z]+-T\d{3}-[QA]/;
  const ROW = ".group-chat-column > [data-entry-id]";
  const SAMPLE_FRACTIONS = [0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.9];
  const DEFAULT_MAX_AGE_MS = 5000;
  const docId = `${performance.timeOrigin}:${Math.random().toString(36).slice(2, 10)}`;

  /** Gather facts. Reads text of all rows, geometry of the log and of the few rows under sample points only. */
  function collect(expect) {
    const log = document.querySelector('.group-chat > .group-chat-log[role="log"]');
    const snapshot = {
      path: location.pathname,
      hidden: document.visibilityState === "hidden" || document.hidden === true,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      active: [],
      log: null,
      rows: [],
      notices: [],
      sample: [],
      diag: { deferRows: 0, skippedSample: 0, pointerFine: false, contentVisibility: false },
    };
    for (const item of document.querySelectorAll("li.side-bar-cluster-row--active[data-side-bar-chip-id]")) {
      if (item.querySelector('[aria-current="true"]')) snapshot.active.push(item.getAttribute("data-side-bar-chip-id"));
    }
    snapshot.diag.pointerFine = matchMedia("(pointer: fine)").matches;
    snapshot.diag.contentVisibility = typeof CSS !== "undefined" && CSS.supports("content-visibility", "auto");
    if (!log) return snapshot;
    const box = log.getBoundingClientRect();
    snapshot.log = { inert: !!log.closest("[inert]"), width: box.width, height: box.height, busy: log.getAttribute("aria-busy") };
    for (const row of log.querySelectorAll(ROW)) {
      const id = row.getAttribute("data-entry-id") ?? "";
      const parts = id.split(":");
      const hit = MARKER.exec(row.textContent ?? "");
      snapshot.rows.push({ kind: parts[0], objectiveId: parts[0] === "message" ? parts[1] : null, marker: hit ? hit[0] : null });
    }
    snapshot.diag.deferRows = log.querySelectorAll(".group-chat-column > [data-defer-layout]").length;
    for (const notice of log.querySelectorAll(".group-chat-notice")) snapshot.notices.push((notice.textContent ?? "").slice(0, 80));
    // Only the rows under points inside the log's visible box: the dock and header may cover some, which then yield no row.
    const seen = new Set();
    const x = box.left + box.width / 2;
    for (const fraction of SAMPLE_FRACTIONS) {
      for (const element of document.elementsFromPoint(x, box.top + box.height * fraction)) {
        const row = element.closest(ROW);
        if (!row || !log.contains(row)) continue;
        if (!seen.has(row)) {
          seen.add(row);
          const rect = row.getBoundingClientRect();
          const hit = MARKER.exec(row.textContent ?? "");
          const skipped = typeof row.checkVisibility === "function" && row.checkVisibility({ contentVisibilityAuto: true }) === false;
          snapshot.sample.push({ id: row.getAttribute("data-entry-id"), height: rect.height, textLength: (row.textContent ?? "").trim().length, marker: hit ? hit[0] : null, skipped });
          if (skipped) snapshot.diag.skippedSample += 1;
        }
        break;
      }
    }
    return snapshot;
  }

  function reject(reason, detail, extra) {
    return { ok: false, reason, detail, ...extra };
  }

  /** Pure: facts + one group's expectation -> verdict. No DOM access, so it can be tested without a page. */
  function decide(snapshot, expect) {
    const base = { active: snapshot.active, viewport: snapshot.viewport, diag: snapshot.diag };
    const rootId = expect.rootObjectiveId;
    if (!ROUTE.test(snapshot.path)) return reject("wrong-document", `path ${snapshot.path}`, base);
    if (snapshot.hidden) return reject("wrong-document", "document hidden", base);
    if (!snapshot.log || snapshot.log.inert || !(snapshot.log.width > 0) || !(snapshot.log.height > 0)) {
      return reject("wrong-screen", !snapshot.log ? "no group log" : snapshot.log.inert ? "log inert" : "log has no box", base);
    }
    const distinct = [...new Set(snapshot.active)];
    if (distinct.length !== 1) return reject("no-active-group", `${distinct.length} active objectives`, base);
    if (distinct[0] !== rootId) {
      const control = (expect.shortControlIds ?? []).includes(distinct[0]);
      return reject(control ? "short-control" : "wrong-group", `active ${distinct[0]}`, base);
    }
    const members = new Set(expect.participants.map((person) => person.objectiveId));
    const messages = snapshot.rows.filter((row) => row.kind === "message");
    const foreign = messages.filter((row) => !members.has(row.objectiveId));
    if (foreign.length > 0) return reject("wrong-group", `${foreign.length} message rows from outside this group`, base);

    const evidence = expect.participants.map((person) => {
      const own = new Set(messages.filter((row) => row.objectiveId === person.objectiveId && row.marker !== null).map((row) => row.marker));
      return { role: person.role, have: own.size, need: person.rows, first: own.has(person.firstMarker), last: own.has(person.lastMarker) };
    });
    const missing = evidence.filter((item) => item.have < item.need || !item.first || !item.last);
    const waiting = [];
    if (snapshot.log.busy === "true") waiting.push("aria-busy");
    if (snapshot.notices.length > 0) waiting.push(`notice: ${snapshot.notices.join(" | ")}`);
    if (missing.length > 0 || waiting.length > 0) {
      return reject("partial", [...waiting, ...missing.map((item) => `${item.role} ${item.have}/${item.need} first=${item.first} last=${item.last}`)].join("; "), { ...base, evidence });
    }

    const want = expect.viewport;
    if (want && (snapshot.viewport.width !== want.width || snapshot.viewport.height !== want.height)) {
      return reject("viewport-unrendered", `viewport ${snapshot.viewport.width}x${snapshot.viewport.height}, wanted ${want.width}x${want.height}`, { ...base, evidence });
    }
    const flawed = snapshot.sample.filter((row) => row.skipped || !(row.height > 0) || row.textLength === 0);
    if (snapshot.sample.length === 0) return reject("viewport-unrendered", "no row under the viewport sample points", { ...base, evidence });
    if (flawed.length > 0) return reject("viewport-unrendered", `${flawed.length}/${snapshot.sample.length} sampled rows empty, skipped or without height`, { ...base, evidence });
    // At least one row in view must carry a record of this group (the marker names its participant role), not only chrome rows.
    if (!snapshot.sample.some((row) => row.marker !== null && expect.participants.some((person) => row.marker.includes(`-${person.role}-`)))) {
      return reject("viewport-unrendered", "no expected-group marker row in view", { ...base, evidence });
    }
    return { ok: true, reason: null, detail: "", ...base, evidence, rows: { total: snapshot.rows.length, messages: messages.length }, sampled: snapshot.sample.length };
  }

  function judge(expect) {
    if (!expect || typeof expect.rootObjectiveId !== "string" || !Array.isArray(expect.participants)) throw new Error("judge needs an expect object from group-scale.json");
    const verdict = decide(collect(expect), expect);
    return { ...verdict, docId, at: Date.now(), rootObjectiveId: expect.rootObjectiveId };
  }

  /**
   * Is an earlier verdict still usable? It never revalidates on its own: any change of document (reload), age, viewport or
   * active group makes it stale-token, and even a still-valid token is only accepted together with a fresh passing judgement.
   */
  function confirm(previous, expect, options) {
    const maxAge = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const now = judge(expect);
    if (!previous || previous.ok !== true) return reject("stale-token", "no passing verdict to confirm", { docId, at: now.at });
    if (previous.docId !== docId) return reject("stale-token", "verdict is from another document (reload or new page)", { docId, at: now.at });
    if (now.at - previous.at > maxAge) return reject("stale-token", `verdict older than ${maxAge}ms`, { docId, at: now.at });
    if (previous.rootObjectiveId !== expect.rootObjectiveId) return reject("stale-token", "verdict is for another group", { docId, at: now.at });
    const before = previous.viewport;
    if (before.width !== now.viewport.width || before.height !== now.viewport.height) return reject("stale-token", "viewport changed since the verdict", { docId, at: now.at });
    return now;
  }

  /** Judge again every `intervalMs` until it passes or `timeoutMs` ends. Keeps the earliest rejection and each distinct reason seen. */
  async function settle(expect, options) {
    const timeout = options?.timeoutMs ?? 15000;
    const interval = options?.intervalMs ?? 250;
    const started = Date.now();
    const reasons = [];
    let first = null;
    for (;;) {
      const verdict = judge(expect);
      if (verdict.ok) return { verdict, firstRejected: first, reasons };
      first ??= verdict;
      if (!reasons.includes(verdict.reason)) reasons.push(verdict.reason);
      if (Date.now() - started >= timeout) return { verdict, firstRejected: first, reasons };
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  window.__fleetGroupReady = { judge, confirm, settle, docId };
})();
