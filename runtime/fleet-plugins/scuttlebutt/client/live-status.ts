import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { formatLiveElapsed } from "@fleet-console/sdk/components/live-line";

import { exchangeReceipt, exchangeTools, type ChatEntry, type ChatState } from "./chat-store.js";
import { getT } from "./scuttlebutt-catalog.js";

/**
 * 도구 제목을 계열로 푼다. 서버는 내장 도구를 `이름: 인자`로, Console·컴퓨터 도구를 MCP 이름 그대로
 * 보낸다 — 인자는 화면에 내지 않고 대상 한 조각(호스트·질의)만 남긴다.
 */
export type ToolFamily = "search" | "read" | "console" | "direct" | "computer" | "wiki" | "tool";

const CONSOLE_DIRECT = new Set(["console_launch", "console_send", "console_interrupt", "console_action", "console_automation"]);

export function toolFamily(title: string): ToolFamily {
  const [name] = title.split(":", 1);
  const lowered = (name ?? "").trim().toLowerCase();
  if (lowered.startsWith("mcp__fleet-computer-use__")) return "computer";
  if (lowered.startsWith("mcp__fleet-console-use__")) {
    return CONSOLE_DIRECT.has(lowered.slice("mcp__fleet-console-use__".length)) ? "direct" : "console";
  }
  if (lowered.startsWith("console_wiki")) return "wiki";
  if (lowered.includes("search")) return "search";
  if (lowered.includes("fetch") || lowered.includes("read")) return "read";
  return "tool";
}

/** 문구 뒤에 붙는 대상 한 조각 — 검색어, 읽는 페이지의 호스트, Wiki 질의. Console·컴퓨터 도구는 대상을 내지 않는다. */
export function toolDetail(entry: Extract<ChatEntry, { kind: "tool" }>): string | undefined {
  const family = toolFamily(entry.title);
  const colon = entry.title.indexOf(":");
  const argument = colon >= 0 ? entry.title.slice(colon + 1).trim() : "";
  if (family === "read") {
    const url = entry.url ?? argument;
    try {
      const parsed = new URL(url);
      const segment = parsed.pathname.split("/").filter(Boolean)[0];
      const host = parsed.hostname.replace(/^www\./u, "");
      return segment ? `${host}/${segment.length > 24 ? `${segment.slice(0, 22)}…` : segment}` : host;
    } catch {
      return argument || undefined;
    }
  }
  if (family === "search" || family === "wiki") return argument ? (argument.length > 48 ? `${argument.slice(0, 46)}…` : argument) : undefined;
  return undefined;
}

function toolName(entry: Extract<ChatEntry, { kind: "tool" }>): string {
  const [name] = entry.title.split(":", 1);
  return (name ?? entry.title).trim();
}

export function liveVerb(entry: Extract<ChatEntry, { kind: "tool" }>, locale: ConsoleLocale | undefined): string {
  const t = getT(locale);
  const family = toolFamily(entry.title);
  return family === "tool" ? t("live.tool", { name: toolName(entry) }) : t(`live.${family}`);
}

export function pastVerb(entry: Extract<ChatEntry, { kind: "tool" }>, locale: ConsoleLocale | undefined): string {
  const t = getT(locale);
  const family = toolFamily(entry.title);
  return family === "tool" ? t("past.tool", { name: toolName(entry) }) : t(`past.${family}`);
}

export interface LiveStatus {
  readonly label: string;
  readonly thinking: boolean;
  readonly meta: string;
}

/**
 * 도는 문답의 "지금" — 도는 도구가 있으면 그 동사와 대상, 글자가 흐르면 「답을 쓰는 중」, 둘 다
 * 없으면 「생각 중…」. 오른쪽 끝에는 스텝 수와 경과.
 */
export function liveStatus(exchange: readonly ChatEntry[], locale: ConsoleLocale | undefined, now: number): LiveStatus {
  const t = getT(locale);
  const tools = exchangeTools(exchange);
  const running = [...tools].reverse().find((entry) => entry.status === "running");
  const last = exchange.at(-1);
  const writing = !running && last?.kind === "assistant" && last.text.length > 0;
  const label = running
    ? `${liveVerb(running, locale)}${toolDetail(running) ? ` · ${toolDetail(running)}` : ""}`
    : writing ? t("live.write") : t("live.think");
  const startedAt = exchange.find((entry) => entry.kind === "user");
  const elapsed = formatLiveElapsed(startedAt?.kind === "user" ? now - startedAt.at : 0);
  const steps = tools.length;
  return {
    label,
    thinking: !running && !writing,
    meta: steps > 0 ? `${steps > 1 ? t("fold.steps", { count: String(steps), elapsed }) : t("fold.oneStep", { elapsed })}` : elapsed,
  };
}

export interface FoldStatus {
  readonly summary: string;
  readonly tone: "done" | "stopped" | "error";
  readonly steps: readonly { readonly mark: "done" | "fail"; readonly label: string; readonly detail?: string }[];
}

/** 끝난 문답의 접힘 한 줄. 스텝이 없고 정상 완료면 줄 자체가 서지 않는다(null). */
export function foldStatus(exchange: readonly ChatEntry[], locale: ConsoleLocale | undefined): FoldStatus | null {
  const t = getT(locale);
  const receipt = exchangeReceipt(exchange);
  if (!receipt) return null;
  const tools = exchangeTools(exchange);
  if (tools.length === 0 && receipt.outcome === "done") return null;
  const elapsed = formatLiveElapsed(receipt.durationMs);
  const summary = receipt.outcome === "stopped"
    ? t("fold.stopped", { elapsed })
    : receipt.outcome === "error"
      ? t("fold.failed", { elapsed })
      : tools.length === 1 ? t("fold.oneStep", { elapsed }) : t("fold.steps", { count: String(tools.length), elapsed });
  return {
    summary,
    tone: receipt.outcome,
    steps: tools.map((entry) => ({
      mark: entry.status === "error" ? "fail" : "done",
      label: pastVerb(entry, locale),
      ...(toolDetail(entry) ? { detail: toolDetail(entry) } : {}),
    })),
  };
}

export function isBusy(state: ChatState): boolean {
  return state.phase === "starting" || state.phase === "thinking";
}
