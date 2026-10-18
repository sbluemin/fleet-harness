import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { handOffWindowToConsole, loadConsoleDocument, republishShellHomeOnArrival, type ConsoleHandoffDeps, type ShellHomePublication } from "../src/console-handoff.js";

const TARGET = "http://127.0.0.1:2253";

function createHarness(overrides: Partial<ConsoleHandoffDeps> = {}) {
  const trace: string[] = [];
  const deps: ConsoleHandoffDeps = {
    publishShellHome: async (origin) => { trace.push(`publish:${origin}`); },
    loadUrl: async (url) => { trace.push(`load:${url}`); },
    synchronizeTheme: async (origin) => { trace.push(`theme:${origin}`); },
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
    ]);
  });

  /** 이 라우트를 모르는 옛 콘솔도 열려야 한다 — 돌아갈 길 하나 때문에 가는 길을 막지 않는다. */
  it("still opens a console that refuses the shell-home publication", async () => {
    const harness = createHarness({
      publishShellHome: async () => { throw new Error("HTTP 404"); },
    });

    await handOffWindowToConsole(harness.deps, `${TARGET}/console/`);

    expect(harness.trace).toEqual([`load:${TARGET}/console/`, `theme:${TARGET}`]);
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
    ]);
  });
});

/**
 * 옮기는 동안 떠나는 문서가 셸에게 보낸 신호는 셸이 막으므로 대상 적재는 계속된다. 그런데 Electron의 loadURL은
 * 그 항해가 시작되기만 해도 ERR_ABORTED로 거절한다 — 그 거절을 실패로 읽으면 도착한 창을 두고 롤백하고 경고를 띄운다.
 */
describe("console document load", () => {
  const SIGNAL = `http://127.0.0.1:2252/console/?desktop-surface=console-section-command&command=${encodeURIComponent('{"request":"state"}')}`;

  /** Electron loadURL처럼: 적재 중 main frame에서 다른 항해가 시작되면 그 URL로 거절한다. */
  function createContents() {
    const contents = Object.assign(new EventEmitter(), {
      at: "http://127.0.0.1:2252/console/",
      getURL: () => contents.at,
      loadURL: (url: string) => new Promise<void>((resolve, reject) => {
        let started = false;
        contents.on("did-start-navigation", (details: { url: string }) => {
          if (started) reject(Object.assign(new Error(`ERR_ABORTED (-3) loading '${details.url}'`), { errno: -3, code: "ERR_ABORTED", url: details.url }));
          started = true;
        });
        contents.once("did-finish-load", () => resolve());
        contents.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
      }),
    });
    return contents;
  }
  const settled = (promise: Promise<void>) => promise.then(() => "arrived", (error: Error) => error.message);
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("judges by the target's own outcome, not by an intercepted shell signal", async () => {
    // 신호가 끼어들어도 대상이 도착하면 성공이다.
    const arriving = createContents();
    const arrived = settled(loadConsoleDocument(arriving, `${TARGET}/console/`));
    arriving.emit("did-start-navigation", { url: SIGNAL, isMainFrame: true, isSameDocument: false });
    await tick();
    arriving.at = `${TARGET}/console/`;
    arriving.emit("did-finish-load");
    expect(await arrived).toBe("arrived");

    // 신호 뒤에 대상 자신이 실패하면 그 실패가 그대로 결과다 — 진짜 실패의 롤백과 안내는 남는다.
    const failing = createContents();
    const failed = settled(loadConsoleDocument(failing, `${TARGET}/console/`));
    failing.emit("did-start-navigation", { url: SIGNAL, isMainFrame: true, isSameDocument: false });
    await tick();
    failing.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", `${TARGET}/console/`, true);
    expect(await failed).toBe(`ERR_CONNECTION_REFUSED (-102) loading '${TARGET}/console/'`);
  });
});

/**
 * 창이 셸의 손을 거치지 않고 다시 도착하는 경우 — 재기동한 콘솔로 화면이 스스로 되돌아올 때.
 * 그 콘솔은 게시도 세션도 잊었고, 세션은 화면이 되살린다. 게시는 그 뒤에야 받아들여진다.
 */
describe("shell home republish on arrival", () => {
  it("keeps publishing until the page's revived session accepts it, then stops", async () => {
    const answers: ShellHomePublication[] = ["unauthorized", "unauthorized", "accepted", "accepted"];
    const trace: string[] = [];

    const outcome = await republishShellHomeOnArrival({
      publish: async (origin) => { trace.push(`publish:${origin}`); return answers.shift() ?? "failed"; },
      stillAt: () => true,
      wait: async (ms) => { trace.push(`wait:${ms}`); },
    }, TARGET);

    expect(outcome).toBe("accepted");
    expect(trace).toEqual([`publish:${TARGET}`, "wait:1000", `publish:${TARGET}`, "wait:2000", `publish:${TARGET}`]);
  });

  /** 기다리는 사이 창이 다른 콘솔로 옮겨 갔으면 거기에 집을 게시하지 않는다 — 남의 콘솔 목록에 이 기계가 서면 안 된다. */
  it("does not publish to a console the window has already left", async () => {
    let publishes = 0;
    let at: string | null = TARGET;

    const outcome = await republishShellHomeOnArrival({
      publish: async () => { publishes += 1; return "unauthorized"; },
      stillAt: (origin) => origin === at,
      wait: async () => { at = "http://127.0.0.1:2254"; },
    }, TARGET);

    expect(outcome).toBe("unauthorized");
    expect(publishes).toBe(1);
  });
});
