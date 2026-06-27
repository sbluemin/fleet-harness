import { registerLaunchCatalog } from "@fleet-console/sdk/plugin/node";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

export function register(ctx: FleetPluginServerContext): void {
  // 캔버스 launch 메뉴는 서버 카탈로그(/operations/catalog)로 구동되므로, client operationKind와
  // 별개로 launch 가능한 kind를 서버측에 등록해야 외부 플러그인을 새 Operation으로 띄울 수 있다.
  registerLaunchCatalog(ctx, () => [{ id: "notes", type: "notes", title: "Notes" }]);
  ctx.registerRouter("/info", ({ req, res }) => {
    if (req.method !== "GET") {
      ctx.host.http.writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }
    ctx.host.http.writeJson(res, 200, { name: "Notes", version: 1 });
    return true;
  });
}
