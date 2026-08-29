import { dirname, join } from "node:path";

import { createConsoleServer } from "../core/host/server.js";

interface StartCodexTestServerOptions {
  readonly cwd: string;
  readonly lockPath: string;
  readonly port?: number;
  readonly host?: string;
}

export interface CodexTestServer {
  address(): { port: number };
  close(callback?: () => void): void;
  registerWorkspace(cwd: string): Promise<string>;
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

  // Theater 등록은 폴더 grant를 먼저 받는다 — 경로만 실어 보내면 조용히 거절되고,
  // 워크스페이스가 없는 채로 테스트가 시작된다.
  const registerTheater = async (cwd: string): Promise<string> => {
    const origin = `http://127.0.0.1:${port}`;
    const grantResponse = await fetch(`${origin}/api/v1/theaters/folder-grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ path: cwd }),
    });
    const grant = await grantResponse.json() as { readonly id?: string; readonly folderGrantId?: string };
    const response = await fetch(`${origin}/api/v1/theaters`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ folderGrantId: grant.id ?? grant.folderGrantId }),
    });
    const body = await response.json() as { readonly theater?: { readonly id?: string } };
    if (body.theater?.id) return body.theater.id;
    // 이미 등록된 Theater는 생성이 아니라 조회로 답한다 — 같은 경로를 두 번 등록해도
    // 호출자는 같은 id를 받아야 한다.
    const listed = await fetch(`${origin}/api/v1/theaters`, { headers: { Origin: origin } });
    const theaters = await listed.json() as { readonly theaters?: readonly { readonly id: string; readonly label: string }[] };
    const wanted = cwd.split("/").filter(Boolean).at(-1);
    return theaters.theaters?.find((theater) => theater.label === wanted)?.id ?? "";
  };

  // 예전 codexCwd는 콘솔이 기본 워크스페이스를 하나 들고 뜨게 했다. Codex가 플러그인이 된
  // 뒤로 그 진입점은 없고, 워크스페이스는 Theater 등록의 결과다 — 픽스처가 그 Theater를 만든다.
  await registerTheater(options.cwd);

  return {
    address: () => ({ port }),
    close: (callback) => {
      void server.stop().then(() => callback?.());
    },
    /**
     * 워크스페이스 등록은 이제 Theater 등록의 결과다 — Codex 플러그인이 생명주기
     * 이벤트를 듣고 스스로 연다. 콘솔에 Codex 전용 진입점은 더 이상 없다.
     */
    registerWorkspace: registerTheater,
  };
}
