import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { approvePatch, listQueue, rejectPatch, showQueue } from "@sbluemin/fleet-wiki";
import { buildWikiCaptureDirective } from "@sbluemin/fleet-wiki";
import { ensureMemoryRoot, resolveMemoryPaths } from "@sbluemin/fleet-wiki";
import { loadIndex } from "@sbluemin/fleet-wiki";
import { runDryDock } from "@sbluemin/fleet-wiki";
import type { PatchMeta, PatchOp } from "@sbluemin/fleet-wiki";

import { collectCaptureSession } from "./capture.js";

interface NotifyUI {
  notify(msg: string, type?: "info" | "error" | "warning"): void;
}

interface NotifyContext {
  cwd: string;
  ui: NotifyUI;
}

export async function runStatus(ctx: NotifyContext): Promise<void> {
  const paths = resolveMemoryPaths(ctx.cwd);
  await ensureMemoryRoot(paths);
  const index = await loadIndex(paths);
  ctx.ui.notify(`Fleet Wiki ready: ${Object.keys(index).length} wiki entries`, "info");
}

export async function runDrydock(ctx: NotifyContext): Promise<void> {
  const report = await runDryDock(resolveMemoryPaths(ctx.cwd));
  ctx.ui.notify(`Drydock: ${report.ok ? "OK" : `${report.issues.length} issues`}`, report.ok ? "info" : "warning");
}

export async function runCapture(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const session = collectCaptureSession(ctx);
  if (!session) {
    ctx.ui.notify("현재 세션에서 캡처할 대화/작업 이력이 없어 Fleet Wiki preview를 시작할 수 없습니다.", "warning");
    return;
  }

  const choice = await ctx.ui.select("Fleet Wiki capture:", [
    "의미 있는 지식 staging",
    "프리뷰 캡처 계획",
    "취소",
  ]);

  if (choice === undefined || choice === "취소") {
    ctx.ui.notify("Fleet Wiki capture가 취소되었습니다.", "warning");
    return;
  }

  const directive = buildWikiCaptureDirective({
    mode: choice === "의미 있는 지식 staging" ? "stage" : "preview",
    session,
  });

  if (typeof pi.sendUserMessage !== "function") {
    throw new Error("fleet:wiki:menu requires PI sendUserMessage support");
  }

  pi.sendUserMessage(directive, { deliverAs: "followUp" });
  ctx.ui.notify(
    choice === "의미 있는 지식 staging"
      ? "Fleet Wiki capture staging 지시를 Admiral 후속 턴에 전달했습니다."
      : "Fleet Wiki capture preview를 Admiral 후속 지시로 전달했습니다.",
    "info",
  );
}

export async function listQueueItems(cwd: string): Promise<Array<{ id: string; summary: string }>> {
  const items = await listQueue(resolveMemoryPaths(cwd));
  return items.map((item) => ({
    id: item.id,
    summary: item.meta.reason ?? item.meta.warnings?.join(", ") ?? item.meta.status,
  }));
}

export async function showPatchDetail(
  id: string,
  cwd: string,
): Promise<{ meta: PatchMeta; body: string; op: PatchOp; summary: string; target: string }> {
  const item = await showQueue(id, resolveMemoryPaths(cwd));
  return {
    meta: item.meta,
    body: item.patch.body,
    op: item.patch.frontmatter.op,
    summary: item.patch.frontmatter.summary,
    target: item.patch.frontmatter.target,
  };
}

export async function approveAndNotify(id: string, ctx: NotifyContext): Promise<void> {
  const meta = await approvePatch(id, resolveMemoryPaths(ctx.cwd));
  ctx.ui.notify(`Approved ${meta.id}`, "info");
}

export async function rejectAndNotify(id: string, reason: string, ctx: NotifyContext): Promise<void> {
  const meta = await rejectPatch(id, reason, resolveMemoryPaths(ctx.cwd));
  ctx.ui.notify(`Rejected ${meta.id}`, "info");
}
