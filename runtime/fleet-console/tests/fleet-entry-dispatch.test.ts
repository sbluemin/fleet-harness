import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAiGatewaySettingsStore,
  createProviderAuthService,
  SUBSCRIPTION_SIGNED_OUT_ENTRY,
  CODEX_AUTH_PROVIDER_ID,
  XAI_AUTH_PROVIDER_ID,
} from "@fleet-console/ai-gateway";

import { dispatchGatewayCommand } from "../cli/gateway/dispatcher.js";
import { classifyFleetArgv, dispatchFleetArgv } from "../cli/fleet-dispatch.js";

function createIo() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      },
      isTTY: false as boolean | undefined,
      toString() {
        return stdout;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      },
      toString() {
        return stderr;
      },
    },
  };
}

describe("dual-entry dispatch", () => {

  it("reserves fleet gateway and treats a bare invocation as help", () => {
    expect(classifyFleetArgv(["gateway"])).toEqual({ kind: "gateway", gatewayArgv: [] });
    expect(classifyFleetArgv(["gateway", "set", "wire-log", "on"])).toEqual({
      kind: "gateway",
      gatewayArgv: ["set", "wire-log", "on"],
    });
    expect(classifyFleetArgv([])).toEqual({ kind: "help" });
    expect(classifyFleetArgv(["--help"])).toEqual({ kind: "help" });
    expect(classifyFleetArgv(["cli", "gateway"])).toEqual({ kind: "unknown", command: "cli" });
    expect(classifyFleetArgv(["--version"])).toEqual({ kind: "version" });
  });

  it("prints help for bare fleet and rejects a retired cli invocation", async () => {
    const helpIo = createIo();
    const helpStatus = await dispatchFleetArgv([], {
      stdout: helpIo.stdout,
      stderr: helpIo.stderr,
      env: {},
      dispatchUpdateCommand: (async () => 0) as never,
    });
    expect(helpStatus).toBe(0);
    expect(helpIo.stdout.toString()).toContain("console");
    expect(helpIo.stderr.toString()).toBe("");

    const io = createIo();
    const status = await dispatchFleetArgv(["cli", "--version"], {
      stdout: io.stdout,
      stderr: io.stderr,
      env: {},
      dispatchUpdateCommand: (async () => 0) as never,
    });
    expect(status).not.toBe(0);
    const stderr = io.stderr.toString();
    expect(stderr).toContain("Unknown fleet command: cli");
    expect(stderr).toContain("fleet --help");
    expect(io.stdout.toString()).toBe("");
  });

  it("keeps entry isolation: fleet entry never imports the direct-run-guarded Console entry", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = fs.readFileSync(path.join(packageRoot, "cli", "fleet-entry.ts"), "utf8");
    expect(source).toContain("./fleet-dispatch.js");
    expect(source).not.toContain("../core/host/cli.js");
    expect(source).not.toContain("basename");
    expect(source).toContain("process.exitCode = status");
    expect(source).not.toContain("process.exit(status)");
  });
});

describe("fleet gateway status credentials", () => {
  it("reports a CLI-only Codex or Grok sign-in and not a signed-out marker", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-gateway-status-"));
    const codexHome = path.join(directory, "codex");
    const grokHome = path.join(directory, "grok");
    const dataDir = path.join(directory, "console");
    fs.mkdirSync(codexHome);
    fs.mkdirSync(grokHome);
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(codexHome, "auth.json"), `${JSON.stringify({
      tokens: { access_token: "cli-access", account_id: "acct-cli" },
    })}\n`);
    fs.writeFileSync(path.join(grokHome, "auth.json"), `${JSON.stringify({
      "https://auth.x.ai::client": {
        oidc_issuer: "https://auth.x.ai",
        key: "grok-access",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    })}\n`);
    const authService = createProviderAuthService({ dataDir });
    const store = createAiGatewaySettingsStore({ dataDir });
    const env = { CODEX_HOME: codexHome, GROK_HOME: grokHome };
    async function states(): Promise<Record<string, string>> {
      const io = createIo();
      const status = await dispatchGatewayCommand(["status", "--json"], io, {
        env,
        dataDir,
        createAuthService: () => authService,
        createStore: () => store,
      });
      expect(status).toBe(0);
      const report = JSON.parse(io.stdout.toString()) as { credentials: Array<{ provider: string; state: string }> };
      return Object.fromEntries(report.credentials.map((item) => [item.provider, item.state]));
    }
    try {
      await expect(states()).resolves.toEqual({ codex: "present", xai: "present", cursor: "absent" });
      await authService.setEntry(CODEX_AUTH_PROVIDER_ID, { ...SUBSCRIPTION_SIGNED_OUT_ENTRY });
      await authService.setEntry(XAI_AUTH_PROVIDER_ID, { ...SUBSCRIPTION_SIGNED_OUT_ENTRY });
      await expect(states()).resolves.toEqual({ codex: "absent", xai: "absent", cursor: "absent" });
      expect(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")).toContain("cli-access");
      expect(fs.readFileSync(path.join(grokHome, "auth.json"), "utf8")).toContain("grok-access");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
