import type { ClientSettingsCapability } from "../shared/client-ports.js";

/** 조합이 고른 설정 문서 한 칸. 소유자 이름이나 저장 위치는 브라우저 호출자가 바꾸지 않는다. */
export function createSettingsDocumentApi(path: "/api/v1/settings/quota" | "/api/v1/settings/scuttlebutt"): ClientSettingsCapability {
  return {
    async read() {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Settings read failed: ${response.status}`);
      const { value } = await response.json() as { readonly value?: unknown };
      return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
    },
    async write(value) {
      const response = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
      if (!response.ok) throw new Error(`Settings write failed: ${response.status}`);
    },
  };
}
