import http from "node:http";
import type { GatewayExecutionPort } from "../../../ai-gateway/host/routes.js";
import type { HostedGatewayLaunch } from "./contracts.js";
import type { HostedExecution } from "./adapters.js";

export function hostedGatewayUrl(execution: HostedExecution, value: string): string {
  const origin = execution.get("gateway:console")?.runtime.origin;
  if (typeof origin !== "string") throw new Error("session_gateway_not_ready");
  const previous = new URL(value);
  return new URL(`${previous.pathname}${previous.search}`, origin).href.replace(/\/$/, "");
}

/** Credential/settings readers are replaceable business bindings; upstream streams remain in the runner. */
export function hostedGatewayPort(execution: HostedExecution): GatewayExecutionPort {
  const key = "gateway:console";
  const previous = execution.get(key)?.runtime.gatewayOptions as HostedGatewayLaunch["options"] | undefined;
  return {
    tokens: previous ? { compactHookToken: previous.compactHookToken!, modHookToken: previous.modHookToken! } : undefined,
    async connect(deps, tokens) {
      const ports: Record<string, string> = {};
      for (const name of ["readAuth", "readCursorToken", "readXaiToken", "readAntigravityToken", "renewAntigravityToken", "readMuseCodeAuth", "renewMuseCodeAuth", "assignRouting"] as const) {
        const callback = deps[name];
        if (!callback) continue;
        const port = `${key}:${name}`; ports[name] = port;
        execution.bind(port, (call) => {
          if (call.sessionKey !== key) throw new Error("session_gateway_scope");
          return (callback as (body: unknown) => unknown)(call.body);
        });
      }
      const options: HostedGatewayLaunch["options"] = { settings: deps.readAiGatewaySettings?.(), modelOverride: deps.readModelOverride?.(), compactHookToken: tokens.compactHookToken, modHookToken: tokens.modHookToken, maxUpstreamInFlight: deps.maxUpstreamInFlight };
      const snapshot = await execution.open({ sessionKey: key, kind: "gateway", generation: execution.client.generation, options, ports });
      const origin = snapshot.runtime.origin;
      if (typeof origin !== "string") throw new Error("session_gateway_origin_missing");
      return {
        origin,
        async handle({ req, res, pathname }) {
          // This route serves callers outside hosted agents. Hosted SDK/PTY clients use origin directly.
          // Forwarding never reopens upstream inference inside the Console.
          return new Promise<boolean>((resolve, reject) => {
            const target = new URL(`${pathname}${new URL(req.url ?? "/", "http://localhost").search}`, origin);
            const headers = { ...req.headers, host: target.host };
            const proxy = http.request(target, { method: req.method, headers }, (response) => {
              res.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(res); response.once("end", () => resolve(true)); response.once("error", reject);
            });
            proxy.once("error", reject);
            res.once("close", () => proxy.destroy());
            req.pipe(proxy);
          });
        },
        async configure() { await execution.command(key, "configureGateway", { settings: deps.readAiGatewaySettings?.(), modelOverride: deps.readModelOverride?.() }); },
      };
    },
  };
}
