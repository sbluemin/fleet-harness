import { execFile } from "node:child_process";
import { userInfo } from "node:os";
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
 * 팀 서명은 지정 요구 조건이 식별자와 인증서에 묶여 TCC 허용이 Electron 갱신 뒤에도 유지된다. adhoc으로 물러나면 래퍼는
 * 식별자 고정 요구 조건으로 서명한다(designatedRequirementArgs).
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

/**
 * 키체인 검색 목록과 신뢰 설정은 HOME을 따른다. HOME을 바꿔 띄운 개발 실행(격리 시험 등)에서는 로그인 키체인과 중간 인증서가 빠져
 * 서명 ID가 무효로 보이므로, security·codesign만 계정 홈으로 돌려 실행한다.
 */
export function signingEnv(env = process.env, account = userInfo().homedir) {
  return env.HOME === undefined || env.HOME === account ? env : { ...env, HOME: account };
}

export async function resolveDevCodesignIdentity(env = process.env, run = execFileAsync) {
  const requested = env[DEV_CODESIGN_IDENTITY_ENV]?.trim() || undefined;
  if (requested === "-") return selectDevCodesignIdentity([], requested);
  let identities = [];
  try { identities = parseCodesignIdentities((await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { env: signingEnv(env) })).stdout); } catch { identities = []; }
  return selectDevCodesignIdentity(identities, requested);
}

/**
 * adhoc 래퍼에 넣는 지정 요구 조건. 기본(암묵) 요구 조건은 cdhash라 Electron 갱신이나 래퍼 재생성 때 TCC 허용이 무효가 되고,
 * 시스템 설정 목록에는 켜짐으로 남는다. 식별자로 고정하면 재빌드 뒤에도 허용이 남는다(macOS 26.5 실측). 대가로 같은 Mac에서
 * 같은 식별자로 adhoc 서명한 다른 코드도 이 조건을 만족하므로, 인증서 서명이 없을 때만 쓴다.
 */
export function adhocDesignatedRequirement(identifier) {
  return `designated => identifier "${identifier}"`;
}

/** codesign에 더할 지정 요구 조건 인자. adhoc이고 고정할 식별자가 있을 때만 넣는다. 팀 서명은 기본 요구 조건이 이미 고정돼 있다. */
export function designatedRequirementArgs(identity, identifier) {
  return identity === ADHOC.identity && identifier ? [`-r=${adhocDesignatedRequirement(identifier)}`] : [];
}

/** `codesign -d -r-` 출력에 식별자 고정 요구 조건이 명시돼 있는가. 암묵 요구 조건은 "# designated => cdhash …"로 나온다. */
export function hasFixedDesignatedRequirement(output, identifier) {
  return String(output).split("\n").some((line) => line.trim() === adhocDesignatedRequirement(identifier));
}

/**
 * 개발자에게 보여 줄 한 줄. 서명 결과와 사유 뒤에, adhoc이면 재빌드 뒤 허용이 켜짐인데도 거부될 때 할 일을 붙인다.
 * "fixed to bundle ID"는 실제로 식별자 고정 요구 조건을 넣은 서명에만 적는다.
 */
export function describeDevCodesignIdentity(subject, choice, failed = false, advice = true, fixedRequirement = false) {
  const tail = advice ? " If Screen Recording shows Fleet Console Dev as enabled but access is denied after a rebuild, remove its entry with −, request access again in Fleet, and enable it when listed." : "";
  const adhoc = fixedRequirement ? "an ad hoc signature (fixed to bundle ID)" : "an ad hoc signature";
  if (failed) return `${subject}: signing with "${choice.label}" failed; using ${adhoc}.${tail}`;
  if (choice.identity !== "-") return `${subject}: signed with "${choice.label}"${choice.reason === "first_of_many" ? ` (set ${DEV_CODESIGN_IDENTITY_ENV} to choose another identity)` : ""}.`;
  const why = choice.reason === "requested" ? `${DEV_CODESIGN_IDENTITY_ENV}=-` : choice.reason === "requested_identity_missing" ? `${DEV_CODESIGN_IDENTITY_ENV} names no valid code signing identity` : "no Apple Development signing identity was found";
  return `${subject}: using ${adhoc} because ${why}.${tail}`;
}

/** 고른 ID로 서명하고, 실패하면 adhoc으로 다시 서명한다. 실제로 쓴 ID를 돌려준다. */
export async function codesignWithFallback(subject, choice, sign, log, { advice = true, fixedRequirement = false } = {}) {
  if (choice.identity !== "-") {
    try {
      await sign(choice.identity);
      log(describeDevCodesignIdentity(subject, choice, false, advice, fixedRequirement));
      return choice.identity;
    } catch {
      await sign("-");
      log(describeDevCodesignIdentity(subject, choice, true, advice, fixedRequirement));
      return ADHOC.identity;
    }
  }
  await sign("-");
  log(describeDevCodesignIdentity(subject, choice, false, advice, fixedRequirement));
  return ADHOC.identity;
}
