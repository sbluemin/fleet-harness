// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WhatsNewModal } from "../core/client/src/components/whatsnew-modal.js";
import { getGlobalSettingsStoreState, hydrateGlobalSettings } from "../core/client/src/global-settings-store.js";
import { useConsoleState } from "../core/client/src/hooks/use-store.js";
import { getState, setState } from "../core/client/src/store.js";
import type { GlobalSettingsState, ReleaseNotes } from "../core/client/src/types.js";

const SETTINGS: GlobalSettingsState = {
  consolePortMode: "dynamic",
  consoleStaticPort: null,
  seenFeatureTours: [],
  theme: "instrument",
  liquidGlass: true,
  unfocusedPanelFade: 50,
  uiFont: { source: "builtin", id: "manrope", size: 14 },
  language: "auto",
};

const KOREAN_NOTE: ReleaseNotes = {
  version: "1.77.1",
  date: "2026-08-30",
  sections: [],
  localizationFallback: false,
};

const ENGLISH_NOTE: ReleaseNotes = {
  ...KOREAN_NOTE,
  date: "2026-08-29",
};

let container: HTMLDivElement;
let root: Root;
const originalFetch = globalThis.fetch;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function TestApp() {
  return createElement(WhatsNewModal, { state: useConsoleState() });
}

beforeEach(() => {
  vi.spyOn(window.navigator, "language", "get").mockReturnValue("ko-KR");
  hydrateGlobalSettings(SETTINGS);
  setState({
    version: "",
    bootstrapped: true,
    whatsNewOpen: true,
    onboardingOpen: false,
    operationSearchOpen: false,
    quickLaunchOpen: false,
    keyboardShortcutsOpen: false,
    controlHolder: null,
    releaseNotes: [KOREAN_NOTE],
    releaseNotesLocale: "ko",
    releaseNotesLoading: false,
    releaseNotesError: null,
    releaseNotesSourceRef: "main",
    releaseNotesFetchedAt: 1,
    releaseNotesStale: false,
    automaticWhatsNewVersion: null,
    selectedReleaseNoteKey: "1.77.1:0",
  });
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/v1/updates/release-notes") {
      return new Response(JSON.stringify({
        notes: [ENGLISH_NOTE],
        sourceRef: "main",
        fetchedAt: 2,
        stale: false,
      }));
    }
    if (url.pathname === "/api/v1/settings/global" && init?.method === "PUT") {
      const patch = JSON.parse(String(init.body)) as Partial<GlobalSettingsState>;
      return new Response(JSON.stringify({ state: { ...SETTINGS, ...patch } }));
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  }) as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(TestApp)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("What's New language selector", () => {
  it("changes only the release-note content language", async () => {
    expect(document.querySelector("#whatsnew-title")?.textContent).toBe("새 소식");
    const englishButton = document.querySelector<HTMLButtonElement>(".whatsnew-language-picker button");
    expect(englishButton).not.toBeNull();

    await act(async () => {
      englishButton?.click();
    });

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock.mock.calls.some(([input, init]) =>
      new URL(String(input), "http://localhost").pathname === "/api/v1/settings/global"
      && init?.method === "PUT")).toBe(false);
    expect(getGlobalSettingsStoreState().state?.language).toBe("auto");
    expect(document.querySelector("#whatsnew-title")?.textContent).toBe("새 소식");
    expect(fetchMock.mock.calls.some(([input, init]) => {
      const url = new URL(String(input), "http://localhost");
      return url.pathname === "/api/v1/updates/release-notes"
        && url.searchParams.get("locale") === "en"
        && init?.method === undefined;
    })).toBe(true);
    expect(getState()).toMatchObject({
      releaseNotes: [{ date: "2026-08-29" }],
      releaseNotesLocale: "en",
    });
    expect(document.querySelector<HTMLButtonElement>(".whatsnew-language-picker button")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the applied content language when a switch fails", async () => {
    globalThis.fetch = vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    const englishButton = document.querySelector<HTMLButtonElement>(".whatsnew-language-picker button");

    await act(async () => {
      englishButton?.click();
    });

    expect(getGlobalSettingsStoreState().state?.language).toBe("auto");
    expect(getState()).toMatchObject({
      releaseNotes: [{ date: "2026-08-30" }],
      releaseNotesLocale: "ko",
      releaseNotesLoading: false,
    });
    expect(getState().releaseNotesError).not.toBeNull();
    const buttons = document.querySelectorAll<HTMLButtonElement>(".whatsnew-language-picker button");
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks an English fallback in Korean mode and lets the active selector retry it", async () => {
    const fallbackNote = { ...ENGLISH_NOTE, localizationFallback: true };
    act(() => setState({ releaseNotes: [ENGLISH_NOTE], releaseNotesLocale: "en" }));
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        notes: [fallbackNote], sourceRef: "main", fetchedAt: 2, stale: false,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        notes: [KOREAN_NOTE], sourceRef: "main", fetchedAt: 3, stale: false,
      }))) as typeof fetch;

    await act(async () => {
      document.querySelectorAll<HTMLButtonElement>(".whatsnew-language-picker button")[1]?.click();
    });

    expect(getState()).toMatchObject({ releaseNotesLocale: "ko", releaseNotes: [{ localizationFallback: true }] });
    expect(document.querySelector(".whatsnew-fallback")?.textContent).toBe("영어 대체본");

    await act(async () => {
      document.querySelectorAll<HTMLButtonElement>(".whatsnew-language-picker button")[1]?.click();
    });

    const retryUrl = new URL(String(vi.mocked(globalThis.fetch).mock.calls[1]?.[0]), "http://localhost");
    expect(retryUrl.searchParams.get("locale")).toBe("ko");
    expect(retryUrl.searchParams.get("force")).toBe("true");
    expect(getGlobalSettingsStoreState().state?.language).toBe("auto");
    expect(getState()).toMatchObject({ releaseNotesLocale: "ko", releaseNotes: [{ localizationFallback: false }] });
    expect(document.querySelector(".whatsnew-fallback")).toBeNull();
  });
});
