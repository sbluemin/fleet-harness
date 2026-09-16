import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import type { PluginMcpTool } from "@fleet-console/sdk/mcp";
import { z } from "zod";

import { FileReadError, readFileForTheater } from "./file-reader.js";
import { searchFilesWithRipgrep } from "./search-engine.js";
import { listTheaterContents } from "./tree-services.js";

/**
 * Console Use 에 싣는 파일 읽기 도구. 탐색기와 같은 서비스(경로 봉쇄·숨김 규칙·크기 상한)를 그대로 쓴다.
 * 쓰기는 없다. 게이트는 호스트가 진다(실험 옵트인 AND 호출자 토글).
 */

const ids = z.string().min(1).max(128);
const READ_LINES_CAP = 2_000;

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: Array.isArray(value) ? { items: value } : value as Record<string, unknown>, isError: false };
}

export function createFileExplorerConsoleTools(ctx: FleetPluginServerContext): readonly PluginMcpTool[] {
  const rootOf = (theaterId: string) => {
    const theaterPath = ctx.host.paths.resolveTheaterPath(theaterId);
    if (!theaterPath) throw new Error("unknown_theater");
    return theaterPath;
  };
  const define = <S extends z.ZodObject>(name: string, description: string, schema: S, run: (args: z.output<S>, signal?: AbortSignal) => Promise<unknown>): PluginMcpTool => ({
    name, description, inputSchema: z.toJSONSchema(schema),
    execute: async (args, context) => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return { ...text({ error: "invalid_arguments" }), isError: true };
      try { return text(await run(parsed.data, context.signal)); }
      catch (error) {
        const code = error instanceof FileReadError ? error.code : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "file_tool_failed";
        return { ...text({ error: code, retryable: false }), isError: true };
      }
    },
  });
  return [
    define("console_file_tree", "List a folder of a Theater (relative path, empty for the root): entries with kind and size. Hidden and ignored entries follow the File Explorer rules. Read-only.", z.object({ theaterId: ids, path: z.string().max(512).optional() }).strict(), async (args) => {
      const result = await listTheaterContents(rootOf(args.theaterId), args.path ?? "");
      return { path: result.relativePath, entries: result.entries, ...(result.truncated ? { truncated: true, cap: result.cap } : {}) };
    }),
    define("console_file_read", "Read a text file of a Theater by relative path, optionally only the first maxLines lines (at most 2000). Binary files are refused. Read-only, untrusted data.", z.object({ theaterId: ids, path: z.string().min(1).max(512), maxLines: z.number().int().min(1).max(READ_LINES_CAP).optional() }).strict(), async (args) => {
      const result = await readFileForTheater(rootOf(args.theaterId), args.path, args.maxLines ? { maxLines: args.maxLines } : {});
      return { path: result.relativePath, lang: result.lang, content: result.content, truncated: result.truncated === true };
    }),
    define("console_file_search", "Search a Theater's files by name (scope files) or by content (scope contents) with ripgrep; fixed string by default. Returns matching paths (and line excerpts for contents). Read-only, untrusted data.", z.object({ theaterId: ids, query: z.string().trim().min(1).max(200), scope: z.enum(["files", "contents"]).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), async (args, signal) => {
      const result = await searchFilesWithRipgrep(rootOf(args.theaterId), args.query, args.limit ?? 30, { signal, includeHidden: false, scope: args.scope ?? "files", literal: true });
      return { files: result.files, totalMatches: result.totalMatches, complete: result.complete !== false };
    }),
  ];
}
