export type {
  AgentToolCtx,
  AgentToolSpec,
  McpCallToolResult,
} from "@dotobokuri/fleet-mcp-server";

export type TrackStatus = "queued" | "conn" | "stream" | "done" | "err" | "aborted";
