export function remapReleaseNoteKey(
  previousNotes: readonly { readonly version: string }[],
  previousKey: string | null,
  nextNotes: readonly { readonly version: string }[],
): string | null {
  if (previousKey === null) return firstReleaseNoteKey(nextNotes);
  const previousIndex = previousNotes.findIndex((note, index) => releaseNoteKey(note.version, index) === previousKey);
  const selected = previousNotes[previousIndex];
  if (!selected) return firstReleaseNoteKey(nextNotes);

  const occurrence = previousNotes.slice(0, previousIndex + 1).filter((note) => note.version === selected.version).length;
  let seen = 0;
  for (let index = 0; index < nextNotes.length; index += 1) {
    if (nextNotes[index]?.version !== selected.version) continue;
    seen += 1;
    if (seen === occurrence) return releaseNoteKey(selected.version, index);
  }
  return firstReleaseNoteKey(nextNotes);
}

export function firstReleaseNoteKey(notes: readonly { readonly version: string }[]): string | null {
  return notes[0] ? releaseNoteKey(notes[0].version, 0) : null;
}

export function releaseNoteKeyExists(notes: readonly { readonly version: string }[], key: string): boolean {
  return notes.some((note, index) => releaseNoteKey(note.version, index) === key);
}

export function releaseNoteKey(version: string, index: number): string {
  return `${version}:${index}`;
}
