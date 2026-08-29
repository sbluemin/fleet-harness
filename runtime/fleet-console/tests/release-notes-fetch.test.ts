import { afterEach, describe, expect, it, vi } from "vitest";

interface DeferredResponse {
  readonly promise: Promise<Response>;
  readonly resolve: (response: Response) => void;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.resetModules();
});

describe("release notes fetch coordination", () => {
  it("does not apply a late response from an older request", async () => {
    const requests: DeferredResponse[] = [];
    const fetchMock = vi.fn((..._args: Parameters<typeof fetch>) => {
      let resolve: (response: Response) => void = () => {};
      const promise = new Promise<Response>((pendingResolve) => {
        resolve = pendingResolve;
      });
      requests.push({ promise, resolve });
      return promise;
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const { requestReleaseNotes } = await import("../core/client/src/whatsnew.js");
    const { getState } = await import("../core/client/src/store.js");

    const english = requestReleaseNotes({ locale: "en" });
    const korean = requestReleaseNotes({ force: true, locale: "ko" });

    expect(requests).toHaveLength(2);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ signal: expect.objectContaining({ aborted: true }) });
    requests[1]!.resolve(releaseNotesResponse("2.0.0", 2));
    await korean;
    requests[0]!.resolve(releaseNotesResponse("1.0.0", 1));
    await english;

    expect(getState()).toMatchObject({
      releaseNotes: [{ version: "2.0.0" }],
      releaseNotesLocale: "ko",
      releaseNotesFetchedAt: 2,
      releaseNotesLoading: false,
    });
  });

  it("remaps the selected duplicate release when a same-locale fetch shifts positions", async () => {
    const { applyReleaseNotes, getState, setState } = await import("../core/client/src/store.js");
    const previousNotes = [
      { version: "2.0.0", date: "2026-08-30", sections: [], localizationFallback: false },
      { version: "1.0.0", date: "2026-07-10", sections: [], localizationFallback: false },
      { version: "1.0.0", date: "2026-07-09", sections: [], localizationFallback: false },
    ];
    const nextNotes = [
      { version: "3.0.0", date: "2026-08-31", sections: [], localizationFallback: false },
      ...previousNotes,
    ];
    setState({
      version: "2.0.0",
      bootstrapped: false,
      whatsNewOpen: true,
      automaticWhatsNewVersion: null,
      releaseNotes: previousNotes,
      releaseNotesLocale: "en",
      selectedReleaseNoteKey: "1.0.0:2",
    });

    applyReleaseNotes({ notes: nextNotes, sourceRef: "main", fetchedAt: 2, stale: false }, "en");

    expect(getState()).toMatchObject({
      whatsNewOpen: true,
      automaticWhatsNewVersion: null,
      releaseNotesLocale: "en",
      selectedReleaseNoteKey: "1.0.0:3",
    });
  });

  it("does not re-run automatic selection while What's New is already open", async () => {
    const { applyReleaseNotes, getState, setState } = await import("../core/client/src/store.js");
    const notes = [
      { version: "2.0.0", date: "2026-08-30", sections: [], localizationFallback: false },
      { version: "1.0.0", date: "2026-07-10", sections: [], localizationFallback: false },
    ];
    setState({
      version: "2.0.0",
      bootstrapped: false,
      whatsNewOpen: true,
      automaticWhatsNewVersion: "2.0.0",
      releaseNotes: notes,
      releaseNotesLocale: "ko",
      selectedReleaseNoteKey: "1.0.0:1",
    });

    applyReleaseNotes({ notes, sourceRef: "main", fetchedAt: 2, stale: false }, "ko");

    expect(getState()).toMatchObject({
      whatsNewOpen: true,
      automaticWhatsNewVersion: "2.0.0",
      selectedReleaseNoteKey: "1.0.0:1",
    });
  });
});

function releaseNotesResponse(version: string, fetchedAt: number): Response {
  return new Response(JSON.stringify({
    notes: [{ version, date: "2026-07-10", sections: [], localizationFallback: false }],
    sourceRef: "main",
    fetchedAt,
    stale: false,
  }));
}
