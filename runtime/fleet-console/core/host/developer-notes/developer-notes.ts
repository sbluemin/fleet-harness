import { createHash } from "node:crypto";

/**
 * Developer notes are maintainer-authored broadcast messages that reach users without a
 * release or a commit. The channel is a GitHub issue carrying the `note` label; the note
 * is retracted by closing the issue.
 *
 * Three gates decide who may speak, and only the third one lives in this code:
 * 1. GitHub requires push access to attach a label at all.
 * 2. The request narrows the author server-side with `creator`.
 * 3. This service re-checks the author against a compiled-in allowlist.
 *
 * Gate 1 alone is not a contract: a collaborator with the Triage role can attach labels,
 * and whether an issue template's `labels:` front matter applies for an author without
 * write access is not documented. Gates 2 and 3 cover both cases.
 *
 * Trust boundary — read this before widening the channel. The gates authenticate the
 * issue's *author*, not the author of its *current text*. A collaborator with write access
 * can edit an open note and GitHub still reports the original author in `user.login` and
 * `author_association`; unauthenticated REST exposes no editor identity for issues, the
 * GraphQL field that does requires a token, and every alternative artifact (release,
 * comment, gist) behaves the same way. So the real boundary is "anyone with write access
 * to this repository", not "the allowlist". That matches the boundary the console already
 * grants: it fetches CHANGELOG.md live from `main` and renders it, so the same set of
 * people can already change what every running console displays without a release. What
 * the allowlist does buy is blocking outside contributors, who can open an issue but
 * cannot label one or edit anyone else's. Narrowing this further needs content signing or
 * an authenticated read, and both would have to cover the changelog path too.
 */

export interface DeveloperNote {
  /** Stable per-issue identity, e.g. `gh-482`. */
  readonly id: string;
  /** Short content digest over the rendered fields. Changes when the note is edited. */
  readonly hash: string;
  readonly title: string;
  /** Markdown source. The browser renders it through the shared sanitizing renderer. */
  readonly body: string;
  readonly url: string;
  readonly publishedAt: string;
}

export interface DeveloperNotesResponse {
  readonly notes: readonly DeveloperNote[];
  /** Digest over the whole note set. Equal digests mean nothing user-visible changed. */
  readonly snapshotHash: string;
  readonly stale: boolean;
}

export type DeveloperNotesUnavailableReason = "cold_unavailable" | "negative_cache";

export class DeveloperNotesUnavailableError extends Error {
  readonly reason: DeveloperNotesUnavailableReason;

  constructor(reason: DeveloperNotesUnavailableReason) {
    super("Developer notes are unavailable");
    this.name = "DeveloperNotesUnavailableError";
    this.reason = reason;
  }
}

export interface DeveloperNotesRefreshOptions {
  readonly force?: boolean;
}

export interface DeveloperNotesService {
  refresh(options?: DeveloperNotesRefreshOptions): Promise<DeveloperNotesResponse>;
}

