import { fetchReleaseNotes } from "./api.js";
import { applyReleaseNotes, beginReleaseNotesFetch, failReleaseNotesFetch } from "./store.js";
import type { ReleaseNotesLocale } from "./types.js";

export interface ReleaseNotesRequestOptions {
  readonly force?: boolean;
  readonly locale: ReleaseNotesLocale;
}

let activeAbortController: AbortController | null = null;
let requestGeneration = 0;

export function requestReleaseNotes(options: ReleaseNotesRequestOptions): Promise<void> {
  activeAbortController?.abort();
  const controller = new AbortController();
  const generation = ++requestGeneration;
  activeAbortController = controller;
  beginReleaseNotesFetch();
  return fetchReleaseNotes({ ...options, signal: controller.signal })
    .then((response) => {
      if (generation === requestGeneration) applyReleaseNotes(response);
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted || generation !== requestGeneration) return;
      failReleaseNotesFetch(error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      if (generation === requestGeneration) activeAbortController = null;
    });
}

export function abortReleaseNotesFetch(): void {
  if (activeAbortController === null) return;
  activeAbortController.abort();
  activeAbortController = null;
  requestGeneration += 1;
}
