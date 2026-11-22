import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const DEDUP_MS = 10 * 60_000;
const SLUG = /^[a-z][a-z0-9_-]{0,63}$/u;
const RESULT_CODE = /^[a-z][a-z0-9_:-]{0,79}$/u;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
export type FeedbackKind = "failure" | "inefficiency" | "confusing" | "missing" | "other";
export interface FeedbackFields {
  tool: string;
  kind: FeedbackKind;
  summary: string;
  details?: string;
  errorCode?: string;
}
export interface FeedbackContext {
  readonly sessionKey: string;
  readonly objectiveId?: string;
  readonly actor: string;
  readonly fleetVersion: string;
  readonly helperVersion?: string | number;
  readonly os: string;
  readonly recentCalls?: readonly { tool: string; action?: string; code: string }[];
}
export interface FeedbackReceipt { id: string; occurrences: number }
interface RecentTicket { id: string; at: number }

function sanitizeDetails(details: string): string {
  return Array.from(details.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u{2028}\u{2029}]/gu, "")).slice(0, 4000).join("");
}
function summaryLine(summary: string): string {
  return sanitizeDetails(summary).replace(/[\n\t]+/gu, " ").trim().slice(0, 200);
}
const markdownHeading = (value: string) => value.replace(/[\\`*_{}[\]()#+.!<>|~&=\-]/gu, "\\$&");
const yamlString = (value: string) => JSON.stringify(summaryLine(value));
const yamlAtom = (value: string | number) => typeof value === "number" ? String(value) : SLUG.test(value) ? value : yamlString(value);

async function ensurePrivateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const entry = await lstat(path);
  if (!entry.isDirectory()) throw new Error("feedback_directory_unavailable");
  if ((entry.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

function renderTicket(id: string, toolset: string, fields: FeedbackFields, context: FeedbackContext, at: string, summary: string, details: string): string {
  const calls = (context.recentCalls ?? []).slice(-5).filter(({ tool, action, code }) => SLUG.test(tool) && (action === undefined || SLUG.test(action)) && RESULT_CODE.test(code));
  return [
    "---", `id: ${id}`, `toolset: ${toolset}`, `tool: ${fields.tool}`, `kind: ${fields.kind}`, "status: open", "occurrences: 1",
    `createdAt: ${at}`, `updatedAt: ${at}`,
    ...(context.objectiveId ? [`objectiveId: ${yamlAtom(context.objectiveId)}`] : []),
    `actor: ${yamlAtom(context.actor)}`, `fleetVersion: ${yamlAtom(context.fleetVersion)}`,
    `helperVersion: ${yamlAtom(context.helperVersion ?? "unknown")}`, `os: ${yamlAtom(context.os)}`,
    ...(fields.errorCode ? [`errorCode: ${yamlAtom(fields.errorCode)}`] : []),
    ...(calls.length ? ["recentCalls:", ...calls.map(({ tool, action, code }) => `  - ${yamlString(`${tool}${action ? ` ${action}` : ""} ${code}`)}`)] : ["recentCalls: []"]),
    "---", `# ${markdownHeading(summary)}`, "", details, "",
  ].join("\n");
}

async function updateTicket(path: string, id: string, at: string, details: string): Promise<number | null> {
  let previous: string;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error("feedback_ticket_unavailable");
      previous = await file.readFile("utf8");
    } finally { await file.close(); }
  } catch (error) { if (isMissing(error)) return null; throw error; }
  const end = previous.indexOf("\n---\n", 4);
  if (!previous.startsWith(`---\nid: ${id}\n`) || end === -1) throw new Error("feedback_ticket_unavailable");
  const header = previous.slice(0, end);
  const oldCount = /^occurrences: (\d+)$/mu.exec(header);
  const occurrences = Number(oldCount?.[1]) + 1;
  if (!Number.isSafeInteger(occurrences) || occurrences < 2 || !/^updatedAt: .+$/mu.test(header)) throw new Error("feedback_ticket_unavailable");
  const nextHeader = header.replace(/^occurrences: \d+$/mu, `occurrences: ${occurrences}`).replace(/^updatedAt: .+$/mu, `updatedAt: ${at}`);
  const updated = nextHeader + previous.slice(end) + (details ? `\n---\n\n${details}\n` : "");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
  return occurrences;
}

export function createFeedbackStore({ root, toolset, prefix, now = () => new Date() }: {
  readonly root: string;
  readonly toolset: string;
  readonly prefix: string;
  readonly now?: () => Date;
}) {
  if (!SLUG.test(toolset) || !/^[A-Z][A-Z0-9]{0,7}$/u.test(prefix)) throw new Error("invalid_feedback_toolset");
  const feedback = join(root, "feedback");
  const directory = join(feedback, toolset);
  const recent = new Map<string, RecentTicket>();
  let tail: Promise<unknown> = Promise.resolve();

  async function save(fields: FeedbackFields, context: FeedbackContext): Promise<FeedbackReceipt> {
    const summary = summaryLine(fields.summary);
    if (!summary || !SLUG.test(fields.tool) || !["failure", "inefficiency", "confusing", "missing", "other"].includes(fields.kind)) throw new Error("invalid_feedback_fields");
    const details = sanitizeDetails(fields.details ?? "");
    const timestamp = now();
    const at = timestamp.toISOString();
    const stamp = timestamp.getTime();
    const day = at.slice(0, 10).replaceAll("-", "");
    const key = JSON.stringify([context.sessionKey, fields.tool, fields.kind, summary]);
    for (const [candidate, item] of recent) if (stamp < item.at || stamp - item.at >= DEDUP_MS) recent.delete(candidate);

    await mkdir(root, { recursive: true, mode: 0o700 });
    await ensurePrivateDirectory(feedback);
    await ensurePrivateDirectory(directory);

    const previous = recent.get(key);
    if (previous) {
      const occurrences = await updateTicket(join(directory, `${previous.id}.md`), previous.id, at, details);
      if (occurrences !== null) {
        recent.set(key, { id: previous.id, at: stamp });
        return { id: previous.id, occurrences };
      }
      recent.delete(key);
    }

    const pattern = new RegExp(`^${prefix}-${day}-(\\d{4})\\.md$`, "u");
    const ids = (await readdir(directory)).flatMap((name) => {
      const sequence = pattern.exec(name)?.[1];
      return sequence ? [Number(sequence)] : [];
    });
    const start = ids.reduce((largest, sequence) => Math.max(largest, sequence), 0) + 1;
    for (let i = start; i <= 9999; i += 1) {
      const id = `${prefix}-${day}-${String(i).padStart(4, "0")}`;
      const path = join(directory, `${id}.md`);
      let file;
      try { file = await open(path, "wx", 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      try { await file.writeFile(renderTicket(id, toolset, fields, context, at, summary, details), "utf8"); }
      catch (error) { await unlink(path).catch(() => undefined); throw error; }
      finally { await file.close(); }
      recent.set(key, { id, at: stamp });
      return { id, occurrences: 1 };
    }
    throw new Error("feedback_sequence_exhausted");
  }

  return {
    submit(fields: FeedbackFields, context: FeedbackContext): Promise<FeedbackReceipt> {
      const result = tail.then(() => save(fields, context));
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
