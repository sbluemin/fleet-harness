import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface MemoryCaptureSession {
  branchId: string;
}

export function collectCaptureSession(ctx: ExtensionContext): MemoryCaptureSession | null {
  const sessionEvents = (ctx.sessionManager?.getBranch?.() ?? []) as any[];

  for (const event of sessionEvents) {
    if (event.type === "message") {
      const content = stringifyMessageContent(event.message?.content);
      if (content) {
        return { branchId: getBranchId(ctx) };
      }
      continue;
    }

    if (event.type === "tool_call" || event.type === "tool_result") {
      return { branchId: getBranchId(ctx) };
    }
  }

  return null;
}

function getBranchId(ctx: ExtensionContext): string {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : "current-session";
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const chunks = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if ("type" in item && (item as { type?: unknown }).type === "text") {
        return typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "";
      }
      return "";
    })
    .filter((value) => value.trim().length > 0);

  return chunks.join("\n").trim();
}
