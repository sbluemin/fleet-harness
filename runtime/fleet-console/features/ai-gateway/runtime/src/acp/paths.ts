import path from "node:path";

/**
 * Fleet이 `agy`에게 내주는 세션 전용 상태 위치.
 *
 * 사람의 `~/.gemini`(와 그 아래 `antigravity-cli`)는 건드리지 않는다. agy는 `--app-data-dir`로 **절대경로를
 * 거부**하고 `--gemini-dir` 아래의 상대 이름만 받는다(agy 1.5.9 실측). 그래서 세션마다 gemini-dir를 따로 두고
 * (`<sessionsDir>/<key>`) 그 아래 이름 하나(`fleet-agy`)를 app-data-dir로 쓴다. 세션이 서로의 설정
 * (`config/plugins.json`)을 덮지 못하게 하려는 분리이기도 하다.
 *
 * 구독 로그인은 gemini-dir가 아니라 사용자 계정 저장소(키체인 등)에 있다 — 새 gemini-dir여도 로그인은 유지된다.
 * 그래서 `agy acp` 자식은 실제 HOME으로 띄운다. HOME까지 옮기면 로그인을 못 찾는다(-32000 Authentication required).
 *
 * 이 패키지는 데이터 루트를 스스로 찾지 않는다 — 호스트가 Fleet 데이터 루트 아래의 절대경로를 넘긴다.
 */
export interface AgyAcpPaths {
  /** `agy acp --gemini-dir`. 이 세션의 설정(`config/`)과 app-data-dir가 이 아래에 산다. */
  readonly geminiDir: string;
  /** `agy acp --app-data-dir`. `geminiDir` 아래의 상대 이름이다. */
  readonly appDataDirName: string;
}

export const AGY_ACP_APP_DATA_DIR_NAME = "fleet-agy";

const SESSION_KEY = /^[A-Za-z0-9._-]+$/;

export function resolveAgySessionPaths(sessionsDir: string, sessionKey: string): AgyAcpPaths {
  if (!path.isAbsolute(sessionsDir)) {
    throw new Error(`agy ACP sessions directory must be an absolute path, received: ${sessionsDir}`);
  }
  if (!SESSION_KEY.test(sessionKey) || sessionKey === "." || sessionKey === ".." || sessionKey.startsWith(".")) {
    throw new Error(`Invalid agy ACP session key: ${sessionKey}`);
  }
  return { geminiDir: path.join(sessionsDir, sessionKey), appDataDirName: AGY_ACP_APP_DATA_DIR_NAME };
}

/** `agy acp`가 Fleet 전용 위치를 쓰도록 하는 인자. */
export function agyAcpStateArgs(paths: AgyAcpPaths): readonly string[] {
  return ["--gemini-dir", paths.geminiDir, "--app-data-dir", paths.appDataDirName];
}
