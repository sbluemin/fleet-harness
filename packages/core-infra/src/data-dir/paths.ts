import * as os from "node:os";
import * as path from "node:path";

const FLEET_DATA_DIR_NAME = ".fleet";
const FLEET_DATA_DIR_ENV = "FLEET_DATA_DIR";

/**
 * Fleet 데이터 루트. `FLEET_DATA_DIR`은 이 루트를 통째로 옮기는 유일한 격리 스위치다 —
 * 자격 증명·전역 설정·AI Gateway 선별·워크스페이스가 모두 이 아래 살기 때문에, 개발
 * 실행을 실사용자 환경에서 떼어내려면 파일별 예외가 아니라 루트 하나가 움직여야 한다.
 *
 * 값은 반드시 절대경로이고, 아니면 던진다. 이 변수는 cwd가 제각각인 자식 프로세스로
 * 상속되므로(capture hook은 Theater 루트에서 돈다) 상대경로는 프로세스마다 다른 자리를
 * 가리킨다. 조용히 무시하면 더 나쁘다 — 격리를 요청한 실행이 격리되지 않은 채 사용자의
 * 진짜 `~/.fleet`을 읽고 덮어쓰게 되고, 그건 이 스위치가 막으려던 바로 그 사고다.
 */
export function getFleetDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[FLEET_DATA_DIR_ENV];
  if (override === undefined || override.trim().length === 0) return path.join(os.homedir(), FLEET_DATA_DIR_NAME);
  if (!path.isAbsolute(override)) throw new Error(`${FLEET_DATA_DIR_ENV} must be an absolute path, received: ${override}`);
  return override;
}
