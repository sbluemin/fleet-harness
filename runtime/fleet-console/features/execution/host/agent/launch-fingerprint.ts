import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 세션이 시작할 때 실제로 실은 실행 구성의 지문 — 서버 전용이다.
 *
 * 한 세션에 한 번, 시작하는 순간에만 찍는다. 같은 살아 있는 세션에 새 Console 이 붙어도 다시 찍지 않는다 —
 * 다시 찍으면 그 세션이 업데이트 전 구성으로 돈다는 사실이 지워진다. 비교 대상은 **같은 시작 의도로 지금
 * 시작했을 때의 기대 구성**이므로, 서로 다른 세션의 원래 설정 차이를 업데이트로 오인하지 않는다.
 *
 * 브라우저에는 판정(`current | previous | unknown`)과 이전 release 표기만 나간다. 지문 원문·프롬프트 본문·
 * 경로·provider 신원은 이 모듈 밖으로 투영하지 않는다. 세션 호스트(미션 7)는 이 값을 불투명한 레코드로 받아
 * 동결·보관하고, 다시 붙을 때 `readLaunchFingerprint` 로 검증해 돌려준다.
 */
export const LAUNCH_FINGERPRINT_SCHEMA = 1;

export type LaunchSurface = "pty" | "chat";

/** 기대 구성을 다시 계산할 때 쓰는 시작 의도. 같은 의도끼리만 비교한다. */
export interface LaunchIntent {
  readonly surface: LaunchSurface;
  /** Theater 프롬프트 설정을 고르는 키. Theater 밖에서 띄운 세션은 null. */
  readonly theaterId: string | null;
  readonly subagentsBlocked: boolean;
  readonly autoMemoryDisabled: boolean;
}

export interface LaunchFingerprint {
  readonly schema: typeof LAUNCH_FINGERPRINT_SCHEMA;
  readonly intent: LaunchIntent;
  /** 시작한 Console release(package version). 브라우저에는 이전일 때만 이 값이 표기로 나간다. */
  readonly consoleVersion: string;
  /** 실제 실행 코드의 정체 — 같은 version 의 dev 빌드 변경도 가른다. */
  readonly executionBuildId: string;
  /** 시스템 프롬프트 모드·본문, 빼는 도구·서브에이전트·auto-memory 정책의 해시. 본문은 싣지 않는다. */
  readonly effectivePromptHash: string;
  /** 노출된 Fleet 도구의 이름·설명·입력 스키마·지침 해시. 순서는 정규화하고 설명 차이는 버리지 않는다. */
  readonly toolsetHash: string;
  /** hook 실행 계약(엔트리·실행 파일)과 빌드에 묶인 hook/mod 자산의 해시. */
  readonly hookModAssetsHash: string;
  readonly capturedAt: string;
  /** 위 구성 요소 전체의 해시. 비교는 구성 요소별로 하고, 이 값은 동일성 빠른 확인과 기록용이다. */
  readonly digest: string;
}

export type LaunchConfigurationState = "current" | "previous" | "unknown";

/** 브라우저 DTO 몫. 이 두 값 밖의 지문 정보는 나가지 않는다. */
export interface LaunchConfigurationProjection {
  readonly state: LaunchConfigurationState;
  /** 시작한 release 가 지금과 다를 때만 그 version. */
  readonly release?: string;
}

/** 지문에 실리는 도구의 계약 몫 — 실행 함수는 해시 대상이 아니다. */
export interface LaunchToolContract {
  readonly id: string;
  readonly tag: string;
  readonly title: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly whenToUse: readonly string[];
  readonly whenNotToUse: readonly string[];
  readonly usageGuidelines: readonly string[];
  readonly guardrails?: readonly string[];
  readonly parameters: unknown;
}

export interface LaunchConfigurationDeps {
  readonly consoleVersion: string;
  /** 생략하면 이 모듈이 실린 실행 파일(배포에서는 Console 번들)의 내용 해시를 한 번 읽는다. */
  readonly executionBuildId?: () => string;
  readonly readTheaterPrompt: (theaterId: string) => { readonly mode: string; readonly body: string } | null;
  readonly listTools: () => readonly LaunchToolContract[];
  /** hook 명령이 가리키는 실행 계약. 경로는 해시에만 들어가고 밖으로 나가지 않는다. */
  readonly hookEntry: { readonly entryPath: string; readonly execPath: string; readonly tsxLoaderPath?: string };
  readonly disabledTools: readonly string[];
  readonly now?: () => number;
  /** 기대 구성 캐시의 수명. 도구 등록처럼 알림이 없는 변화도 이 안에 따라온다. */
  readonly expectedTtlMs?: number;
}

export interface LaunchConfiguration {
  /** 시작 순간의 지문. 세션을 세우는 실행 경로가 한 번 부른다. */
  capture(intent: LaunchIntent): LaunchFingerprint;
  /** 보관한 지문을 지금의 기대 구성과 비교한 브라우저 몫. 지문이 없거나 읽을 수 없으면 unknown. */
  describe(fingerprint: LaunchFingerprint | null | undefined): LaunchConfigurationProjection;
  /** Theater 프롬프트처럼 알림이 있는 설정이 바뀌었다 — 다음 판정이 기대 구성을 다시 계산한다. */
  invalidate(): void;
}

