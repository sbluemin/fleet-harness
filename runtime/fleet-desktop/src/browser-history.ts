import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DESKTOP_BROWSER_PROFILE_ID } from "@fleet-console/protocol/desktop";
import { BROWSER_HISTORY_MAX_BYTES, BROWSER_HISTORY_MAX_ENTRIES, type BrowserHistoryVisit } from "@fleet-console/protocol/desktop/browser-history";
import { chromeUserDataDir } from "./chrome-cookies.js";

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

/** Chrome은 원본을 계속 쓸 수 있다. 원본을 SQLite로 열지 않고 안정된 사본만 읽는다. */
export function readChromeHistory(options: { profileId: string; userDataDir?: string; tempRoot?: string }): BrowserHistoryVisit[] {
  const root = options.userDataDir ?? chromeUserDataDir();
  if (!/^[A-Za-z0-9 ._-]+$/u.test(options.profileId) || options.profileId === "." || options.profileId === "..") throw new Error("chrome_profile_not_found");
  const source = path.join(root, options.profileId);
  if (path.dirname(fs.realpathSync(source)) !== fs.realpathSync(root)) throw new Error("chrome_profile_not_found");
  const history = path.join(source, "History");
  if (!fs.existsSync(history)) return [];
  const temp = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), "fleet-history-import-"));
  try {
    const files = ["History", "History-wal", "History-journal"];
    const fingerprint = () => files.map((name) => {
      const file = path.join(source, name);
      try {
        if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(source)) throw new Error("chrome_profile_not_found");
        const stat = fs.statSync(file, { bigint: true });
        return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = fingerprint();
      for (let i = 0; i < files.length; i += 1) {
        const target = path.join(temp, files[i]!);
        fs.rmSync(target, { force: true });
        if (before[i] !== null) fs.copyFileSync(path.join(source, files[i]!), target);
      }
      if (JSON.stringify(before) !== JSON.stringify(fingerprint())) continue;
      const db = new DatabaseSync(path.join(temp, "History"));
      try {
        const statement = db.prepare("SELECT url, title, visit_count, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?");
        // Chromium의 1601년 기준 microseconds는 Number의 안전한 정수 범위를 넘는다.
        statement.setReadBigInts(true);
        const rows = statement.all(BROWSER_HISTORY_MAX_ENTRIES);
        return rows.map((row) => ({ url: String(row.url), title: String(row.title ?? ""), visits: Number(row.visit_count), lastVisited: Number(BigInt(row.last_visit_time as bigint) / 1000n) - 11644473600000 }));
      } finally { db.close(); }
    }
    throw new Error("chrome_history_busy");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
