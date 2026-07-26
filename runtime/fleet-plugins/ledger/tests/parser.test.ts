import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTokscaleOutput } from "../server/parser.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tokscale-report.json");
const fixture = fs.readFileSync(fixturePath, "utf8");

describe("parseTokscaleOutput", () => {
  it("validates the measured tokscale session shape", () => {
    const result = parseTokscaleOutput(fixture);
    expect(result.status).toBe("ok");
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions[0]).toMatchObject({
      sessionId: "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103",
      input: 1_200_000,
      cacheRead: 900_000,
      costUsd: 2.25,
    });
  });

  it("drops an individual session when a required field is missing", () => {
    const raw = JSON.parse(fixture) as Array<Record<string, unknown>>;
    delete raw[0]?.total_cost;
    const result = parseTokscaleOutput(JSON.stringify(raw));
    expect(result.status).toBe("degraded");
    expect(result.sessions).toHaveLength(2);
    expect(result.skippedSessions).toBe(1);
  });

  // 실측: tokscale은 workspace를 판정하지 못한 세션(이 기기에서는 kimi 2건)에 null을 준다.
  // Theater 스코프는 Operation.theaterId로 걸므로 이 필드는 쓰지 않는다 — 필수로 요구하면
  // 콘솔이 실제로 기동하는 CLI의 사용량이 통째로 사라진다.
  it("keeps sessions whose workspace tokscale could not resolve", () => {
    const raw = JSON.parse(fixture) as Array<Record<string, unknown>>;
    raw[0]!.workspace = null;
    raw[0]!.workspace_label = null;
    const result = parseTokscaleOutput(JSON.stringify(raw));
    expect(result.status).toBe("ok");
    expect(result.skippedSessions).toBe(0);
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions[0]).toMatchObject({ workspace: null, workspaceLabel: null, costUsd: 2.25 });
  });

  it("marks wholly incompatible output unreadable", () => {
    const result = parseTokscaleOutput(JSON.stringify([{ session_id: "only-one-field" }]));
    expect(result).toEqual({ status: "unreadable", sessions: [], skippedSessions: 1 });
    expect(parseTokscaleOutput("{}").status).toBe("unreadable");
  });

  it.each([
    ["negative token", "total_input_tokens", -3.5],
    ["negative messages", "message_count", -1],
    ["negative cost", "total_cost", -2],
    ["huge token", "total_output_tokens", Number.MAX_VALUE],
    ["unsafe integer", "total_cache_read", Number.MAX_SAFE_INTEGER + 1],
    ["fractional epoch", "created_at", 1.5],
  ])("rejects %s numeric values", (_label, field, value) => {
    const [row] = JSON.parse(fixture) as Array<Record<string, unknown>>;
    row![field] = value;
    const result = parseTokscaleOutput(JSON.stringify([row]));
    expect(result).toEqual({ status: "unreadable", sessions: [], skippedSessions: 1 });
  });

  it.each(["antigravity-cli", "pi", "grok"])("preserves safe client identifier %s", (client) => {
    const [row] = JSON.parse(fixture) as Array<Record<string, unknown>>;
    row!.client = client;
    const result = parseTokscaleOutput(JSON.stringify([row]));
    expect(result.status).toBe("ok");
    expect(result.sessions[0]?.client).toBe(client);
  });

  it.each([
    "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103",
    "/Users/private/transcript",
    "client name",
  ])("folds unsafe client identifier %s into other without dropping the session", (client) => {
    const [row] = JSON.parse(fixture) as Array<Record<string, unknown>>;
    row!.client = client;
    const result = parseTokscaleOutput(JSON.stringify([row]));
    expect(result.status).toBe("ok");
    expect(result.sessions[0]?.client).toBe("other");
  });

  it("drops unsafe model strings while retaining valid model identifiers", () => {
    const [row] = JSON.parse(fixture) as Array<Record<string, unknown>>;
    row!.models_used = [
      "gpt-5",
      "openai/gpt-5",
      "/Users/private/model",
      "../../transcript",
      "30bf2ab7-5a5d-4a8c-8aaa-730a40ecf103",
      "x".repeat(65),
      "model name",
    ];
    const result = parseTokscaleOutput(JSON.stringify([row]));
    expect(result.sessions[0]?.models).toEqual(["gpt-5", "openai/gpt-5"]);
  });
});
