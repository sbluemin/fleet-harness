import type { ChromeControl, ChromeUiState } from "../contract.js";
import { agentGlyph, clear, G, glyph, h } from "./dom.js";
import { paintColors, post, shownSpace, spaceName, tr } from "./shared.js";

/** 커서 글리프(16 단위)의 끝점 — 18px 로 그린 그림에서 이만큼 안쪽이 실제로 가리키는 자리다. */
const TIP = { x: 3.2 * 18 / 16, y: 2.6 * 18 / 16 };

/**
 * 가드 문서 — 페이지 바로 위에 서는 제어권의 화면. 에이전트가 표시 탭을 모는 동안에는 이 뷰가 페이지 자리 전체를 덮어 사람의 포인터가 페이지에 닿지 않고,
 * 조작 중 애니메이션과 에이전트 커서를 그린다. 사람이 제어를 쥔 동안에는 뷰가 알약 자리만 차지한다(자리는 main 이 정한다 — 이 문서는 알약 크기만 알려 준다).
 * 페이지와는 다른 문서라 페이지 DOM 에도, 에이전트가 찍는 스크린샷에도 섞이지 않는다.
 */
export function mountGuard(): (state: ChromeUiState) => void {
  // 조작 중 애니메이션의 층들 — 모양과 움직임은 CSS 가 정하고, 여기서는 커서 자리와 누름만 알려 준다.
  const ripple = h("div", { class: "guard-ripple" });
  const fx = h("div", { class: "guard-fx", attrs: { "aria-hidden": "true" } },
    h("div", { class: "guard-dots" }), h("div", { class: "guard-halo" }),
    ...["top", "bottom", "left", "right"].flatMap((side) => [h("div", { class: `guard-spectrum ${side}` }), h("div", { class: `guard-spectrum ${side} b` })]),
    h("div", { class: "guard-edge" }), h("div", { class: "guard-beam" }),
    h("div", { class: "guard-corner tl" }), h("div", { class: "guard-corner tr" }), h("div", { class: "guard-corner br" }), h("div", { class: "guard-corner bl" }), ripple);
  const cursorGlyph = glyph(G.pointer, 18);
  const cursorLabel = h("span", { class: "guard-cursor-label" });
  const cursor = h("div", { class: "guard-cursor", attrs: { "aria-hidden": "true" } }, cursorGlyph, cursorLabel);
  const mark = h("span", { class: "guard-mark", attrs: { "aria-hidden": "true" } });
  const title = h("strong", { class: "guard-title" });
  const status = h("small", { class: "guard-status" });
  let held: ChromeControl | null = null;
  const primary = h("button", { class: "guard-button", type: "button", on: { click: () => { if (held) post("guard", "control", { control: held.holder === "agent" ? "take" : "return" }); } } });
  const stop = h("button", { class: "guard-button stop", type: "button", on: { click: () => post("guard", "control", { control: "stop" }) } });
  const pill = h("div", { class: "guard-pill", role: "group" }, mark, h("span", { class: "guard-who" }, title, status), primary, stop);
  const root = h("div", { class: "guard" }, fx, cursor, pill);
  root.hidden = true;
  document.body.append(root);

  // 막힌 자리를 누르면 알약이 한 번 움찔한다 — 왜 페이지가 반응하지 않는지 그 자리에서 알 수 있게.
  root.addEventListener("pointerdown", (event) => {
    if (held?.holder !== "agent" || pill.contains(event.target as Node)) return;
    pill.classList.remove("nudge");
    void pill.offsetWidth;
    pill.classList.add("nudge");
  });
  pill.addEventListener("animationend", () => pill.classList.remove("nudge"));

  // 알약 크기를 main 에 알린다 — 사람이 제어 중일 때 뷰가 그 자리만 차지해야 페이지의 나머지를 그대로 쓸 수 있다.
  let reported = "";
  const report = (): void => {
    if (root.hidden) return;
    const box = pill.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const key = `${Math.ceil(box.width)}x${Math.ceil(box.height)}`;
    if (key === reported) return;
    reported = key;
    post("guard", "guard-size", { width: Math.ceil(box.width), height: Math.ceil(box.height) });
  };
  new ResizeObserver(report).observe(pill);

  let markKind = "";
  let seq = -1;
  return (state) => {
    paintColors(state.colors);
    document.documentElement.lang = state.lang;
    const t = tr(state);
    held = state.control;
    root.hidden = held === null;
    if (!held) { cursor.classList.remove("shown", "placed"); seq = -1; return; }
    const agent = held.holder === "agent";
    root.className = `guard ${agent ? "agent" : "user"}${held.reason ? " asked" : ""}`;
    // 알약은 페이지 자리보다 넓어지지 않는다.
    root.style.setProperty("--guard-room", `${Math.max(120, state.page.width - 16)}px`);
    if (markKind !== held.holder) { markKind = held.holder; clear(mark); mark.append(agent ? agentGlyph() : glyph(G.pointer, 12)); }
    const name = spaceName(t, shownSpace(state));
    title.textContent = held.reason ?? name;
    title.title = held.reason ?? "";
    status.textContent = agent ? t("control.agent") : held.reason ? `${name} · ${t("control.needsYou")}` : t("control.user");
    primary.textContent = t(agent ? "control.take" : "control.return");
    stop.textContent = t("control.stop");
    pill.setAttribute("aria-label", `${name} · ${t(agent ? "control.agent" : "control.user")}`);
    root.title = agent ? t("control.locked") : "";
    pill.title = "";
    // 에이전트 커서 — 처음 나타날 때는 그 자리에 바로 서고, 그 뒤로는 옮겨 간다.
    const pointer = agent ? held.pointer : null;
    if (!pointer) { cursor.classList.remove("shown", "placed"); seq = -1; root.style.removeProperty("--guard-x"); root.style.removeProperty("--guard-y"); }
    else {
      // 점 격자의 밝은 자리와 누름 고리가 같은 좌표를 쓴다.
      root.style.setProperty("--guard-x", `${pointer.x}px`); root.style.setProperty("--guard-y", `${pointer.y}px`);
      cursor.style.transform = `translate(${pointer.x - TIP.x}px, ${pointer.y - TIP.y}px)`;
      // 커서에는 그 도구를 쓰는 AI 의 이름이 붙는다 — 모르면 스페이스의 이름(사령관), 그것도 없으면 「에이전트」.
      cursorLabel.textContent = pointer.actor || (shownSpace(state)?.kind === "commodore" ? name : t("control.cursor.agent"));
      if (!cursor.classList.contains("shown")) { cursor.classList.add("shown"); requestAnimationFrame(() => cursor.classList.add("placed")); }
      if (pointer.seq !== seq) {
        seq = pointer.seq;
        cursor.classList.remove("click"); ripple.classList.remove("go");
        if (pointer.kind === "click") { void cursor.offsetWidth; cursor.classList.add("click"); ripple.classList.add("go"); }
      }
    }
    report();
  };
}
