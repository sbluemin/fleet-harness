import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DESKTOP_BROWSER_PROFILE_ID } from "@fleet-console/protocol/desktop";
import { BROWSER_HISTORY_MAX_BYTES } from "@fleet-console/protocol/desktop/browser-history";

/** Console이 소유한 snapshot의 파일 IO만 맡는다. 경로는 셸이 정하며 임시 세션에는 파일이 없다. */
export function createBrowserHistoryStorage(root: string) {
  const fileFor = (profile: unknown): string => {
    if (typeof profile !== "string" || !DESKTOP_BROWSER_PROFILE_ID.test(profile)) throw new Error("browser_profile_invalid");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = path.join(root, profile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (path.dirname(fs.realpathSync(directory)) !== fs.realpathSync(root)) throw new Error("browser_profile_invalid");
    const file = path.join(directory, "fleet-history.json");
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error("browser_history_invalid"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return file;
  };
  const read = (file: string): string | null => {
    try {
      if (fs.statSync(file).size > BROWSER_HISTORY_MAX_BYTES) throw new Error("browser_history_too_large");
      return fs.readFileSync(file, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const revision = (data: string | null) => createHash("sha256").update(data ?? "").digest("hex");
  return {
    command(params: Record<string, unknown>) {
      const file = fileFor(params.browserProfile);
      const current = read(file);
      if (params.action === "read") return { data: current, revision: revision(current) };
      if (params.action !== "write" || typeof params.data !== "string" || Buffer.byteLength(params.data) > BROWSER_HISTORY_MAX_BYTES) throw new Error("browser_history_invalid");
      if (params.revision !== revision(current)) throw new Error("browser_history_changed");
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, params.data, { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
      return { data: null, revision: revision(params.data) };
    },
    clear(profile: string) { fs.rmSync(fileFor(profile), { force: true }); },
  };
}
