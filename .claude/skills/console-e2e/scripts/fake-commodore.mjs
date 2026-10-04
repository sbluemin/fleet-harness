// 테스트 전용: --import로 실행할 때만 objectives의 기존 AgentHost port를 감싼다.
// 실제 SDK·CLI·provider를 호출하지 않는다. 제품 소스나 빌드 산출물은 고치지 않는다.
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const given = process.env.FAKE_COMMODORE_DIR;
if (process.env.NODE_ENV !== "test" || !given || !path.isAbsolute(given)) throw new Error("fake_commodore_test_environment_required");
// wrapper는 --run-dir를 실제 경로로 풀어 HOME 등을 준다(macOS의 /tmp → /private/tmp). 같은 기준으로 비교한다.
const run = fs.realpathSync(path.dirname(given));
const dir = path.join(run, path.basename(given));
for (const [key, leaf] of [["HOME", "home"], ["FLEET_DATA_DIR", "root"], ["FLEET_CONSOLE_DATA_DIR", "console"], ["CLAUDE_CONFIG_DIR", "claude"]]) {
  if (process.env[key] !== path.join(run, leaf)) throw new Error("fake_commodore_owned_environment_required");
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
if (fs.realpathSync(dir) !== dir) throw new Error("fake_commodore_symlink_refused");
const log = (event, data = {}) => fs.appendFileSync(path.join(dir, "log.jsonl"), `${JSON.stringify({ at: Date.now(), event, ...data })}\n`, { mode: 0o600 });
const marker = (name) => fs.existsSync(path.join(dir, name));
const originalQuery = "?fake-commodore-original";
let installed = false;

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith("file:") || url.endsWith(originalQuery)) return loaded;
    const file = fileURLToPath(url);
    if (!file.startsWith(`${process.env.FLEET_CONSOLE_DATA_DIR}/plugin-cache/`) || path.basename(file) !== "routes.mjs") return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source ?? []).toString();
    if (!source.includes("createCommodoreSupervisor") || !/id:\s*["']objectives["']/.test(source)) return loaded;
    return { ...loaded, format: "module", source: `import plugin from ${JSON.stringify(url + originalQuery)};\nimport { wrapPlugin } from ${JSON.stringify(import.meta.url)};\nexport default wrapPlugin(plugin);\n` };
  },
});

export function wrapPlugin(plugin) {
  if (plugin.id !== "objectives" || installed) throw new Error("fake_commodore_unexpected_plugin");
  installed = true;
  return {
    ...plugin,
    register(ctx) {
      let serial = 0;
      const timers = new Set();
      const agent = {
        async createSession(options) {
          const id = ++serial;
          let finish;
          let closed = false;
          const settle = (success) => {
            if (!finish) return;
            options.onEvent?.(success ? { kind: "result", isError: false, source: "message", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } } : { kind: "cancelled" });
            const resolve = finish;
            finish = undefined;
            resolve();
          };
          log("created", { id });
          return {
            async send(text) {
              if (closed) throw new Error("session_disposed");
              log("send", { id, characters: text.length, held: marker("hold-turn") });
              if (marker("hold-turn")) {
                await new Promise((resolve) => { finish = resolve; });
              } else {
                options.onEvent?.({ kind: "text", text: "[fake Commodore: no provider call]" });
                options.onEvent?.({ kind: "result", isError: false, source: "message", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
              }
            },
            cancel() { log("cancel", { id }); settle(marker("complete-on-cancel")); },
            async dispose() { closed = true; settle(false); log("dispose", { id }); },
          };
        },
      };
      const experiments = ctx.host.experiments;
      const wrappedExperiments = experiments && {
        ...experiments,
        subscribe(listener) {
          return experiments.subscribe((settings) => {
            if (!marker("hold-experiments")) { listener(settings); return; }
            log("experiments-held");
            const timer = setInterval(() => {
              if (marker("hold-experiments")) return;
              clearInterval(timer);
              timers.delete(timer);
              listener(experiments.read());
              log("experiments-released");
            }, 25);
            timer.unref();
            timers.add(timer);
          });
        },
      };
      ctx.host.lifecycle.registerCleanup(() => { for (const timer of timers) clearInterval(timer); timers.clear(); });
      log("installed");
      fs.writeFileSync(path.join(dir, "installed.json"), JSON.stringify({ pid: process.pid, plugin: plugin.id, fake: true }), { mode: 0o600 });
      return plugin.register({ ...ctx, host: { ...ctx.host, agent, ...(wrappedExperiments ? { experiments: wrappedExperiments } : {}) } });
    },
  };
}
