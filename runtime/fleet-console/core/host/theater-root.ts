import fs from "node:fs";
import path from "node:path";

export interface TheaterRootResolution {
  readonly realRoot: string;
}

export class TheaterRootError extends Error {
  readonly code: "invalid_path" | "not_found" | "forbidden";

  constructor(code: TheaterRootError["code"]) {
    super(code);
    this.code = code;
  }
}

export async function resolveTheaterRoot(theaterRoot: string): Promise<TheaterRootResolution> {
  const nominalRoot = path.resolve(theaterRoot);
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(nominalRoot);
  } catch (error) {
    throw mapFsError(error);
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(realRoot);
  } catch (error) {
    throw mapFsError(error);
  }
  if (!stat.isDirectory()) throw new TheaterRootError("invalid_path");
  return { realRoot };
}

function mapFsError(error: unknown): TheaterRootError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return new TheaterRootError("not_found");
  if (code === "EACCES" || code === "EPERM") return new TheaterRootError("forbidden");
  return new TheaterRootError("invalid_path");
}
