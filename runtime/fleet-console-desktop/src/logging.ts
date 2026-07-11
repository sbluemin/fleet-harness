import fs from "node:fs";
import path from "node:path";

export interface DesktopLogger { info(message: string): void; error(message: string): void; }

export function createDesktopLogger(dir: string): DesktopLogger {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "desktop.log");
  const write = (level: string, message: string) => fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${message.replace(/[\r\n]/g, " ")}\n`, { mode: 0o600 });
  return { info: (message) => write("INFO", message), error: (message) => write("ERROR", message) };
}
