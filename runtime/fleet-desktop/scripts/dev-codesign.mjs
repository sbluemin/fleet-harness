import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 개발 실행(Fleet Console Dev와 개발 헬퍼)의 서명 ID를 고르는 환경 변수. 해시나 이름을 받고, "-"이면 adhoc을 강제한다. */
export const DEV_CODESIGN_IDENTITY_ENV = "FLEET_DEV_CODESIGN_IDENTITY";

const ADHOC = { identity: "-", label: "ad hoc" };

/** `security find-identity -v -p codesigning` 출력에서 유효한 코드 서명 ID(해시·이름)를 읽는다. */
export function parseCodesignIdentities(output) {
  return [...String(output).matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map(([, hash, name]) => ({ hash, name }));
}

/**
 * 개발 실행의 서명 ID를 고른다: 환경 변수 → 유효한 Apple Development ID → adhoc.
 * 팀 ID가 있는 서명이어야 macOS가 화면 기록 요청 창을 띄우고 목록에 올리며(adhoc은 창도 목록 등록도 없었다, macOS 26.5 실측),
 * TCC 허용이 cdhash가 아니라 팀·식별자에 묶여 Electron이 바뀌어도 유지된다.
 */
export function selectDevCodesignIdentity(identities, requested) {
  if (requested === "-") return { ...ADHOC, reason: "requested" };
  if (requested) {
    const match = identities.find((entry) => entry.hash === requested.toUpperCase() || entry.name === requested);
    return match ? { identity: match.hash, label: match.name, reason: "requested" } : { ...ADHOC, reason: "requested_identity_missing" };
  }
  const development = identities.filter((entry) => entry.name.startsWith("Apple Development:"));
  if (!development.length) return { ...ADHOC, reason: "none" };
  return { identity: development[0].hash, label: development[0].name, reason: development.length > 1 ? "first_of_many" : "found" };
}

export async function resolveDevCodesignIdentity(env = process.env, run = execFileAsync) {
  const requested = env[DEV_CODESIGN_IDENTITY_ENV]?.trim() || undefined;
  if (requested === "-") return selectDevCodesignIdentity([], requested);
  let identities = [];
  try { identities = parseCodesignIdentities((await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"])).stdout); } catch { identities = []; }
  return selectDevCodesignIdentity(identities, requested);
}

/** 개발자에게 보여 줄 한 줄. adhoc이면 macOS가 화면 기록을 묻지 않으니 + 로 추가해야 한다고 알린다. */
export function describeDevCodesignIdentity(subject, choice, failed = false, advice = true) {
  const tail = advice ? " macOS will not ask for Screen Recording, so add the app with + in System Settings › Privacy & Security." : "";
  if (failed) return `${subject}: signing with "${choice.label}" failed; using an ad hoc signature.${tail}`;
  if (choice.identity !== "-") return `${subject}: signed with "${choice.label}"${choice.reason === "first_of_many" ? ` (set ${DEV_CODESIGN_IDENTITY_ENV} to choose another identity)` : ""}.`;
  const why = choice.reason === "requested" ? `${DEV_CODESIGN_IDENTITY_ENV}=-` : choice.reason === "requested_identity_missing" ? `${DEV_CODESIGN_IDENTITY_ENV} names no valid code signing identity` : "no Apple Development signing identity was found";
  return `${subject}: using an ad hoc signature because ${why}.${tail}`;
}

/** 고른 ID로 서명하고, 실패하면 adhoc으로 다시 서명한다. 실제로 쓴 ID를 돌려준다. */
export async function codesignWithFallback(subject, choice, sign, log, { advice = true } = {}) {
  if (choice.identity !== "-") {
    try {
      await sign(choice.identity);
      log(describeDevCodesignIdentity(subject, choice, false, advice));
      return choice.identity;
    } catch {
      await sign("-");
      log(describeDevCodesignIdentity(subject, choice, true, advice));
      return ADHOC.identity;
    }
  }
  await sign("-");
  log(describeDevCodesignIdentity(subject, choice, false, advice));
  return ADHOC.identity;
}
