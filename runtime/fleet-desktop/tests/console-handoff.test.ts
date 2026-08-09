import { describe, expect, it } from "vitest";

import { handOffWindowToConsole, type ConsoleHandoffDeps } from "../src/console-handoff.js";

const TARGET = "http://127.0.0.1:2253";

function createHarness(overrides: Partial<ConsoleHandoffDeps> = {}) {
  const trace: string[] = [];
  const deps: ConsoleHandoffDeps = {
    publishShellHome: async (origin) => { trace.push(`publish:${origin}`); },
    loadUrl: async (url) => { trace.push(`load:${url}`); },
    synchronizeTheme: async (origin) => { trace.push(`theme:${origin}`); },
    synchronizeFullscreen: (origin) => { trace.push(`fullscreen:${origin}`); },
    ...overrides,
  };
  return { trace, deps };
}

describe("console handoff", () => {
  /**
   * 이 순서가 이 파일의 전부다. 도착한 화면은 뜨자마자 "돌아갈 곳"을 한 번 묻고 다시 묻지
   * 않으므로, 창이 먼저 도착하면 그 콘솔에는 돌아가는 줄이 서지 않는다.
   */
  it("tells the console where home is before the window arrives", async () => {
    const harness = createHarness();

    await handOffWindowToConsole(harness.deps, `${TARGET}/console/`);

    expect(harness.trace).toEqual([
      `publish:${TARGET}`,
      `load:${TARGET}/console/`,
      `theme:${TARGET}`,
      `fullscreen:${TARGET}`,
    ]);
  });

  /** 순서가 계약이라면 게시가 *끝나기* 전에 창이 떠나서는 안 된다 — 호출 순서만으로는 부족하다. */
  it("waits for the publication to finish, not merely to start", async () => {
    let releasePublication = () => {};
    const harness = createHarness({
      publishShellHome: async (origin) => {
        harness.trace.push(`publish:start:${origin}`);
        await new Promise<void>((resolve) => { releasePublication = resolve; });
        harness.trace.push(`publish:done:${origin}`);
      },
    });

    const handoff = handOffWindowToConsole(harness.deps, `${TARGET}/console/`);
    await Promise.resolve();
    // 게시가 매달려 있는 동안 창은 아직 떠나지 않았다.
    expect(harness.trace).toEqual([`publish:start:${TARGET}`]);

    releasePublication();
    await handoff;

    expect(harness.trace).toEqual([
      `publish:start:${TARGET}`,
      `publish:done:${TARGET}`,
      `load:${TARGET}/console/`,
      `theme:${TARGET}`,
      `fullscreen:${TARGET}`,
    ]);
  });

  /** 이 라우트를 모르는 옛 콘솔도 열려야 한다 — 돌아갈 길 하나 때문에 가는 길을 막지 않는다. */
  it("still opens a console that refuses the shell-home publication", async () => {
    const harness = createHarness({
      publishShellHome: async () => { throw new Error("HTTP 404"); },
    });

    await handOffWindowToConsole(harness.deps, `${TARGET}/console/`);

    expect(harness.trace).toEqual([`load:${TARGET}/console/`, `theme:${TARGET}`, `fullscreen:${TARGET}`]);
  });

  /**
   * 거절은 catch가 받지만 침묵은 받지 못한다. 답하지 않는 콘솔 하나가 창을 옛 화면에 영영
   * 붙들어 두면, 게시가 항해를 막지 않는다는 계약은 그 콘솔에서만 거짓이 된다.
   */
  it("stops waiting for a publication that never answers and opens anyway", async () => {
    const harness = createHarness({
      publishShellHome: () => new Promise<void>(() => {}),
      waitForPublishDeadline: async (ms) => { harness.trace.push(`deadline:${ms}`); },
    });

    await handOffWindowToConsole(harness.deps, `${TARGET}/console/`);

    expect(harness.trace).toEqual([
      "deadline:2000",
      `load:${TARGET}/console/`,
      `theme:${TARGET}`,
      `fullscreen:${TARGET}`,
    ]);
  });
});
