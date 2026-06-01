import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getCarriersFilePath,
  initStore,
  readCarriersSnapshot,
  resetStoreForTests,
  saveAgentCliSelection,
  updateCarriers,
  withStoreLock,
} from "../../src/index.js";

let tempDir: string | null = null;

describe("carriers.json state IO", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-carriers-state-"));
    initStore(tempDir);
  });

  afterEach(() => {
    resetStoreForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("heals readCarriersSnapshot with persona defaults and drops invalid agentCli values", () => {
    writeCarriersJson({
      _meta: { generation: 4 },
      carriers: {
        ohio: {
          agentCliType: "codex",
          agentCli: {
            codex: { model: "not-a-real-model", effort: "not-a-real-effort" },
          },
        },
      },
    });

    const snapshot = readCarriersSnapshot({
      ohio: {
        cliType: "codex",
        defaultAgentMode: "subagent",
        defaultModel: "gpt-5.5",
        defaultEffort: "low",
      },
    });

    expect(snapshot.generation).toBe(4);
    expect(snapshot.carriers.ohio?.agentMode).toBe("subagent");
    expect(snapshot.carriers.ohio?.agentCliType).toBe("codex");
    expect(snapshot.carriers.ohio?.agentCli.codex).toEqual({ model: "gpt-5.5", effort: "low" });
  });

  it("does not persist invalid agentCli selections on write", () => {
    saveAgentCliSelection("ohio", "codex", { model: "not-a-real-model", effort: "low" });

    const filePath = getCarriersFilePath();
    expect(filePath).toBeTruthy();
    expect(fs.existsSync(filePath!)).toBe(false);
  });

  it("increments generation monotonically for lock-serialized writes", () => {
    updateCarriers((states) => {
      states.carriers = { ohio: { displayName: "Ohio Prime" } };
    });
    updateCarriers((states) => {
      states.carriers = { ...(states.carriers ?? {}), genesis: { displayName: "Genesis Prime" } };
    });

    const raw = JSON.parse(fs.readFileSync(getCarriersFilePath()!, "utf-8")) as { _meta?: { generation?: number } };
    expect(raw._meta?.generation).toBe(2);
  });

  it("recovers ownerless stale locks by renaming them out of the lock path", () => {
    expect(tempDir).toBeTruthy();
    const lockDir = path.join(tempDir!, "carriers.json.lock");
    fs.mkdirSync(lockDir);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, old, old);

    let entered = false;
    withStoreLock(() => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(fs.readdirSync(tempDir!).filter((entry) => entry.includes(".stale."))).toEqual([]);
  });

});

function writeCarriersJson(value: unknown): void {
  if (!tempDir) throw new Error("테스트 store가 초기화되지 않았습니다.");
  fs.writeFileSync(path.join(tempDir, "carriers.json"), JSON.stringify(value), "utf-8");
}
