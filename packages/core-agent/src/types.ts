export type {
  AgentToolCtx,
  AgentToolSpec,
  McpCallToolResult,
} from "@dotobokuri/core-mcp-server";

export type TrackStatus = "queued" | "conn" | "stream" | "done" | "err" | "aborted";
