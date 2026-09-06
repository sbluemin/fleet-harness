import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fail } from "./android-tools.mjs";

/**
 * App Store Connect API의 최소 클라이언트. Firebase CLI가 Android에서 하는 일 — 업로드된 빌드를
 * 테스터 그룹에 붙이고 릴리스 노트를 실어 보내는 것 — 을 iOS에서 하려면 altool만으로는 부족하다.
 * altool은 바이너리를 올릴 뿐 그룹·노트를 모르기 때문에, 그 두 가지는 이 REST API로만 가능하다.
 *
 * 의존성은 추가하지 않는다. 인증은 ES256 JWT 한 장이고 Node에 서명기와 fetch가 이미 있다.
 */
export const ASC_BASE_URL = "https://api.appstoreconnect.apple.com";
export const ASC_GROUPS_ENV = "FLEET_ASC_BETA_GROUPS";
export const WHATS_NEW_LOCALE = "en-US";
// Apple은 20분을 넘는 만료를 거부한다. 폴링이 길어져도 만료 전에 새로 발급하도록 짧게 잡는다.
export const TOKEN_LIFETIME_SECONDS = 900;
// 처리 대기 폴링은 30분을 넘게 이 API를 두드린다. 그 사이 러너와 Apple 사이의 연결이 한 번
// 끊기면(ConnectTimeoutError 등) 업로드가 이미 성공한 배포가 통째로 실패한다. 일시적 전송
// 오류와 Apple의 혼잡 응답은 재시도로 흡수하고, 영구적인 거절만 호출자에게 올린다.
export const RETRY_ATTEMPTS = 4;
export const RETRY_BASE_DELAY_MS = 2000;
// Apple이 Retry-After로 지정한 대기가 이보다 길면 재시도해도 백오프 안에서 같은 창에 갇힌다.
// 그때는 조용히 소진하는 대신 서버가 요구한 대기 시간을 담아 즉시 실패시킨다.
export const RETRY_AFTER_CAP_MS = 60_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** 재시도가 의미 있는 상태 코드인지. 4xx 인증·검증 실패는 다시 보내도 같은 답이 온다. */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status);
}

