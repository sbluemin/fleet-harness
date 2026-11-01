import { expect, it, vi } from "vitest";

import type { ClientConsoleEventsCapability } from "../../../../workspace/shared/navigation-ports.js";
import { queryCommodoreShellStatus } from "../../../../workspace/client/theater-tools/shell-status.js";
import { toolShellKey } from "../../../shared/shell-key.js";
import { connectShellSession } from "./shell-session-store.js";

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
