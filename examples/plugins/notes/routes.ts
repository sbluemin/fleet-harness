import { registerLaunchCatalog } from "@fleet-console/sdk/plugin/node";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

export function register(ctx: FleetPluginServerContext): void {
  // 캔버스 launch 메뉴는 서버 카탈로그(/operations/catalog)로 구동되므로, client operationKind와
  // 별개로 launch 가능한 kind를 서버측에 등록해야 외부 플러그인을 새 Operation으로 띄울 수 있다.
  registerLaunchCatalog(ctx, () => [{ id: "notes", type: "notes", title: "Notes" }]);
  // 플러그인 라우트 경로는 plugin scope(/plugins/notes) 기준 상대경로여야 한다. 선행 슬래시("/info")는
  // scope 밖 절대경로로 해석되어 거부되므로, 상대경로 "info"로 등록해 /plugins/notes/info에 매핑한다.
  ctx.registerRouter("info", ({ req, res }) => {
    if (req.method !== "GET") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    ctx.host.http.writeJson(res, 200, { name: "Notes", version: 1 });
    return true;
  });
}
