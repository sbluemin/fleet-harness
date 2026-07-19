import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveTheaterRoot } from "../core/host/theater-root.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Theater root resolver", () => {
  it("returns the canonical real directory", async () => {
    const root = makeRoot();
    const alias = `${root}-alias`;
    fs.symlinkSync(root, alias);
    tempDirs.push(alias);
    await expect(resolveTheaterRoot(alias)).resolves.toEqual({ realRoot: fs.realpathSync(root) });
  });

  it("fails closed for missing and non-directory roots", async () => {
    const root = makeRoot();
    await expect(resolveTheaterRoot(path.join(root, "missing"))).rejects.toMatchObject({ code: "not_found" });
    const file = path.join(root, "file");
    fs.writeFileSync(file, "x");
    await expect(resolveTheaterRoot(file)).rejects.toMatchObject({ code: "invalid_path" });
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-theater-root-"));
  tempDirs.push(root);
  return root;
}
