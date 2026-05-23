export type {
  AgentToolCtx,
  AgentToolSpec,
  McpCallToolResult,
} from "@sbluemin/fleet-mcp-server";

export type TrackStatus = "queued" | "conn" | "stream" | "done" | "err" | "aborted";
