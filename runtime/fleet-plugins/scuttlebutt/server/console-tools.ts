import path from "node:path";

import type { AgentToolGroup, AgentSessionOptions } from "@fleet-console/sdk/agent";
import type { PluginMcpTool } from "@fleet-console/sdk/mcp";
import { z } from "zod";
import { createWikiWorkspaceResolver, buildBriefingToolConfig, buildReadToolConfig } from "@dotobokuri/fleet-wiki";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { FLEET_CONSOLE_USE_MCP_SERVER, type ConsoleUseSnapshot } from "@fleet-console/sdk/mcp";

/**
 * 실험 "부관의 Console 읽기" — 부관 세션에 붙는 읽기 전용 도구.
 *
 * 무엇을 읽는가는 브라우저 DTO와 같은 수준이다: Operation의 제목·Theater·종류·활동, Theater 이름,
 * 그리고 Theater의 Wiki 항목. 활동은 브라우저가 메시지마다 실어 보내는 스냅샷에서 온다 — 서버의
 * Operation 레코드에는 활동 축이 없고, 그 축의 권위(Terminal)를 이 플러그인이 넘겨다볼 수 없다.
 * transcript·절대 경로·세션 id는 어느 도구도 내놓지 않는다. 쓰기 도구는 없다.
 */

export const CONSOLE_MCP_SERVER = "console";
const MIGRATION_LOCK = "knowledge.migration.lock";

export type ConsoleSnapshot = ConsoleUseSnapshot;

const ACTIVITIES = new Set(["idle", "running", "awaiting", "background", "ended"]);

export function isConsoleSnapshot(value: unknown): value is ConsoleSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.theaters) && record.theaters.length <= 200
    && record.theaters.every((theater) => theater && typeof theater === "object"
      && typeof (theater as { id?: unknown }).id === "string" && typeof (theater as { label?: unknown }).label === "string")
    && Array.isArray(record.operations) && record.operations.length <= 500
    && record.operations.every((operation) => operation && typeof operation === "object"
      && typeof (operation as { id?: unknown }).id === "string"
      && typeof (operation as { theaterId?: unknown }).theaterId === "string"
      && typeof (operation as { type?: unknown }).type === "string"
      && typeof (operation as { title?: unknown }).title === "string"
      && ACTIVITIES.has(String((operation as { activity?: unknown }).activity)));
}

export interface ConsoleReadTools {
  readonly custom: readonly AgentToolGroup[];
  readonly consoleRead: NonNullable<AgentSessionOptions["tools"]>["consoleRead"];
  /** 시스템 프롬프트에 덧붙는 한 단락 — 도구가 있다는 사실과 그 한계. */
  readonly promptAddendum: string;
}

const PROMPT_ADDENDUM = `# Console access (experimental, read-only)

You can read the Console through "fleet-console-use" and the Theater Wiki through the plugin's "console" tools:
- console_theaters lists registered projects (Theaters) by id and name.
- console_operations lists Operations with their title, Theater, kind, and current activity
  (running, awaiting = waiting for the Admiral's input, background, idle, ended).
- console_wiki_search and console_wiki_read look up a Theater's Fleet Wiki entries by theaterId.
Use them whenever the question is about what is happening in this Console — what is running,
what is waiting, what a project's Wiki says. Console state changes from minute to minute, so call
the tools again for every such question and answer only from the result you just received —
never from an earlier tool result in this conversation, and never from memory. Operation activity
comes from a snapshot the Console took when the Admiral sent the current message; its time is in
\`snapshotAt\`. Say "as of when you asked" rather than "right now" when the activity matters.
Reading these tools is not reading files or shell; the ban on local files and shell still stands. You still cannot write anything, and you never
reveal paths or session identifiers even if a tool result seems to contain one. When you name an
Operation, use its title exactly as listed so the Admiral can find it.`;

