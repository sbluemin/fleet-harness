import type { ConsoleCaller } from "../shared/control.js";
import { ConsoleControlError } from "./console-control.js";

/** 호출 세션의 소유자가 인자보다 우선한다. 소유자 없는 연결만 명시 UUID로 선택한다. */
export function consoleToolOwner(
  requested: unknown,
  context: { readonly caller?: ConsoleCaller; readonly commodoreId?: string },
  objectiveOwner: (objectiveId: string) => string | null,
): string {
  const callerOwner = context.caller?.kind === "objectiveRecord" ? objectiveOwner(context.caller.objectiveId) : null;
  if (context.caller?.kind === "objectiveRecord" && !callerOwner) throw new ConsoleControlError("caller_unresolved");
  if (callerOwner && context.commodoreId && callerOwner !== context.commodoreId) throw new ConsoleControlError("commodore_scope_mismatch");
  const bound = callerOwner ?? context.commodoreId;
  if (requested !== undefined && (typeof requested !== "string" || !requested)) throw new ConsoleControlError("commodore_required");
  if (bound && requested !== undefined && requested !== bound) throw new ConsoleControlError("commodore_scope_mismatch");
  const owner = bound ?? requested;
  if (typeof owner !== "string" || !owner) throw new ConsoleControlError("commodore_required");
  return owner;
}
