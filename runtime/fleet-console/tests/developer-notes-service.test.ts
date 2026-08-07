import { describe, expect, it, vi } from "vitest";

import {
  createDeveloperNotesService,
  DeveloperNotesUnavailableError,
  parseDeveloperNotes,
} from "../core/host/developer-notes/developer-notes.js";

interface IssueOverrides {
  readonly number?: number;
  readonly title?: string;
  readonly body?: string | null;
  readonly login?: string;
  readonly association?: string;
  readonly pullRequest?: boolean;
  readonly htmlUrl?: string;
}

function issue(overrides: IssueOverrides = {}): Record<string, unknown> {
  return {
    number: overrides.number ?? 482,
    title: overrides.title ?? "Gateway maintenance",
    body: overrides.body === undefined ? "Thursday 02:00 KST." : overrides.body,
    html_url: overrides.htmlUrl ?? "https://github.com/sbluemin/fleet-harness/issues/482",
    created_at: "2026-08-07T01:00:00Z",
    author_association: overrides.association ?? "OWNER",
    user: { login: overrides.login ?? "sbluemin" },
    ...(overrides.pullRequest === true ? { pull_request: { url: "https://api.github.com/pulls/482" } } : {}),
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("developer note sender verification", () => {
  it("accepts an issue authored by an allowlisted maintainer", () => {
    const notes = parseDeveloperNotes(JSON.stringify([issue()]));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.id).toBe("gh-482");
    expect(notes[0]?.title).toBe("Gateway maintenance");
  });

  it("rejects an author outside the allowlist even when the label is present", () => {
    // GitHub only lets push-access users attach labels, but a Triage collaborator has that
    // access. The console must not treat a label as proof of who is speaking.
    expect(parseDeveloperNotes(JSON.stringify([issue({ login: "someone-else" })]))).toHaveLength(0);
  });

  it("rejects an author association outside owner, member, and collaborator", () => {
    expect(parseDeveloperNotes(JSON.stringify([issue({ association: "NONE" })]))).toHaveLength(0);
    expect(parseDeveloperNotes(JSON.stringify([issue({ association: "CONTRIBUTOR" })]))).toHaveLength(0);
  });

  it("rejects pull requests returned by the issues endpoint", () => {
    // The issues list mixes pull requests in; a merged PR must never surface as a note.
    expect(parseDeveloperNotes(JSON.stringify([issue({ pullRequest: true })]))).toHaveLength(0);
  });

  it("rejects a note whose url does not point at github.com", () => {
    expect(parseDeveloperNotes(JSON.stringify([issue({ htmlUrl: "https://example.com/issues/1" })]))).toHaveLength(0);
  });

  it("keeps authorized notes when an unauthorized one sits beside them", () => {
    const notes = parseDeveloperNotes(JSON.stringify([issue({ login: "stranger" }), issue({ number: 7 })]));
    expect(notes.map((note) => note.id)).toEqual(["gh-7"]);
  });
});

describe("developer note content hashing", () => {
  it("keeps the hash stable for identical content", () => {
    const first = parseDeveloperNotes(JSON.stringify([issue()]));
    const second = parseDeveloperNotes(JSON.stringify([issue()]));
    expect(first[0]?.hash).toBe(second[0]?.hash);
  });

  it("changes the hash when the body changes", () => {
    const before = parseDeveloperNotes(JSON.stringify([issue()]));
    const after = parseDeveloperNotes(JSON.stringify([issue({ body: "Rescheduled to Friday." })]));
    expect(before[0]?.hash).not.toBe(after[0]?.hash);
  });

  it("changes the hash when only the title changes", () => {
    const before = parseDeveloperNotes(JSON.stringify([issue()]));
    const after = parseDeveloperNotes(JSON.stringify([issue({ title: "Gateway maintenance (moved)" })]));
    expect(before[0]?.hash).not.toBe(after[0]?.hash);
  });

  it("treats a missing body as empty rather than dropping the note", () => {
    const notes = parseDeveloperNotes(JSON.stringify([issue({ body: null })]));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe("");
  });
});

describe("developer notes service", () => {
  it("returns the same response object while the content is unchanged", async () => {
    // Referential identity is the contract the client leans on to skip re-rendering.
    const fetchImpl = vi.fn(async () => jsonResponse([issue()]));
    const service = createDeveloperNotesService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    const first = await service.refresh({ force: true });
    const second = await service.refresh({ force: true });
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("produces a new snapshot hash when a note is edited", async () => {
    let body = "Thursday 02:00 KST.";
    const fetchImpl = vi.fn(async () => jsonResponse([issue({ body })]));
    const service = createDeveloperNotesService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    const before = await service.refresh({ force: true });
    body = "Friday 02:00 KST.";
    const after = await service.refresh({ force: true });
    expect(after.snapshotHash).not.toBe(before.snapshotHash);
  });

  it("produces a new snapshot hash when a note is retracted", async () => {
    let issues = [issue({ number: 1 }), issue({ number: 2 })];
    const fetchImpl = vi.fn(async () => jsonResponse(issues));
    const service = createDeveloperNotesService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    const before = await service.refresh({ force: true });
    issues = [issue({ number: 1 })];
    const after = await service.refresh({ force: true });
    expect(before.notes).toHaveLength(2);
    expect(after.notes).toHaveLength(1);
    expect(after.snapshotHash).not.toBe(before.snapshotHash);
  });

  it("never puts a fetch timestamp in the payload", async () => {
    // A per-request timestamp in the response would change the body on every poll and
    // defeat the snapshot-hash gate this feature depends on.
    const fetchImpl = vi.fn(async () => jsonResponse([issue()]));
    const service = createDeveloperNotesService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_234 });
    const response = await service.refresh({ force: true });
    expect(Object.keys(response).sort()).toEqual(["notes", "snapshotHash", "stale"]);
  });

  it("narrows the request to the label, the open state, and the maintainer", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const service = createDeveloperNotesService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    await service.refresh({ force: true });
    const [firstCall] = fetchImpl.mock.calls;
    const url = String((firstCall as unknown as readonly unknown[] | undefined)?.[0] ?? "");
    expect(url).toContain("labels=note");
    expect(url).toContain("state=open");
    expect(url).toContain("creator=sbluemin");
  });

  it("serves the cached response inside the success window", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([issue()]));
    let clock = 0;
    const service = createDeveloperNotesService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    await service.refresh();
    clock = 59 * 60 * 1000;
    await service.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock = 61 * 60 * 1000;
    await service.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable when the first fetch fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    const service = createDeveloperNotesService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    await expect(service.refresh()).rejects.toBeInstanceOf(DeveloperNotesUnavailableError);
  });

  it("keeps serving the last success when a later fetch fails", async () => {
    let failing = false;
    const fetchImpl = vi.fn(async () => (failing ? new Response("nope", { status: 500 }) : jsonResponse([issue()])));
    let clock = 0;
    const service = createDeveloperNotesService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => clock });
    await service.refresh();
    failing = true;
    clock = 61 * 60 * 1000;
    const stale = await service.refresh();
    expect(stale.notes).toHaveLength(1);
    expect(stale.stale).toBe(true);
  });

  it("reports unavailable when the payload is not a JSON array", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }));
    const service = createDeveloperNotesService({ fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    await expect(service.refresh()).rejects.toBeInstanceOf(DeveloperNotesUnavailableError);
  });
});
