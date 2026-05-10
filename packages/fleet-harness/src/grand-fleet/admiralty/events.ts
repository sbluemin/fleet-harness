import type { ExtensionAPI, ExtensionContext } from "@sbluemin/fleet-coding-agent";

import { buildAdmiraltySystemPrompt } from "@sbluemin/fleet-core/admiralty";

import { getState } from "../state.js";
import {
  clearAdmiraltyRuntimePresenter,
  disposeAdmiraltyRuntime,
  disposeRosterListener,
  ensureAdmiraltyRuntime,
  getAdmiraltyRegistry,
  getAdmiraltyServer,
  setRosterListenerDisposer,
} from "./runtime.js";
import { initRosterWidget, disposeRosterWidget, syncRosterWidget } from "./roster-widget.js";
import { setEditorBorderColor, setEditorRightLabel } from "../../hud/border-bridge.js";

const ADMIRALTY_COLOR = "\x1b[38;2;255;200;60m";

export function registerAdmiraltyPiEvents(pi: ExtensionAPI): void {
  const runtime = ensureAdmiraltyRuntime();

  pi.on("before_agent_start", () => {
    const roster = getAdmiraltyRegistry().getRoster();
    const systemPrompt = buildAdmiraltySystemPrompt(roster);
    return { systemPrompt };
  });

  pi.on("session_start", async (_event, ctx) => {
    setEditorBorderColor(ADMIRALTY_COLOR);
    setEditorRightLabel(`${ADMIRALTY_COLOR}⚓ Admiralty\x1b[0m`);
    const state = getState();
    if (!state) return;

    state.socketPath = runtime.socketPath;

    try {
      await runtime.server.start();
      notify(ctx, `[Grand Fleet] Admiralty 서버 기동: ${runtime.socketPath}`, "info");
      initRosterWidget(ctx);
      setRosterListenerDisposer(getAdmiraltyRegistry().onChange(syncRosterWidget));
      syncRosterWidget();
    } catch (err) {
      notify(ctx, `[Grand Fleet] 서버 기동 실패: ${toErrorMessage(err)}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    disposeRosterListener();
    disposeRosterWidget();
    clearAdmiraltyRuntimePresenter();
    getAdmiraltyRegistry().shutdown();
    await getAdmiraltyServer().close();
    disposeAdmiraltyRuntime();
  });
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "error",
): void {
  ctx.ui.notify(message, level);
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