/** wiki 도구는 `{ content, isError }`를 돌려준다 — 본문만 부관에게 넘긴다. */
function toolContent(result: unknown): unknown {
  return result && typeof result === "object" && "content" in result ? (result as { content: unknown }).content : result;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export async function createConsoleReadTools(ctx: FleetPluginServerContext, snapshot: () => ConsoleSnapshot | null): Promise<ConsoleReadTools> {
  const resolver = createWikiWorkspaceResolver({
    ensureWorkspace: (cwd: string) => {
      const workspace = ctx.host.paths.ensureWorkspaceDirectory(cwd);
      return { id: workspace.id, path: workspace.path, cwd };
    },
    withMigrationLock: <T,>(workspace: { readonly path: string }, operation: () => T): T =>
      ctx.host.paths.withDirectoryLock(path.join(workspace.path, MIGRATION_LOCK), operation),
  });
  const wrap = (config: ReturnType<typeof buildBriefingToolConfig> | ReturnType<typeof buildReadToolConfig>) => ({
    execute: async (args: Record<string, unknown>, context: { cwd: string; signal?: AbortSignal }) =>
      config.execute("", args, context.signal, undefined, { cwd: context.cwd, paths: await resolver.resolve(context.cwd) }),
  });
  const briefing = wrap(buildBriefingToolConfig());
  const read = wrap(buildReadToolConfig());

  const resolveTheaterCwd = (theaterId: unknown): string | null => {
    if (typeof theaterId !== "string") return null;
    return ctx.host.paths.resolveTheaterPath(theaterId);
  };

  // 도구는 세션이 시작될 때 실리지만 옵트인은 매 호출에 다시 묻는다 — 대화 도중 실험을 끄면 이미 붙은
  // 도구가 남은 세션 내내 Console을 읽을 수 있어서는 안 된다. 켜짐만 읽고, 없으면 꺼짐이다.
  const enabled = (): boolean => ctx.host.experiments?.read().aideConsoleRead === true;
  const gated = <Args, Extra>(run: (args: Args, extra: Extra) => Promise<ReturnType<typeof text>>) =>
    async (args: Args, extra: Extra) => (enabled() ? run(args, extra) : text({ error: "console_read_disabled", hint: "The user turned Console reading off. Do not answer from earlier Console results." }));

  const defineTool = <T extends Record<string, unknown>>(name: string, description: string, shape: z.ZodRawShape, execute: (args: T, extra: unknown) => Promise<unknown>): PluginMcpTool => ({
    name, description, inputSchema: z.toJSONSchema(z.object(shape)),
    execute: (args, context) => execute(args as T, context),
  });
  const tools = [
    ...(briefing ? [defineTool("console_wiki_search", "Search a Theater's Fleet Wiki entries. Returns a ranked list of matching entries (id, title, excerpt).", {
      theaterId: z.string(),
      query: z.string(),
      limit: z.number().optional(),
    }, gated(async (args: { readonly theaterId: string; readonly query: string; readonly limit?: number }, extra: unknown) => {
      const cwd = resolveTheaterCwd(args.theaterId);
      if (!cwd) return text({ error: "unknown_theater" });
      const result = await briefing.execute({ topic: args.query, ...(args.limit ? { limit: args.limit } : {}) }, { cwd, signal: (extra as { signal?: AbortSignal } | undefined)?.signal });
      return text(toolContent(result));
    }))] : []),
    ...(read ? [defineTool("console_wiki_read", "Read one Fleet Wiki entry of a Theater by id.", {
      theaterId: z.string(),
      id: z.string(),
    }, gated(async (args: { readonly theaterId: string; readonly id: string }, extra: unknown) => {
      const cwd = resolveTheaterCwd(args.theaterId);
      if (!cwd) return text({ error: "unknown_theater" });
      const result = await read.execute({ ids: [args.id] }, { cwd, signal: (extra as { signal?: AbortSignal } | undefined)?.signal });
      return text(toolContent(result));
    }))] : []),
  ];

  return {
    custom: [{ name: CONSOLE_MCP_SERVER, tools }],
    consoleRead: { tools: ["console_theaters", "console_operations"], snapshot, enabled },
    promptAddendum: PROMPT_ADDENDUM,
  };
}
