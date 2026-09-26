const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"] as const;
const NO_PROXY_ENV_KEY = "NO_PROXY";
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

/**
 * 프록시가 설정된 환경에서도 자식이 루프백 주소는 직접 부르게 한다.
 *
 * Fleet 자식은 호스트가 루프백에 연 자리(플러그인 zip, AI Gateway, MCP)를 부른다. 실측(Claude
 * Code 2.1.283): 죽은 `HTTP_PROXY`만 있고 `NO_PROXY`가 없으면 `--plugin-url`의 루프백 fetch까지
 * 프록시로 나가 실패하고, 세션은 오류 한 줄 없이 플러그인만 빠진 채 뜬다. 루프백을 프록시로
 * 보내서 성공하는 구성은 없으므로 예외 목록에 더하는 것은 사용자의 프록시 선택을 바꾸지 않는다.
 *
 * 프록시 변수가 없으면 env를 그대로 돌려준다. Windows는 env 키가 대소문자를 가리지 않으므로
 * 이미 있는 `NO_PROXY` 계열 키는 그 철자 그대로 고치고, 없을 때만 대문자 키 하나를 더한다 —
 * 두 철자를 함께 두면 child env 구성에서 한쪽이 다른 쪽을 덮는다.
 */
export function withLoopbackProxyBypass<T extends Readonly<Record<string, string | undefined>>>(env: T): T {
  const keys = Object.keys(env);
  const proxied = keys.some((key) => PROXY_ENV_KEYS.includes(key.toUpperCase() as (typeof PROXY_ENV_KEYS)[number])
    && (env[key] ?? "").trim().length > 0);
  if (!proxied) return env;
  const noProxyKeys = keys.filter((key) => key.toUpperCase() === NO_PROXY_ENV_KEY);
  const next: Record<string, string | undefined> = { ...env };
  for (const key of noProxyKeys.length > 0 ? noProxyKeys : [NO_PROXY_ENV_KEY]) {
    next[key] = appendLoopbackHosts(next[key]);
  }
  return next as T;
}

function appendLoopbackHosts(value: string | undefined): string {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  // `*`는 이미 모든 주소를 직접 부른다. 더할 것이 없다.
  if (entries.includes("*")) return value ?? "*";
  const present = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const host of LOOPBACK_HOSTS) {
    if (!present.has(host)) entries.push(host);
  }
  return entries.join(",");
}
