import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BROWSER_HISTORY_MAX_ENTRIES, type BrowserHistoryVisit } from "@fleet-console/protocol/desktop/browser-history";
import { chromeUserDataDir } from "./chrome-cookies.js";

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