interface DeveloperNotesServiceDeps {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/** Logins allowed to publish a developer note. Gate 3. */
export const DEVELOPER_NOTE_AUTHORS: readonly string[] = ["sbluemin"];
/** GitHub association values that still count as the project speaking. */
const ALLOWED_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const NOTES_URL =
  "https://api.github.com/repos/sbluemin/fleet-harness/issues"
  + `?labels=note&state=open&sort=created&direction=desc&per_page=20&creator=${DEVELOPER_NOTE_AUTHORS[0]}`;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_NOTE_BODY_LENGTH = 16 * 1024;
const MAX_NOTE_TITLE_LENGTH = 200;
const MAX_NOTES = 20;
const HASH_LENGTH = 16;
const SUCCESS_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;

interface GithubIssue {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly html_url?: unknown;
  readonly created_at?: unknown;
  readonly author_association?: unknown;
  readonly user?: { readonly login?: unknown } | null;
  readonly pull_request?: unknown;
}

export function createDeveloperNotesService(deps: DeveloperNotesServiceDeps = {}): DeveloperNotesService {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  // fetchedAt stays here and never enters the payload: a per-request timestamp in the
  // response would change the body on every poll and defeat the snapshot-hash gate that
  // this whole feature depends on.
  let lastSuccess: DeveloperNotesResponse | null = null;
  let lastSuccessAt = 0;
  let lastFailureAt = 0;
  let inFlight: Promise<DeveloperNotesResponse> | null = null;
  let forceInFlight: Promise<DeveloperNotesResponse> | null = null;

  async function refresh(options: DeveloperNotesRefreshOptions = {}): Promise<DeveloperNotesResponse> {
    const currentTime = now();
    if (options.force) {
      if (forceInFlight) return await forceInFlight;
      const pending = runFetch().finally(() => {
        if (forceInFlight === pending) forceInFlight = null;
      });
      forceInFlight = pending;
      return await pending;
    }
    if (lastSuccess && currentTime - lastSuccessAt < SUCCESS_TTL_MS) return lastSuccess;
    if (lastFailureAt > 0 && currentTime - lastFailureAt < NEGATIVE_TTL_MS) {
      if (lastSuccess) return { ...lastSuccess, stale: true };
      throw new DeveloperNotesUnavailableError("negative_cache");
    }
    if (inFlight) return await inFlight;
    const pending = runFetch().finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
    return await pending;
  }

  function runFetch(): Promise<DeveloperNotesResponse> {
    return fetchNotes()
      .then((notes) => {
        const snapshotHash = computeSnapshotHash(notes);
        lastSuccessAt = now();
        lastFailureAt = 0;
        // Identical content keeps the previous object so callers can compare by reference
        // and skip re-rendering an unchanged list.
        if (lastSuccess && lastSuccess.snapshotHash === snapshotHash && !lastSuccess.stale) return lastSuccess;
        lastSuccess = { notes, snapshotHash, stale: false };
        return lastSuccess;
      })
      .catch((error: unknown) => {
        lastFailureAt = now();
        if (lastSuccess) return { ...lastSuccess, stale: true };
        if (error instanceof DeveloperNotesUnavailableError) throw error;
        throw new DeveloperNotesUnavailableError("cold_unavailable");
      });
  }

  async function fetchNotes(): Promise<readonly DeveloperNote[]> {
    const controller = new AbortController();
    const timer = setTimer(() => controller.abort(), FETCH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(NOTES_URL, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        signal: controller.signal,
      });
      if (!response.ok) throw new DeveloperNotesUnavailableError("cold_unavailable");
      const text = await readTextWithByteLimit(response, controller);
      return parseDeveloperNotes(text);
    } finally {
      clearTimer(timer);
    }
  }

  return { refresh };
}

export function parseDeveloperNotes(payload: string): readonly DeveloperNote[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new DeveloperNotesUnavailableError("cold_unavailable");
  }
  if (!Array.isArray(parsed)) throw new DeveloperNotesUnavailableError("cold_unavailable");
  const notes: DeveloperNote[] = [];
  for (const entry of parsed) {
    const note = toDeveloperNote(entry as GithubIssue);
    if (note !== null) notes.push(note);
    if (notes.length === MAX_NOTES) break;
  }
  return notes;
}

function toDeveloperNote(issue: GithubIssue | null | undefined): DeveloperNote | null {
  if (issue === null || typeof issue !== "object") return null;
  // The issues endpoint returns pull requests through the same list; a merged PR must never
  // surface as a developer note.
  if (issue.pull_request !== undefined) return null;
  if (!isAuthorizedAuthor(issue)) return null;
  if (typeof issue.number !== "number" || !Number.isInteger(issue.number)) return null;
  if (typeof issue.title !== "string") return null;
  if (typeof issue.html_url !== "string" || !issue.html_url.startsWith("https://github.com/")) return null;
  if (typeof issue.created_at !== "string") return null;
  const title = issue.title.trim().slice(0, MAX_NOTE_TITLE_LENGTH);
  if (title.length === 0) return null;
  const body = typeof issue.body === "string" ? issue.body.trim().slice(0, MAX_NOTE_BODY_LENGTH) : "";
  const id = `gh-${issue.number}`;
  return {
    id,
    hash: digest(`${id}\n${title}\n${body}`).slice(0, HASH_LENGTH),
    title,
    body,
    url: issue.html_url,
    publishedAt: issue.created_at,
  };
}

function isAuthorizedAuthor(issue: GithubIssue): boolean {
  const login = issue.user?.login;
  if (typeof login !== "string" || !DEVELOPER_NOTE_AUTHORS.includes(login)) return false;
  return typeof issue.author_association === "string" && ALLOWED_AUTHOR_ASSOCIATIONS.has(issue.author_association);
}

export function computeSnapshotHash(notes: readonly DeveloperNote[]): string {
  return digest(notes.map((note) => `${note.id}:${note.hash}`).join("\n"));
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readTextWithByteLimit(response: Response, controller: AbortController): Promise<string> {
  const body = response.body;
  if (body === null) return await response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new DeveloperNotesUnavailableError("cold_unavailable");
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(joinChunks(chunks, totalBytes));
  } finally {
    reader.releaseLock();
  }
}

function joinChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
