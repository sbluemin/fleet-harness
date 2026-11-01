import { expect, it, vi } from "vitest";

import type { ClientConsoleEventsCapability } from "../../../../workspace/shared/navigation-ports.js";
import { queryCommodoreShellStatus, shellBusyForRemoval } from "../../../../workspace/client/theater-tools/shell-status.js";
import { toolShellKey } from "../../../shared/shell-key.js";
import { connectShellSession } from "./shell-session-store.js";
import { resolveInstanceMount, type ShellMountState } from "./index.js";
import type { ExpandedSurfaceContext } from "../../../../workspace/shared/expanded-surface.js";

// hap기록: 헤드 메뉴의 초록 점이 구독하는 getSnapshot은 같은 값에 같은 참조를 돌려줘야 한다.
// 매번 새 객체를 돌려주면 메뉴가 열리는 순간 무한 렌더에 빠진다(메뉴 실측 #185).
// 이 파일은 실제 공급자(shell/index가 모듈 자리에서 등록한다)의 참조 안정을 고정한다.

async function emitShellState(payload: unknown): Promise<void> {
  const handlers = new Map<string, (payload: unknown) => void>();
  const events = {
    subscribe: (channel: string, onEvent: (payload: unknown) => void) => {
      handlers.set(channel, onEvent);
      return () => { handlers.delete(channel); };
    },
  } as unknown as ClientConsoleEventsCapability;
  const off = connectShellSession(events);
  try {
    handlers.get("terminal:shell-session")!(payload);
    await Promise.resolve();
  } finally {
    off();
  }
}

it("returns referentially stable status for the registered shell provider", async () => {
  await import("./index.js");
  const key = toolShellKey("c1", "t1")!;
  await emitShellState({ key, open: true, pinned: true, cwd: null, cwdTracked: false, atPrompt: false, generation: 1 });

  const busy = queryCommodoreShellStatus("c1", "t1");
  expect(busy).toEqual({ live: true, busy: true });
  expect(queryCommodoreShellStatus("c1", "t1")).toBe(busy);

  const unknownFirst = queryCommodoreShellStatus("c1", "nope");
  expect(unknownFirst).toEqual({ live: false, busy: false });
  expect(queryCommodoreShellStatus("c1", "nope")).toBe(unknownFirst);
});

it("asks the removal confirm when the host state is busy or unreadable", () => {
  expect(shellBusyForRemoval({ open: true, atPrompt: false })).toBe(true);
  expect(shellBusyForRemoval({ open: true, atPrompt: true })).toBe(false);
  expect(shellBusyForRemoval({ open: false, atPrompt: false })).toBe(false);
  expect(shellBusyForRemoval(null)).toBe(true);
});

function fakeMount(key: string, instanceId: string, attached: boolean): ShellMountState {
  return {
    key,
    conversationScoped: true,
    ...(attached ? { target: {} as unknown as HTMLElement } : { target: null }),
    context: { instanceId } as unknown as ExpandedSurfaceContext,
  };
}

// 닫기·닫기 확인은 같은 인스턴스 id를 나눈 상주 중 지금 붙은 쪽을 가리킨다 —
// 먼저 들어간 주차 상주를 가리키면 보이는 칸의 확인 없이 감춰진 Theater의 Shell이 끝난다.
it("resolves an instance close to the attached mount, not a parked earlier one", () => {
  const parked = fakeMount("tool-shell:commodore:c:theater:billing", "tile-1", false);
  const attached = fakeMount("tool-shell:commodore:c:theater:atlas", "tile-1", true);
  // Map 삽입 순서(주차됨이 먼저)와 무관하게 붙은 쪽이 이긴다.
  expect(resolveInstanceMount(new Map([["billing", parked], ["atlas", attached]]), "tile-1")).toBe(attached);
  expect(resolveInstanceMount(new Map([["atlas", attached], ["billing", parked]]), "tile-1")).toBe(attached);
  expect(resolveInstanceMount(new Map([["billing", parked]]), "tile-1")).toBe(parked);
  expect(resolveInstanceMount(new Map([["billing", parked]]), "tile-9")).toBeNull();
});
