import { describe, expect, it } from "vitest";

import {
  countUnreadDeveloperNotes,
  developerNoteSeenKey,
  isDeveloperNoteEdited,
  isDeveloperNoteRead,
  pruneDeveloperNoteSeen,
  withDeveloperNoteRead,
} from "../core/client/src/developer-notes-read.js";
import type { DeveloperNote } from "../core/client/src/types.js";

function note(id: string, hash: string): DeveloperNote {
  return {
    id,
    hash,
    title: `Note ${id}`,
    body: "",
    url: `https://github.com/sbluemin/fleet-harness/issues/${id.replace("gh-", "")}`,
    publishedAt: "2026-08-07T01:00:00Z",
  };
}

describe("developer note read markers", () => {
  it("treats a note as unread until its exact revision is marked", () => {
    const first = note("gh-1", "aaaa");
    expect(isDeveloperNoteRead([], first)).toBe(false);
    expect(isDeveloperNoteRead([developerNoteSeenKey(first)], first)).toBe(true);
  });

  it("surfaces an edited note again and labels it as edited", () => {
    const before = note("gh-1", "aaaa");
    const after = note("gh-1", "bbbb");
    const seen = withDeveloperNoteRead([], before);
    expect(isDeveloperNoteRead(seen, after)).toBe(false);
    expect(isDeveloperNoteEdited(seen, after)).toBe(true);
  });

  it("does not label a never-seen note as edited", () => {
    expect(isDeveloperNoteEdited([], note("gh-9", "cccc"))).toBe(false);
  });

  it("does not label the revision that was actually read as edited", () => {
    const only = note("gh-1", "aaaa");
    expect(isDeveloperNoteEdited(withDeveloperNoteRead([], only), only)).toBe(false);
  });

  it("replaces the previous revision marker instead of stacking revisions", () => {
    // Markers are capped in durable state; stacking every revision would evict other notes.
    const seen = withDeveloperNoteRead(withDeveloperNoteRead([], note("gh-1", "aaaa")), note("gh-1", "bbbb"));
    expect(seen).toEqual(["gh-1:bbbb"]);
  });

  it("returns the same array when the note is already read", () => {
    const only = note("gh-1", "aaaa");
    const seen = withDeveloperNoteRead([], only);
    expect(withDeveloperNoteRead(seen, only)).toBe(seen);
  });

  it("counts only unread notes", () => {
    const notes = [note("gh-1", "aaaa"), note("gh-2", "bbbb"), note("gh-3", "cccc")];
    const seen = withDeveloperNoteRead([], notes[1]!);
    expect(countUnreadDeveloperNotes(seen, notes)).toBe(2);
  });
});

describe("developer note marker pruning", () => {
  it("drops markers for retracted notes", () => {
    // Without pruning the marker list grows without bound and, once capped, evicts markers
    // for live notes so an already-read note comes back as unread.
    const seen = ["gh-1:aaaa", "gh-2:bbbb"];
    expect(pruneDeveloperNoteSeen(seen, [note("gh-2", "bbbb")])).toEqual(["gh-2:bbbb"]);
  });

  it("returns the same array when nothing was retracted", () => {
    const seen = ["gh-1:aaaa"];
    expect(pruneDeveloperNoteSeen(seen, [note("gh-1", "aaaa")])).toBe(seen);
  });

  it("keeps a marker whose revision differs from the live note", () => {
    // The note was edited, not retracted — the marker still identifies what was read.
    const seen = ["gh-1:aaaa"];
    expect(pruneDeveloperNoteSeen(seen, [note("gh-1", "bbbb")])).toBe(seen);
  });

  it("drops malformed markers", () => {
    expect(pruneDeveloperNoteSeen(["", "no-separator", ":leading"], [note("gh-1", "aaaa")])).toEqual([]);
  });
});
