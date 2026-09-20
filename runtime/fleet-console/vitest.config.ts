import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  resolve: {
    alias: {
      "@fleet-console/agent-runtime/claude": path.join(workspaceRoot, "runtime/fleet-console/foundation/agent-runtime/src/claude"),
      "@fleet-console/agent-runtime": path.join(workspaceRoot, "runtime/fleet-console/foundation/agent-runtime/src"),
      "@fleet-console/ai-gateway": path.join(workspaceRoot, "runtime/fleet-console/features/ai-gateway/runtime/src"),
      "@fleet-console/agent-runtime/fleet": path.join(workspaceRoot, "runtime/fleet-console/foundation/agent-runtime/src/fleet"),
      // 서브패스 alias는 bare alias보다 먼저 와야 한다: 접두 매칭이라 뒤에 두면 절대 도달하지 않는다.
      "@fleet-console/infra/data-dir": path.join(workspaceRoot, "runtime/fleet-console/foundation/infra/src/data-dir/paths.ts"),
      "@fleet-console/infra/workspace-dir": path.join(workspaceRoot, "runtime/fleet-console/foundation/infra/src/workspace-dir/workspace-dir.ts"),
      "@fleet-console/infra": path.join(workspaceRoot, "runtime/fleet-console/foundation/infra/src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}", "features/*/host/**/*.test.ts", "features/*/client/**/*.test.{ts,tsx}"],
    // built smoke self-skips unless FLEET_BUILT_SMOKE=1; keep it discoverable for explicit runs.
    // 파일의 첫 테스트는 그 파일 모듈 그래프의 transform/import 비용을 혼자 지불한다 — 전체 스위트를
    // 병렬로 돌릴 때 그 비용이 기본 5초를 넘겨서, 로직과 무관한 첫 테스트만 타임아웃으로 죽는다.
    // CI 러너는 로컬보다 수 배 느리고, chat/canvas 모듈 그래프가 커진 뒤에는 20초도 모자란다.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
