import { createMacOSComputerUsePlatform } from "./macos.js";
import { CuaComputerUseBackend, cuaData } from "./cua.js";
import { resolveCuaDriver, cuaInstallSupported } from "./cua-install.js";
import { ComputerUseInputError, isRecord, type ComputerUseAppTarget, type ComputerUsePlatform, type ComputerUseResult, type ComputerUseRuntimeDependencies } from "./platform.js";

function appTargets(result: ComputerUseResult): ComputerUseAppTarget[] {
  if (result.isError) return [];
  return result.content.flatMap(block => {
    if (block.type !== "text" || typeof block.text !== "string") return [];
    return block.text.split("\n").flatMap(line => {
      const [name, app, bundleId] = line.split(" — ");
      return name && app ? [{ name, app, bundleId: bundleId || null }] : [];
    });
  });
}

export function createCuaComputerUsePlatform(directory: string, runtime: ComputerUseRuntimeDependencies): ComputerUsePlatform {
  const mac = createMacOSComputerUsePlatform(runtime);
  let broker: CuaComputerUseBackend | null = null;
  return {
    ...mac,
    boundedObservations: true,
    reusableElementSnapshots: true,
    verification: true,
    supported: cuaInstallSupported,
    unavailableError: "computer_use_platform_unsupported",
    endHint: "Fleet closed its private Cua session and daemon. No shared Cua daemon or other app was stopped. Use computer_status without reconnecting to inspect cleanup.",
    appTargetSchema: { type: "string", minLength: 1, maxLength: 4096, description: "Exact app identifier or cua: window identifier from computer_apps. Multiple windows require an exact cua: identifier; no window is chosen automatically. Identifiers expire when the broker ends." },
    inspectInstallation: async () => Boolean(await resolveCuaDriver(directory)),
    createBroker: async options => { broker = await CuaComputerUseBackend.create(options, runtime); return broker; },
    resolveTarget: async app => app.startsWith("cua:") || process.platform !== "darwin" ? app : mac.resolveTarget(app),
    // Cua가 정확한 창의 background 경로를 판정한다. 거부를 활성화 허용으로 바꾸지 않는다.
    preflight: async () => {},
    inspectWindows: async apps => Promise.all(apps.map(async app => {
      if (!app.startsWith("cua:") && process.platform === "darwin") return (await mac.inspectWindows([app]))[0]!;
      return { app, status: "unknown" as const, pid: null, frontmost: null, hidden: null, windowCount: null, reason: "use_computer_state_for_exact_window" };
    })),
    openApp: async (app, signal, activate) => {
      if (process.platform !== "darwin") throw new ComputerUseInputError("computer_use_open_unsupported", "computer_open retains its exact macOS .app installation contract. Open the intended app explicitly outside this tool on this platform.");
      return mac.openApp(app, signal, activate);
    },
    displayTarget: app => app,
    captureTarget: value => value.captureWindow ?? null,
    verifyCaptureTarget: async target => await broker?.verifyCapture(target).catch(() => false) ?? false,
    appTargets,
    appCandidates: (value, app, targets) => [...targets, ...appTargets(value)].filter(target => target.app === app || target.name === app || target.bundleId === app),
    prepareAction: (action, input) => {
      if (action === "type_text" && typeof input.text === "string" && /[\x00-\x1f\x7f-\x9f]/u.test(input.text)) throw new ComputerUseInputError("computer_use_control_characters_require_explicit_action", "Use set_value for a complete multiline field value or explicit computer_paste. No input was sent.");
      return input;
    },
    actionSchemas: tools => Object.fromEntries([...tools].filter(([name]) => name !== "paste").map(([name, tool]) => {
      const properties = isRecord(tool.inputSchema.properties) ? Object.fromEntries(Object.entries(tool.inputSchema.properties).filter(([key]) => key !== "app")) : {};
      const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required.filter(key => key !== "app") : [];
      return [name, { ...tool.inputSchema, properties, required, description: "Cua Driver background delivery only. No automatic foreground fallback or follow-up observation. Verify with computer_verify; re-observe after structural changes. " + (tool.description ?? "") }];
    })),
    hasFullObservation: value => !value.isError && cuaData(value).cuaObservation === true && cuaData(value).truncated !== true && cuaData(value).filtered !== true,
    hasActionObservation: () => false,
    interactionHints: () => ["Cua Driver targets one exact window and sends background input. A returned action is not task success. Element handles can be reused while the intended structure remains unchanged; coordinates require a fresh screenshot after any action. Use computer_verify for bounded postconditions; verification invalidates prior handles. Only actions in actionSchemas are supported; no automatic substitute, foreground escalation, or retry."],
    classifyFailure: value => value.dispatchBlocked ? "computer_use_activation_blocked" : "computer_use_native_error",
    failureHint: () => "Inspect the native refusal or delivery evidence. No fallback or retry was performed. Request computer_state explicitly before deciding on another action; do not interpret delivery as task success.",
  };
}
