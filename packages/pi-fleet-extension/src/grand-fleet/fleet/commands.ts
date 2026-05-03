import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { infra } from "@sbluemin/fleet-core";
import { getState } from "../state.js";
import { connectToAdmiralty, disconnectFromAdmiralty, getFleetClient } from "./runtime.js";

const LOG_SOURCE = "grand-fleet";

export function registerFleetPiCommands(pi: ExtensionAPI): void {
  const state = getState();
  const fleetId = state?.fleetId ?? "unset";
  const log = infra.log.getLogAPI();

  pi.registerCommand("fleet:grand-fleet:connect", {
    description: "Admiralty에 접속 — Grand Fleet에 합류",
    handler: async (_args, ctx) => {
      if (getFleetClient()) {
        ctx.ui.notify("[Grand Fleet] 이미 연결되어 있습니다.", "warning");
        return;
      }

      const inputFleetId = await ctx.ui.input(
        "함대 이름 (Fleet ID):",
        process.cwd().split("/").pop() ?? "fleet",
      );
      if (inputFleetId === undefined || !inputFleetId.trim()) {
        ctx.ui.notify("접속이 취소되었습니다.", "warning");
        return;
      }

      const inputPath = await ctx.ui.input(
        "Admiralty 소켓 경로:",
        "~/.pi/grand-fleet/admiralty.sock",
      );
      if (inputPath === undefined || !inputPath.trim()) {
        ctx.ui.notify("접속이 취소되었습니다.", "warning");
        return;
      }

      const inputDesignation = await ctx.ui.input(
        "함대 표시명 (Designation):",
        state.designation ?? inputFleetId.trim(),
      );
      if (inputDesignation === undefined || !inputDesignation.trim()) {
        ctx.ui.notify("접속이 취소되었습니다.", "warning");
        return;
      }

      const effectiveFleetId = inputFleetId.trim();
      if (state) {
        state.socketPath = inputPath.trim();
        state.fleetId = effectiveFleetId;
        state.designation = inputDesignation.trim();
      }

      connectToAdmiralty(inputPath.trim(), effectiveFleetId);
    },
  });

  pi.registerCommand("fleet:grand-fleet:disconnect", {
    description: "Admiralty 연결 해제 — Grand Fleet에서 이탈",
    handler: async (_args, ctx) => {
      if (!getFleetClient()) {
        ctx.ui.notify("[Grand Fleet] 연결되어 있지 않습니다.", "warning");
        return;
      }

      log.info(LOG_SOURCE, "Fleet 수동 연결 해제");
      disconnectFromAdmiralty(state?.fleetId ?? fleetId);
      ctx.ui.notify("[Grand Fleet] Admiralty 연결 해제 완료", "info");
    },
  });
}
