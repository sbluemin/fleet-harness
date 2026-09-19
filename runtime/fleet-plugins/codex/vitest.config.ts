import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../../..");

export default defineConfig({
  resolve: {
    alias: {
      // 서브패스 alias는 bare alias보다 먼저 와야 한다: 접두 매칭이라 뒤에 두면 절대 도달하지 않는다.
      "@fleet-console/agent-runtime/claude": path.join(workspaceRoot, "runtime/fleet-console/foundation/agent-runtime/src/claude"),
      "@fleet-console/agent-runtime": path.join(workspaceRoot, "runtime/fleet-console/foundation/agent-runtime/src"),
      "@fleet-console/ai-gateway": path.join(workspaceRoot, "runtime/fleet-console/features/ai-gateway/runtime/src"),
      "@fleet-console/infra/workspace-dir": path.join(workspaceRoot, "runtime/fleet-console/foundation/infra/src/workspace-dir/workspace-dir.ts"),
      "@fleet-console/infra": path.join(workspaceRoot, "runtime/fleet-console/foundation/infra/src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // 파일의 첫 테스트는 그 파일 모듈 그래프의 transform/import 비용을 혼자 지불한다 —
    // 병렬 실행에서 그 비용이 기본 5초를 넘겨, 로직과 무관한 첫 테스트만 타임아웃으로 죽는다.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
