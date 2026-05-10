import type { ExtensionAPI } from "@sbluemin/fleet-coding-agent";

import { infra } from "@sbluemin/fleet-core";
import { getState } from "../state.js";
import { connectToAdmiralty, disconnectFromAdmiralty, getFleetClient } from "./runtime.js";

const LOG_SOURCE = "grand-fleet";

export function registerFleetPiCommands(pi: ExtensionAPI): void {
  pi.registerCommand("fleet:grand-fleet:settings", {
    description: "Grand Fleet 설정 — Admiralty 연결/해제",
    handler: async (_args, ctx) => {
      const isConnected = !!getFleetClient();
      const options = isConnected
        ? ["Admiralty 연결 해제"]
        : ["Admiralty 연결"];

      const choice = await ctx.ui.select("Grand Fleet 설정:", options);
      if (choice === undefined) return;

      if (choice.startsWith("Admiralty 연결 해제")) {
        await handleDisconnect(ctx);
      } else if (choice.startsWith("Admiralty 연결")) {
        await handleConnect(ctx);
      }
    },
  });
}

async function handleConnect(ctx: any): Promise<void> {
  if (getFleetClient()) {
    ctx.ui.notify("[Grand Fleet] 이미 연결되어 있습니다.", "warning");
    return;
  }

  const state = getState();

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
    "~/.fleet/grand-fleet/admiralty.sock",
  );
  if (inputPath === undefined || !inputPath.trim()) {
    ctx.ui.notify("접속이 취소되었습니다.", "warning");
    return;
  }

  const inputDesignation = await ctx.ui.input(
    "함대 표시명 (Designation):",
    state?.designation ?? inputFleetId.trim(),
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
}

async function handleDisconnect(ctx: any): Promise<void> {
  if (!getFleetClient()) {
    ctx.ui.notify("[Grand Fleet] 연결되어 있지 않습니다.", "warning");
    return;
  }

  const state = getState();
  const log = infra.log.getLogAPI();
  const fleetId = state?.fleetId ?? "unset";

  log.info(LOG_SOURCE, "Fleet 수동 연결 해제");
  disconnectFromAdmiralty(fleetId);
  ctx.ui.notify("[Grand Fleet] Admiralty 연결 해제 완료", "info");
}
