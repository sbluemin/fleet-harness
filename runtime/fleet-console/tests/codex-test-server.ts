import { dirname, join } from "node:path";

import { ensureWorkspaceDirectory } from "@fleet-console/infra";

import { createConsoleServer } from "../core/host/bootstrap/server.js";

interface StartCodexTestServerOptions {
  readonly cwd: string;
  readonly lockPath: string;
  readonly port?: number;
  readonly host?: string;
}

export interface CodexTestServer {
  address(): { port: number };
  close(callback?: () => void): void;
  /** 폴더를 소유할 사령관을 명시 생성하고 그 위키를 연다. */
  registerWorkspace(cwd: string): Promise<string>;
  /** 그 사령관의 위키 root — `commodore/{uuid}/knowledge`. */
  knowledgeRoot(commodoreId: string): Promise<string>;
}

/**
 * 사령관 이전 시절 위키 자리(`workspaces/<cwd 키>/knowledge`). 픽스처는 여기에 시드하고, Console이 그 맥락의 사령관
 * 지식으로 옮긴 결과를 읽는다 — 시드가 이주 경로를 거친다.
 */
export function legacyKnowledgeRoot(cwd: string, lockDir: string): string {
  return join(ensureWorkspaceDirectory(join(lockDir, "fleet-data", "console"), cwd).path, "knowledge");
}

export async function startCodexTestServer(options: StartCodexTestServerOptions): Promise<CodexTestServer> {
  const lockDir = dirname(options.lockPath);
  const server = createConsoleServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    version: "0.0.0",
    dataDir: join(lockDir, "fleet-data"),
  });
  const endpoint = await server.start({
    dir: lockDir,
    lockFile: options.lockPath,
  });
  const port = Number(new URL(endpoint).port);

  const fixtureOwners = new Map<string, string>();
  const registerWorkspace = async (cwd: string): Promise<string> => {
    const origin = `http://127.0.0.1:${port}`;
    const post = async (route: string, body: unknown) => {
      const response = await fetch(`${origin}/api/v1/${route}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
      const value = await response.json();
      if (!response.ok) throw new Error(`${route}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    };
    let commodoreId = fixtureOwners.get(cwd);
    if (!commodoreId) {
      commodoreId = (await post("commodore/create", { alias: "Wiki fixture" })).commodoreId as string;
      const grant = await post("theaters/folder-grants", { path: cwd });
      await post("commodore/theaters/add", { commodoreId, folderGrantId: grant.folderGrantId });
      fixtureOwners.set(cwd, commodoreId);
    }
    await post("codex/workspace", { commodoreId });
    return commodoreId;
  };
  const knowledgeRoot = async (commodoreId: string): Promise<string> => {
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/api/v1/codex/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ commodoreId }),
    });
    const { id } = await response.json() as { readonly id: string };
    return join(lockDir, "fleet-data", "console", "commodore", id, "knowledge");
  };

  await registerWorkspace(options.cwd);

  return {
    address: () => ({ port }),
    close: (callback) => {
      void server.stop().then(() => callback?.());
    },
    registerWorkspace,
    knowledgeRoot,
  };
}
