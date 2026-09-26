import { randomUUID } from "node:crypto";
import http from "node:http";

import { strToU8, zipSync } from "fflate";

import { FLEET_HARNESS_VERSION } from "../assets.generated.js";
import { assetBundle, buildAssetPluginFiles, type AssetPluginFile } from "./fleet.js";
import type { AgentCliPlugin, AgentCliPluginHttpMount, CreateAgentCliPluginOptions } from "../types.js";

export type {
  AgentCliPlugin,
  AgentCliPluginHttpMount,
  CreateAgentCliPluginOptions,
} from "../types.js";

/**
 * zip 항목에 박는 수정 시각. 렌더가 같으면 바이트도 같아야 한다 — 시계를 싣지 않는다.
 * zip의 DOS 시각은 1980년부터라 그 이전 값은 담기지 않는다.
 */
const ARCHIVE_ENTRY_MTIME = new Date("1980-01-01T00:00:00Z");
const ARCHIVE_FILE_NAME = "fleet.zip";

/**
 * 모든 Claude 세션이 실을 Fleet 플러그인을 **한 번** zip으로 묶어 루프백으로 내준다.
 *
 * 호스트는 기동에 이것을 한 번 부르고, 런치마다 `url()`을 `--plugin-url`로 넘긴다. 디스크에는
 * 아무것도 쓰지 않는다 — 자식이 세션마다 받아 자기 임시 자리에 풀고, 세션이 끝나면 스스로 걷는다.
 * 그래서 세션끼리, 그리고 같은 슬롯을 쓰는 두 호스트(Console과 `fleet` 런처)끼리 트리를 덮어쓸
 * 자리가 없다. 공유 트리 시절에는 한쪽의 재렌더가 다른 쪽 세션의 훅을 조용히 갈아치웠다.
 *
 * 내주는 자리는 호스트가 고른다. `transport`가 있으면 호스트 리스너의 불투명 경로에 얹고(Console),
 * 없으면 이 함수가 127.0.0.1에 자기 리스너를 연다(`fleet` 런처). 어느 쪽이든 주소가 곧 자격이다 —
 * 경로의 UUID를 모르면 내용을 받을 수 없다. zip에는 이 설치의 절대 경로(훅 실행 파일)가 실리므로
 * 브라우저 요청(Origin 헤더)은 받지 않는다.
 */
export function createAgentCliPlugin(options: CreateAgentCliPluginOptions): AgentCliPlugin {
  const archive = packAgentCliPluginArchive(buildAssetPluginFiles(assetBundle, options, FLEET_HARNESS_VERSION));
  const handler = createArchiveHandler(archive);
  if (options.transport) {
    const mounted = options.transport.mount(handler);
    return {
      url: () => mounted.url(),
      close: async () => mounted.dispose(),
    };
  }
  return serveOnOwnLoopback(handler);
}

/** 파일 목록을 결정적인 zip 한 벌로 묶는다. 같은 렌더는 같은 바이트다. */
function packAgentCliPluginArchive(files: readonly AssetPluginFile[]): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const file of files) {
    entries[file.relativePath] = [strToU8(file.content), { mtime: ARCHIVE_ENTRY_MTIME }];
  }
  return zipSync(entries, { level: 6 });
}

type ArchiveHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function createArchiveHandler(archive: Uint8Array): ArchiveHandler {
  const body = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  return (req, res) => {
    // Claude Code의 fetch는 Origin을 싣지 않는다. 브라우저가 이 주소를 알아내더라도 읽지 못하게 한다.
    if (req.headers.origin !== undefined || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "cache-control": "no-store",
      "content-length": String(body.byteLength),
      "content-type": "application/zip",
      "x-content-type-options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

/**
 * 호스트 리스너가 없는 쪽(`fleet` 런처)을 위한 자기 리스너. 첫 `url()`에서 연다.
 *
 * 경로는 UUID를 품은 한 자리뿐이고, Host 헤더는 이 리스너의 주소와 정확히 같아야 한다 —
 * 다른 이름으로 들어온 요청(DNS rebinding)은 루프백에 닿았더라도 받지 않는다.
 */
function serveOnOwnLoopback(handler: ArchiveHandler): AgentCliPlugin {
  const archivePath = `/${randomUUID()}/${ARCHIVE_FILE_NAME}`;
  let server: http.Server | null = null;
  let starting: Promise<string> | null = null;
  let closed = false;
  const start = () => {
    starting ??= new Promise<string>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        const address = srv.address();
        const expectedHost = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : null;
        if (req.url !== archivePath || req.headers.host !== expectedHost) {
          res.writeHead(404);
          res.end();
          return;
        }
        handler(req, res);
      });
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const address = srv.address();
        if (!address || typeof address === "string") {
          reject(new Error("Fleet plugin listener bind failed"));
          return;
        }
        server = srv;
        resolve(`http://127.0.0.1:${address.port}${archivePath}`);
      });
    });
    return starting;
  };
  return {
    url: async () => {
      if (closed) throw new Error("Fleet plugin listener is closed");
      return start();
    },
    close: async () => {
      closed = true;
      if (starting) await starting.catch(() => undefined);
      const srv = server;
      server = null;
      if (!srv) return;
      await new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
      });
    },
  };
}