const DEFAULT_EXPECTED_TTL_MS = 5_000;

export function createLaunchConfiguration(deps: LaunchConfigurationDeps): LaunchConfiguration {
  const now = deps.now ?? Date.now;
  const ttl = deps.expectedTtlMs ?? DEFAULT_EXPECTED_TTL_MS;
  const buildId = deps.executionBuildId ?? readExecutionBuildId;
  const expected = new Map<string, { readonly at: number; readonly fingerprint: LaunchFingerprint }>();

  function compute(intent: LaunchIntent): LaunchFingerprint {
    const executionBuildId = buildId();
    const prompt = intent.theaterId ? deps.readTheaterPrompt(intent.theaterId) : null;
    const effectivePromptHash = sha256(canonicalJson({
      surface: intent.surface,
      prompt: prompt ? { mode: prompt.mode, body: prompt.body } : null,
      disabledTools: [...deps.disabledTools].sort(),
      subagentsBlocked: intent.subagentsBlocked,
      autoMemoryDisabled: intent.autoMemoryDisabled,
    }));
    const toolsetHash = sha256(canonicalJson([...deps.listTools()]
      .map((tool) => ({
        id: tool.id,
        tag: tool.tag,
        title: tool.title,
        description: tool.description,
        promptSnippet: tool.promptSnippet,
        whenToUse: tool.whenToUse,
        whenNotToUse: tool.whenNotToUse,
        usageGuidelines: tool.usageGuidelines,
        guardrails: tool.guardrails ?? [],
        parameters: tool.parameters ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))));
    // hook·mod 자산은 기동 때 이 빌드에서 렌더된다 — 실행 계약(엔트리·실행 파일)과 빌드를 함께 묶는다.
    const hookModAssetsHash = sha256(canonicalJson({
      entryPath: deps.hookEntry.entryPath,
      execPath: deps.hookEntry.execPath,
      tsxLoaderPath: deps.hookEntry.tsxLoaderPath ?? null,
      executionBuildId,
    }));
    const components = {
      schema: LAUNCH_FINGERPRINT_SCHEMA,
      intent: { ...intent },
      consoleVersion: deps.consoleVersion,
      executionBuildId,
      effectivePromptHash,
      toolsetHash,
      hookModAssetsHash,
    } as const;
    return { ...components, capturedAt: new Date(now()).toISOString(), digest: sha256(canonicalJson(components)) };
  }

  function expectedFor(intent: LaunchIntent): LaunchFingerprint {
    const key = canonicalJson(intent);
    const cached = expected.get(key);
    if (cached && now() - cached.at < ttl) return cached.fingerprint;
    const fingerprint = compute(intent);
    expected.set(key, { at: now(), fingerprint });
    return fingerprint;
  }

  return {
    capture(intent) {
      const fingerprint = compute(intent);
      expected.set(canonicalJson(intent), { at: now(), fingerprint });
      return fingerprint;
    },
    describe(fingerprint) {
      if (!fingerprint) return { state: "unknown" };
      let current: LaunchFingerprint;
      try {
        current = expectedFor(fingerprint.intent);
      } catch {
        // 기대 구성을 읽지 못하면 최신이라 단정하지 않는다.
        return { state: "unknown" };
      }
      if (fingerprint.digest === current.digest) return { state: "current" };
      const differs = fingerprint.consoleVersion !== current.consoleVersion
        || fingerprint.executionBuildId !== current.executionBuildId
        || fingerprint.effectivePromptHash !== current.effectivePromptHash
        || fingerprint.toolsetHash !== current.toolsetHash
        || fingerprint.hookModAssetsHash !== current.hookModAssetsHash;
      if (!differs) return { state: "current" };
      return {
        state: "previous",
        ...(fingerprint.consoleVersion && fingerprint.consoleVersion !== current.consoleVersion ? { release: fingerprint.consoleVersion } : {}),
      };
    },
    invalidate() {
      expected.clear();
    },
  };
}

/**
 * 세션 호스트가 불투명하게 보관했다 돌려준 값을 지문으로 읽는다. 모양이 맞지 않거나 다른 schema 면 null —
 * 판정은 unknown 이 되고, 최신으로 단정하지도 이전으로 단정하지도 않는다.
 */
export function readLaunchFingerprint(value: unknown): LaunchFingerprint | null {
  if (!isRecord(value) || value.schema !== LAUNCH_FINGERPRINT_SCHEMA) return null;
  const intent = value.intent;
  if (!isRecord(intent)) return null;
  if (intent.surface !== "pty" && intent.surface !== "chat") return null;
  if (intent.theaterId !== null && typeof intent.theaterId !== "string") return null;
  if (typeof intent.subagentsBlocked !== "boolean" || typeof intent.autoMemoryDisabled !== "boolean") return null;
  const strings = ["consoleVersion", "executionBuildId", "effectivePromptHash", "toolsetHash", "hookModAssetsHash", "capturedAt", "digest"] as const;
  for (const key of strings) if (typeof value[key] !== "string") return null;
  return {
    schema: LAUNCH_FINGERPRINT_SCHEMA,
    intent: { surface: intent.surface, theaterId: intent.theaterId, subagentsBlocked: intent.subagentsBlocked, autoMemoryDisabled: intent.autoMemoryDisabled },
    consoleVersion: value.consoleVersion as string,
    executionBuildId: value.executionBuildId as string,
    effectivePromptHash: value.effectivePromptHash as string,
    toolsetHash: value.toolsetHash as string,
    hookModAssetsHash: value.hookModAssetsHash as string,
    capturedAt: value.capturedAt as string,
    digest: value.digest as string,
  };
}

/**
 * 호출자가 프롬프트·도구를 직접 쥐고 여는 상주 세션(사령관 등)의 시작 구성. Operation 이 아니라 Theater 프롬프트·Fleet 도구 목록으로
 * 기대 구성을 되짓지 못하므로, 지금의 구성은 부른 쪽이 같은 모양으로 다시 넘긴다. 직렬화할 수 있는 값만 싣는다.
 */
export interface ResidentSessionSetup {
  /** 시스템 프롬프트 본문·정책처럼 실제로 실은 입력. 해시에만 들어가고 밖으로 나가지 않는다. */
  readonly prompt: unknown;
  readonly tools: readonly { readonly group?: string; readonly name: string; readonly description: string; readonly inputSchema?: unknown }[];
}

/**
 * 상주 세션 지문의 생성·판정 포트. 지문은 불투명한 레코드로 다룬다 — 보관하는 쪽(사령관 감독자·세션 호스트)은 키를 해석하지 않고,
 * 판정은 이 모듈이 그 레코드를 다시 읽어 한다. 읽을 수 없으면 unknown.
 */
export interface ResidentSessionFingerprints {
  capture(setup: ResidentSessionSetup): Readonly<Record<string, unknown>>;
  describe(started: unknown, current: ResidentSessionSetup): LaunchConfigurationProjection;
}

export function createResidentSessionFingerprints(deps: { readonly consoleVersion: string; readonly executionBuildId?: () => string; readonly now?: () => number }): ResidentSessionFingerprints {
  const now = deps.now ?? Date.now;
  const buildId = deps.executionBuildId ?? readExecutionBuildId;
  const components = (setup: ResidentSessionSetup) => ({
    schema: LAUNCH_FINGERPRINT_SCHEMA,
    kind: "resident" as const,
    consoleVersion: deps.consoleVersion,
    executionBuildId: buildId(),
    effectivePromptHash: sha256(canonicalJson(setup.prompt ?? null)),
    toolsetHash: sha256(canonicalJson([...setup.tools]
      .map((tool) => ({ group: tool.group ?? null, name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? null }))
      .sort((a, b) => {
        const left = `${a.group ?? ""}\u0000${a.name}`;
        const right = `${b.group ?? ""}\u0000${b.name}`;
        return left < right ? -1 : left > right ? 1 : 0;
      }))),
  });
  return {
    capture(setup) {
      const parts = components(setup);
      return { ...parts, capturedAt: new Date(now()).toISOString(), digest: sha256(canonicalJson(parts)) };
    },
    describe(started, current) {
      if (!isRecord(started) || started.schema !== LAUNCH_FINGERPRINT_SCHEMA || started.kind !== "resident") return { state: "unknown" };
      const keys = ["consoleVersion", "executionBuildId", "effectivePromptHash", "toolsetHash", "digest"] as const;
      if (keys.some((key) => typeof started[key] !== "string")) return { state: "unknown" };
      let parts: ReturnType<typeof components>;
      try {
        parts = components(current);
      } catch {
        return { state: "unknown" };
      }
      if (started.digest === sha256(canonicalJson(parts))) return { state: "current" };
      return {
        state: "previous",
        ...(started.consoleVersion && started.consoleVersion !== parts.consoleVersion ? { release: started.consoleVersion as string } : {}),
      };
    },
  };
}

let cachedBuildId: string | undefined;

/**
 * 이 모듈이 실린 파일의 내용 해시. 배포 번들은 entry 마다 한 파일(splitting 없음)이라 실행 코드 전체를 가리킨다.
 * 소스 실행(dev)에서는 이 파일만 가리키므로 다른 소스 변경은 version 이 같으면 구분하지 못한다.
 */
function readExecutionBuildId(): string {
  if (cachedBuildId !== undefined) return cachedBuildId;
  try {
    cachedBuildId = sha256(fs.readFileSync(fileURLToPath(import.meta.url)));
  } catch {
    cachedBuildId = "unreadable";
  }
  return cachedBuildId;
}

function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** 키 순서를 고정한 직렬화 — 같은 값은 늘 같은 문자열이 된다. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
