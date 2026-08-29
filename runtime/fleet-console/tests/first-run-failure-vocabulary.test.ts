import { beforeEach, describe, expect, it, vi } from "vitest";

import { describeTheaterFolderFailure } from "../core/client/src/failure-notices.js";
import { getT } from "../core/client/src/i18n/index.js";
import { quickLaunchErrorMessageKey } from "../core/client/src/quick-launch.js";

function createStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
  };
}

/**
 * 첫 실행 경로의 실패 화법 계약.
 *
 * 이 경로의 결함은 전부 같은 모양이었다 — 서버는 이유를 알고 있는데 화면에는 기계 코드나
 * 일반 문구만 남았다. 아래 테스트는 각 코드가 사람이 읽는 문장과 할 일로 옮겨지는 것을 고정한다.
 */
describe("first-run failure vocabulary", () => {
  describe("theater folder", () => {
    const t = getT("en");

    it("turns every folder rejection into what happened plus what to do", () => {
      for (const code of ["invalid_path", "not_found", "forbidden", "invalid_folder", "unauthorized"]) {
        const notice = describeTheaterFolderFailure(code, t);
        expect(notice.title, code).toBeTruthy();
        expect(notice.cause, code).toBeTruthy();
        // 예전 동작: `forbidden` 이 그대로 알림 문구였다.
        expect(notice.title, code).not.toBe(code);
        expect(notice.cause, code).not.toContain(code);
        expect(notice.diagnostic, code).toBe(code);
      }
    });

    it("says something different for a path that cannot be read and one that is gone", () => {
      const forbidden = describeTheaterFolderFailure("forbidden", t);
      const missing = describeTheaterFolderFailure("not_found", t);
      expect(forbidden.title).not.toBe(missing.title);
      expect(forbidden.cause).toMatch(/permission/i);
    });

    it("still answers for an unknown code", () => {
      const notice = describeTheaterFolderFailure("some_future_code", t);
      expect(notice.title).toBeTruthy();
      expect(notice.cause).toBeTruthy();
      expect(notice.diagnostic).toBe("some_future_code");
    });

    it("keeps both locales in step", () => {
      expect(describeTheaterFolderFailure("forbidden", getT("ko")).title)
        .not.toBe(describeTheaterFolderFailure("forbidden", t).title);
    });
  });

  describe("agent CLI launch", () => {
    it("tells a missing install apart from a signed-out CLI", () => {
      expect(quickLaunchErrorMessageKey("agent_cli_not_installed")).toBe("chrome.quickLaunch.errorCliNotInstalled");
      expect(quickLaunchErrorMessageKey("agent_cli_signed_out")).toBe("chrome.quickLaunch.errorCliSignedOut");
      // 옛 서버가 보내던 뭉뚱그린 코드도 계속 문장을 얻는다.
      expect(quickLaunchErrorMessageKey("agent_cli_unavailable")).toBe("chrome.quickLaunch.errorCliUnavailable");
    });

    it("names a spawn failure by what the operator has to fix", () => {
      expect(quickLaunchErrorMessageKey("agent_cli_binary_missing")).toBe("chrome.quickLaunch.errorCliBinaryMissing");
      expect(quickLaunchErrorMessageKey("agent_cli_not_executable")).toBe("chrome.quickLaunch.errorCliNotExecutable");
    });

    it("gives every launch message a next step", () => {
      const t = getT("en");
      const keys = [
        "chrome.quickLaunch.errorCliNotInstalled",
        "chrome.quickLaunch.errorCliSignedOut",
        "chrome.quickLaunch.errorCliBinaryMissing",
        "chrome.quickLaunch.errorCliNotExecutable",
        "chrome.quickLaunch.errorGeneric",
      ] as const;
      for (const key of keys) {
        // 세 조각을 한 줄에 담는 표면이라 "무슨 일 — 할 일" 형태를 쓴다. 대시 뒤가 비면
        // 예전처럼 상태만 알리고 할 일을 말하지 않는 문구로 되돌아간 것이다.
        expect(t(key), key).toContain("—");
        expect(t(key).split("—")[1]?.trim(), key).toBeTruthy();
      }
    });
  });

  describe("what's new on a fresh install", () => {
    beforeEach(() => {
      vi.resetModules();
      vi.stubGlobal("window", { localStorage: createStorage() });
    });

    async function bootConsole(theaterCount: number) {
      const store = await import("../core/client/src/store.js");
      const settings = await import("../core/client/src/global-settings-store.js");
      settings.hydrateGlobalSettings({
        consolePortMode: "dynamic",
        consoleStaticPort: null,
        seenFeatureTours: [],
        theme: "instrument",
        uiFont: { family: "system", size: 14 },
        language: "auto",
      } as never);
      store.hydrateTheaters(Array.from({ length: theaterCount }, (_, index) => ({
        id: `theater-${index}`,
        label: `Theater ${index}`,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
        hasWiki: false,
        activeAdmiralCount: 0,
      })));
      store.applyObserverStatus({
        name: "test", workspaces: theaterCount, version: "1.60.0", channel: "stable",
        updateAvailable: false, port: 1, portMode: "dynamic", requestedPort: null,
        effectivePort: 1, portHonored: true, wikiServerStatus: "unknown",
      });
      store.resolveOnboardingOnBootstrap();
      store.applyReleaseNotes({
        notes: [{ version: "1.60.0", date: "2026-08-15", sections: [], localizationFallback: false }],
        sourceRef: "main",
        fetchedAt: 0,
        stale: false,
      }, "en");
      return store;
    }

    it("does not greet a brand new install with the release backlog", async () => {
      const store = await bootConsole(0);
      // 오늘 처음 설치한 사람에게 "새 소식"은 성립하지 않는다 — 그들에게는 전부가 처음이다.
      expect(store.getState().whatsNewOpen).toBe(false);
      // 커미셔닝은 그대로 뜬다. 첫 실행에서 사라지는 것은 릴리스 묶음뿐이다.
      expect(store.getState().onboardingOpen).toBe(true);
    });

    it("still shows a release to someone who already works in a Theater", async () => {
      const store = await bootConsole(1);
      expect(store.getState().whatsNewOpen).toBe(true);
    });
  });
});