/** Retry-After는 초 또는 HTTP-date로 온다. 읽을 수 없으면 백오프만 쓰도록 undefined를 준다. */
export function parseRetryAfter(raw, nowMs = Date.now()) {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

export function parseGroupNames(raw) {
  return [...new Set(String(raw ?? "").split(",").map((name) => name.trim()).filter(Boolean))];
}

/** 토큰 본문. 팀 키(App Manager)는 sub 없이 iss/aud/exp만 요구한다. */
export function tokenClaims(keyId, issuerId, nowSeconds) {
  if (!keyId || !issuerId) fail("App Store Connect key id and issuer id are required to sign an API token");
  return {
    header: { alg: "ES256", kid: keyId, typ: "JWT" },
    payload: { iss: issuerId, iat: nowSeconds, exp: nowSeconds + TOKEN_LIFETIME_SECONDS, aud: "appstoreconnect-v1" },
  };
}

function base64Url(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodeToken({ keyId, issuerId, privateKeyPem, nowSeconds }) {
  const { header, payload } = tokenClaims(keyId, issuerId, nowSeconds);
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  // JOSE는 r||s 원시 서명을 요구한다. 기본 DER로 서명하면 Apple이 401로 되돌려 보낸다.
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** Apple의 오류 본문은 errors[]에 사람이 읽을 제목과 상세를 담는다. 그걸 잃지 않고 한 줄로 만든다. */
export function describeApiError(method, path, status, bodyText) {
  let detail = String(bodyText ?? "").trim();
  try {
    const parsed = JSON.parse(detail);
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      detail = parsed.errors.map((e) => [e.title, e.detail].filter(Boolean).join(": ")).join(" | ");
    }
  } catch {
    // JSON이 아니면 원문을 그대로 쓴다.
  }
  return `App Store Connect ${method} ${path} failed (${status})${detail ? `: ${detail.slice(0, 500)}` : ""}`;
}

/**
 * 업로드된 빌드는 CFBundleVersion(빌드 번호)과 마케팅 버전의 짝으로 식별한다. 같은 짝이 이미
 * 있으면 다시 올리지 않는다 — 재실행이 중복 업로드로 거절당하는 대신 배정 단계로 이어지게 하려는
 * 것이다(그룹 배정이 실패해 잡을 다시 돌리는 상황이 실제로 생긴다).
 */
export function pickBuild(builds, buildNumber) {
  return builds.find((entry) => entry?.attributes?.version === buildNumber) ?? null;
}

export function createAscClient({ keyId, issuerId, keyPath, fetchImpl = fetch, now = () => Date.now(), sleep = delay }) {
  const privateKeyPem = readFileSync(keyPath, "utf8");
  let cached = null;

  function token() {
    const nowSeconds = Math.floor(now() / 1000);
    if (!cached || cached.expiresAt - 60 <= nowSeconds) {
      cached = { value: encodeToken({ keyId, issuerId, privateKeyPem, nowSeconds }), expiresAt: nowSeconds + TOKEN_LIFETIME_SECONDS };
    }
    return cached.value;
  }

  async function send(method, path, body) {
    const response = await fetchImpl(`${ASC_BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return { status: 204, data: null };
    const text = await response.text();
    if (!response.ok) {
      // Apple이 얼마나 기다리라고 했는지는 여기서만 볼 수 있다 — 오류와 함께 위로 넘긴다.
      const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after"), now());
      return { status: response.status, error: describeApiError(method, path, response.status, text), retryAfterMs };
    }
    try {
      return { status: response.status, data: text ? JSON.parse(text) : null };
    } catch {
      return { status: response.status, error: describeApiError(method, path, response.status, text) };
    }
  }

  /**
   * 전송이 끊기거나 Apple이 혼잡을 알리면 지수 백오프로 다시 보낸다. 재시도가 소진되면 마지막
   * 결과를 그대로 돌려주므로, 호출자가 보는 성공/실패 모양은 달라지지 않는다. 이미 처리된 POST를
   * 다시 보낼 가능성은 남지만 생성 계열 호출은 모두 중복(409·이미 배정됨) 복구 경로를 갖고 있다.
   */
  async function request(method, path, body) {
    for (let attempt = 1; ; attempt += 1) {
      let result;
      try {
        result = await send(method, path, body);
      } catch (cause) {
        if (attempt >= RETRY_ATTEMPTS) {
          return { status: 0, error: `App Store Connect ${method} ${path} could not be reached: ${cause?.message ?? cause}` };
        }
        await backoff(method, path, attempt, cause?.message ?? String(cause));
        continue;
      }
      if (!result.error || !isRetryableStatus(result.status) || attempt >= RETRY_ATTEMPTS) return result;
      // 고정 백오프로 다시 보내면 Apple이 지정한 창 안에 그대로 갇힌다. 서버가 말한 대기가 더
      // 길면 그만큼 기다리고, 백오프로는 도저히 넘길 수 없는 창이면 재시도를 접는다.
      if (result.retryAfterMs !== undefined && result.retryAfterMs > RETRY_AFTER_CAP_MS) {
        return {
          ...result,
          error: `${result.error} — Apple asked to wait ${Math.round(result.retryAfterMs / 1000)}s, longer than this job retries`,
        };
      }
      await backoff(method, path, attempt, `HTTP ${result.status}`, result.retryAfterMs);
    }
  }

  async function backoff(method, path, attempt, reason, retryAfterMs) {
    const waitMs = Math.max(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), retryAfterMs ?? 0);
    process.stdout.write(
      `  ${method} ${path} failed (${reason}); retrying in ${Math.round(waitMs / 1000)}s ` +
        `(attempt ${attempt + 1}/${RETRY_ATTEMPTS})\n`,
    );
    await sleep(waitMs);
  }

  async function requireOk(method, path, body) {
    const result = await request(method, path, body);
    if (result.error) fail(result.error);
    return result.data;
  }

  return {
    async appId(bundleId) {
      const data = await requireOk("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
      const app = data?.data?.[0];
      if (!app) fail(`App Store Connect has no app record for ${bundleId} — create it before the first upload`);
      return app.id;
    },

    async findBuild(appId, versionName, buildNumber) {
      const path =
        `/v1/builds?filter[app]=${encodeURIComponent(appId)}` +
        `&filter[preReleaseVersion.version]=${encodeURIComponent(versionName)}` +
        `&filter[version]=${encodeURIComponent(buildNumber)}&limit=10`;
      const data = await requireOk("GET", path);
      return pickBuild(data?.data ?? [], buildNumber);
    },

    async resolveGroupIds(appId, names) {
      const data = await requireOk("GET", `/v1/betaGroups?filter[app]=${encodeURIComponent(appId)}&limit=200`);
      const groups = data?.data ?? [];
      return names.map((name) => {
        const match = groups.find((group) => group?.attributes?.name === name);
        if (!match) {
          const known = groups.map((group) => group?.attributes?.name).filter(Boolean).join(", ") || "none";
          fail(`TestFlight has no beta group named "${name}" for this app (groups: ${known})`);
        }
        // 외부 그룹은 배정만으로 끝나지 않는다 — Apple의 베타 심사를 통과해야 테스터에게 열린다.
        return { name, id: match.id, internal: match.attributes?.isInternalGroup !== false };
      });
    },

    /**
     * 외부 테스터에게 나가려면 빌드마다 베타 심사 제출이 필요하다. 이미 제출됐거나 심사를
     * 통과한 빌드는 Apple이 거절하는데, 그것도 우리가 원하던 상태이므로 실패로 보지 않는다.
     */
    async submitForBetaReview(buildId) {
      const created = await request("POST", "/v1/betaAppReviewSubmissions", {
        data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: buildId } } } },
      });
      if (!created.error) return "submitted for beta review";
      const existing = await request(
        "GET",
        `/v1/betaAppReviewSubmissions?filter[build]=${encodeURIComponent(buildId)}&limit=1`,
      );
      if (existing.error) fail(created.error);
      const state = existing.data?.data?.[0]?.attributes?.betaReviewState;
      if (!state) fail(created.error);
      return `already in beta review (${state})`;
    },

    async setWhatsNew(buildId, whatsNew) {
      const created = await request("POST", "/v1/betaBuildLocalizations", {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: WHATS_NEW_LOCALE, whatsNew },
          relationships: { build: { data: { type: "builds", id: buildId } } },
        },
      });
      if (!created.error) return "created";
      // 같은 로케일이 이미 있으면 Apple이 409로 막는다 — 재실행이거나 Apple이 기본 로케일을
      // 만들어 둔 경우다. 그때는 덮어써야 테스터가 이번 빌드의 노트를 본다.
      const existing = await requireOk(
        "GET",
        `/v1/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations?limit=50`,
      );
      const mine = (existing?.data ?? []).find((entry) => entry?.attributes?.locale === WHATS_NEW_LOCALE);
      if (!mine) fail(created.error);
      await requireOk("PATCH", `/v1/betaBuildLocalizations/${encodeURIComponent(mine.id)}`, {
        data: { type: "betaBuildLocalizations", id: mine.id, attributes: { whatsNew } },
      });
      return "updated";
    },

    async assignToGroup(groupId, buildId) {
      const linked = await request("POST", `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`, {
        data: [{ type: "builds", id: buildId }],
      });
      if (!linked.error) return "assigned";
      // 그룹이 "자동 배포"로 설정돼 있으면 Apple이 처리 직후 스스로 붙인다. 그때 이 POST가
      // 거절당하는데, 결과는 우리가 원하던 바로 그 상태다 — 확인하고 성공으로 친다.
      const members = await request("GET", `/v1/betaGroups/${encodeURIComponent(groupId)}/builds?limit=200`);
      if (members.error) fail(linked.error);
      if ((members.data?.data ?? []).some((entry) => entry?.id === buildId)) return "already assigned";
      fail(linked.error);
    },
  };
}
