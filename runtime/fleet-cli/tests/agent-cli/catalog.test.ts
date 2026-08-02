import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getAgentCliInjectionCapability,
  getAgentCliIds,
  parseAgentCliId,
  resolveAgentCliProfile,
} from "@dotobokuri/fleet-admiral";

const tempRoots: string[] = [];

describe("agent CLI catalog", () => {
  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("includes dedicated Agent CLI profiles", () => {
    expect(getAgentCliIds()).toEqual([
      "claude",
    ]);
  });

  it("rejects removed Codex CLI values", () => {
    expect(() => parseAgentCliId("codex")).toThrow('Unsupported agent CLI "codex"');
  });

  it("rejects inherited object keys as CLI IDs", () => {
    for (const cliId of ["cursor", "toString", "constructor", "__proto__"]) {
      expect(() => parseAgentCliId(cliId)).toThrow(`Unsupported agent CLI "${cliId}"`);
    }
  });

  it("shares Claude terminal and message policy", async () => {
    const env = createEnvWithBins();
    const claude = await resolveAgentCliProfile(env, "/tmp", { cliId: "claude" });

    expect(claude.terminalName).toBe("xterm-256color");
    expect(claude.messagePolicy).toEqual({
      bracketedPaste: true,
      lineTerminator: "\r",
      multilineStrategy: "paste-mode",
    });
  });



  it("does not mutate process.env while creating profiles", async () => {
    const env = createEnvWithBins();
    const before = { ...process.env };

    await resolveAgentCliProfile(env, "/tmp", { cliId: "claude" });

    expect(process.env).toEqual(before);
  });





  it("uses native injection builders for dedicated profiles", () => {
    expect(getAgentCliInjectionCapability("claude")).toEqual({
      builderId: "claude-native",
      enabled: true,
    });
  });
});

function createEnvWithBins(): NodeJS.ProcessEnv {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-cli-"));
  tempRoots.push(tempRoot);
  for (const bin of ["claude"]) {
    const binPath = path.join(tempRoot, bin);
    fs.writeFileSync(binPath, "");
    fs.chmodSync(binPath, 0o755);
  }
  return {
    PATH: tempRoot,
  };
}
