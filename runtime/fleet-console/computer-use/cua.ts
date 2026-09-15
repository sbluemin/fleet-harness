import crypto from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ComputerUseInputError, isRecord, type ComputerUseBackend, type ComputerUseBackendOptions, type ComputerUseResult, type ComputerUseTool, type ComputerUseWindowIdentity, type ComputerUseRuntimeDependencies, type ComputerUseAppTarget } from "./platform.js";
import { resolveCuaDriver } from "./cua-install.js";
import { prepareMacPaste } from "./macos-paste.js";
import { assertMacInteractionReadiness } from "./macos-window.js";

const execute = promisify(execFile);
const ACTIONS = ["click", "type_text", "set_value", "press_key", "scroll", "drag"] as const;
const PRIVATE_ARGUMENTS = new Set(["pid", "window_id", "snapshot_id", "session", "target", "scope", "from_zoom", "debug_image_out", "screenshot_out_file", "delivery_mode"]);
type Target = ComputerUseWindowIdentity & { readonly app: string; readonly name: string };

export function cuaData(result: ComputerUseResult): Record<string, unknown> {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  for (const block of result.content) if (block.type === "text" && typeof block.text === "string") {
    try { const data: unknown = JSON.parse(block.text); if (isRecord(data)) return data; } catch {}
  }
  return {};
}

/** 이 Fleet 연결의 데몬·MCP·세션만 소유하며 공유 Cua 데몬에는 연결하지 않는다. */
export class CuaComputerUseBackend implements ComputerUseBackend {
  readonly tools = new Map<string, ComputerUseTool>();
  cleanupStatus: ComputerUseBackend["cleanupStatus"] = "not_requested";
  threadReleaseStatus: ComputerUseBackend["threadReleaseStatus"] = "not_needed";
  cleanupFailure: ComputerUseBackend["cleanupFailure"] = null;
  private daemon: ChildProcess | null = null;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private directory: string | null = null;
  private readonly session = `fleet-${crypto.randomUUID()}`;
  private readonly targets = new Map<string, Target>();
  private readonly snapshots = new Map<string, { id: string; target: Target; tokens: ReadonlySet<string>; indices: ReadonlySet<number> }>();
  private stopping: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly binary: string, private readonly options: ComputerUseBackendOptions, private readonly runtime: Pick<ComputerUseRuntimeDependencies, "childEnv">) {}

  static async create(options: ComputerUseBackendOptions, runtime: Pick<ComputerUseRuntimeDependencies, "childEnv">): Promise<CuaComputerUseBackend | null> {
    const binary = await resolveCuaDriver(options.directory);
    return binary ? new CuaComputerUseBackend(binary, options, runtime) : null;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("computer_use_stopped");
    await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    this.directory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-cua-"));
    if (this.closed) { await fs.rm(this.directory, { recursive: true, force: true }); throw new Error("computer_use_stopped"); }
    const socket = process.platform === "win32" ? `\\\\.\\pipe\\${this.session}` : path.join(this.directory, "driver.sock");
    const env = Object.fromEntries(Object.entries(this.runtime.childEnv()).filter(([key, value]) => value !== undefined && !/^(CUA_|CODEX_|NODE_OPTIONS$|NODE_PATH$|DYLD_|LD_PRELOAD|FLEET_)/.test(key))) as Record<string, string>;
    Object.assign(env, { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_EMBEDDED_HOST_PID: String(process.pid), CUA_TELEMETRY_ENABLED: "0" });
    const daemon = spawn(this.binary, ["serve", "--embedded", "--parent-liveness-stdio", "--no-permissions-gate", "--socket", socket, "--permission-mode", "standard"], { env, stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    this.daemon = daemon;
    daemon.stderr?.resume();
    let failed = false;
    daemon.on("error", () => { failed = true; });
    daemon.once("exit", () => { if (!this.closed) void this.stop(); });
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (this.closed || failed || daemon.exitCode !== null) throw new Error("computer_use_driver_start_failed");
        if (process.platform === "win32" ? i >= 5 : await fs.stat(socket).then(s => s.isSocket(), () => false)) { ready = true; break; }
        await new Promise(r => setTimeout(r, 100));
      }
      if (!ready || this.closed || !await this.options.approve({})) throw new Error("computer_use_stopped");
      this.transport = new StdioClientTransport({ command: this.binary, args: ["mcp", "--embedded", "--socket", socket], env, stderr: "pipe" });
      const client = new Client({ name: "fleet-computer-use", version: "2" }, { capabilities: {} });
      this.client = client;
      await client.connect(this.transport);
      this.transport.stderr?.on("data", () => undefined);
      const inventory = await client.listTools();
      for (const name of ACTIONS) {
        const tool = inventory.tools.find(t => t.name === name);
        if (!tool) continue;
        const properties = Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {}).filter(([key]) => !PRIVATE_ARGUMENTS.has(key)));
        this.tools.set(name, { name, description: tool.description, inputSchema: { type: "object", properties: { ...properties, app: { type: "string" } }, additionalProperties: false, required: [...(tool.inputSchema.required ?? []).filter(key => !PRIVATE_ARGUMENTS.has(key)), "app"] } });
      }
      // macOS 클립보드 보존·복원은 기존 방어를 공유하고 Cua 키 전달만 사용한다.
      if (process.platform === "darwin") this.tools.set("paste", { name: "paste", inputSchema: { type: "object", properties: { app: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 100_000 }, format: { type: "string", enum: ["text", "md", "html"] } }, required: ["app", "text", "format"], additionalProperties: false } });
      const opened = await this.native("start_session", {});
      if (opened.isError) throw new Error("computer_use_session_start_failed");
    } catch (error) { await this.stop(); throw error; }
  }

  async call(tool: string, args: Record<string, unknown>, options?: { readonly allowActivation: boolean }): Promise<ComputerUseResult> {
    if (tool === "list_apps") return this.apps();
    const app = String(args.app);
    if (tool === "get_app_state") return this.observe(app, args);
    if (tool === "verify_state") {
      this.snapshots.clear();
      const target = await this.resolve(app);
      return this.native("verify_state", { pid: target.pid, window_id: target.windowId, expect: args.expect, include_screenshot: args.includeScreenshot === true, timeout_ms: args.timeoutMs ?? 0, stable_samples: args.stableSamples ?? 1 });
    }
    const snapshot = this.snapshots.get(app);
    if (!snapshot) throw new ComputerUseInputError("computer_use_fresh_state_required", "Request computer_state for the intended window.");
    await this.verifyTarget(snapshot.target);
    const { app: _app, ...input } = args;
    for (const key of Object.keys(input)) if (PRIVATE_ARGUMENTS.has(key)) throw new ComputerUseInputError("computer_use_invalid_arguments", "Target, snapshot and delivery fields are Fleet-owned.");
    if (typeof input.element_token === "string" && !snapshot.tokens.has(input.element_token) || "element_index" in input && !snapshot.indices.has(Number(input.element_index))) throw new ComputerUseInputError("computer_use_stale_snapshot", "Use an element delivered in this app's current observation.");
    if (!await this.options.approve({})) throw new Error("computer_use_stopped");
    const reusable = tool !== "paste" && ("element_index" in input || "element_token" in input) && !("x" in input || "y" in input) && tool !== "drag";
    if (!reusable) this.snapshots.clear();
    const target = { pid: snapshot.target.pid, window_id: snapshot.target.windowId };
    if (tool === "paste") {
      await assertMacInteractionReadiness(snapshot.target.app, options?.allowActivation === true);
      const lease = await prepareMacPaste(snapshot.target.app, String(input.text), input.format as "text" | "md" | "html", options?.allowActivation === true);
      let response: ComputerUseResult;
      let restoration;
      try {
        await assertMacInteractionReadiness(snapshot.target.app, options?.allowActivation === true);
        await this.verifyTarget(snapshot.target);
        response = await this.native("press_key", { ...target, key: "v", modifiers: ["cmd"], delivery_mode: "background" });
      } finally { restoration = await lease.finish(); }
      return { ...response, content: [{ type: "text", text: JSON.stringify({ clipboardRestoration: restoration }) }, ...response.content] };
    }
    if (!this.tools.has(tool)) throw new ComputerUseInputError("computer_use_invalid_action", "This backend does not advertise this action. Use actionSchemas from computer_state.");
    try {
      const response = await this.native(tool, { ...input, ...target, ...(tool !== "set_value" ? { delivery_mode: "background" } : {}), ...("element_index" in input ? { snapshot_id: snapshot.id } : {}) });
      if (response.isError) this.snapshots.clear();
      return response;
    } catch (error) { this.snapshots.clear(); throw error; }
  }

  private async apps(): Promise<ComputerUseResult> {
    const listed = await this.native("list_apps", {}, false);
    const windows = await this.native("list_windows", {}, false);
    if (listed.isError || windows.isError) return { content: [...listed.content, ...windows.content], isError: true };
    const apps = cuaData(listed).apps;
    const rows = cuaData(windows).windows;
    const targets: ComputerUseAppTarget[] = [];
    for (const app of Array.isArray(apps) ? apps.filter(isRecord) : []) {
      const name = String(app.name ?? "");
      const identifier = String(app.launch_path ?? app.bundle_id ?? app.name ?? "");
      if (!identifier) continue;
      targets.push({ name, app: identifier, bundleId: typeof app.bundle_id === "string" ? app.bundle_id : null });
      const matching = Array.isArray(rows) ? rows.filter(isRecord).filter(w => w.pid === app.pid) : [];
      const started = matching.length && Number.isSafeInteger(app.pid) && Number(app.pid) > 0 ? await this.processStart(Number(app.pid)).catch(() => null) : null;
      if (started === null) continue;
      for (const window of matching) {
        if (!Number.isSafeInteger(window.window_id)) continue;
        const value: Target = { pid: Number(app.pid), windowId: Number(window.window_id), processStartedAt: started, app: identifier, name, title: String(window.title ?? "") };
        const id = this.remember(value);
        targets.push({ name: `${name} (${value.title})`, app: id, bundleId: typeof app.bundle_id === "string" ? app.bundle_id : null });
      }
    }
    return { content: [{ type: "text", text: targets.map(target => `${target.name} — ${target.app} — ${target.bundleId ?? ""}`).join("\n") }], structuredContent: { targets } };
  }

  private remember(target: Target): string {
    const existing = [...this.targets].find(([, t]) => t.pid === target.pid && t.windowId === target.windowId && t.processStartedAt === target.processStartedAt);
    const id = existing?.[0] ?? `cua:${crypto.randomUUID()}`;
    this.targets.set(id, target);
    return id;
  }

  private async resolve(app: string): Promise<Target> {
    const selected = this.targets.get(app);
    if (selected) { await this.verifyTarget(selected); return selected; }
    if (app.startsWith("cua:")) throw new ComputerUseInputError("computer_use_target_expired", "List apps again; this window identifier belongs to an ended broker session.");
    const listed = await this.native("list_apps", {}, false);
    if (listed.isError) throw new Error("computer_use_invalid_app_inventory");
    const rows = cuaData(listed).apps;
    const matches = Array.isArray(rows) ? rows.filter(isRecord).filter(a => [a.bundle_id, a.name, a.launch_path].includes(app)) : [];
    if (matches.length !== 1) throw new ComputerUseInputError("computer_use_ambiguous_app", "Use an exact app or window identifier from computer_apps. No app was launched.");
    const match = matches[0]!;
    if (!Number.isSafeInteger(match.pid) || Number(match.pid) <= 0) throw new ComputerUseInputError("computer_use_no_action_window", "The app is not running. Open it explicitly if authorized.");
    const pid = Number(match.pid);
    const response = await this.native("list_windows", { pid }, false);
    const windows = cuaData(response).windows;
    if (response.isError || !Array.isArray(windows)) throw new Error("computer_use_invalid_window_inventory");
    const candidates = windows.filter(isRecord).filter(w => w.pid === pid && Number.isSafeInteger(w.window_id));
    if (candidates.length !== 1) throw new ComputerUseInputError("computer_use_ambiguous_window", "Use the exact cua: window identifier from computer_apps. No window was selected automatically.");
    const target: Target = { pid, windowId: Number(candidates[0]!.window_id), processStartedAt: await this.processStart(pid), app: String(match.launch_path ?? app), name: String(match.name ?? app), title: String(candidates[0]!.title ?? "") };
    this.remember(target);
    return target;
  }

  private async observe(app: string, options: Record<string, unknown>): Promise<ComputerUseResult> {
    this.snapshots.clear();
    const target = await this.resolve(app);
    const response = await this.native("get_window_state", { pid: target.pid, window_id: target.windowId, include_accessibility_tree: true, include_screenshot: options.includeScreenshot !== false,
      max_depth: options.maxDepth ?? 8, max_elements: options.maxElements ?? 300,
      ...(options.query === undefined ? {} : { query: options.query }) });
    if (response.isError) return { ...response, captureWindow: null };
    const data = cuaData(response);
    if (typeof data.snapshot_id !== "string" || !data.snapshot_id) throw new Error("computer_use_invalid_snapshot");
    const elements = Array.isArray(data.elements) ? data.elements.filter(isRecord).map(e => ({ element_index: e.element_index, element_token: e.element_token, role: e.role, label: e.label, value: e.value, actions: e.actions, parent_index: e.parent_index, depth: e.depth })) : [];
    const menuRoots = new Set(elements.filter(e => /^(AX)?MenuBar$/.test(String(e.role))).map(e => e.element_index));
    const menuElements = new Set(menuRoots);
    for (const element of elements) if (menuElements.has(element.parent_index)) menuElements.add(element.element_index);
    const visible = options.includeMenus === true ? elements : elements.filter(e => !menuElements.has(e.element_index));
    this.snapshots.set(app, { id: data.snapshot_id, target, tokens: new Set(visible.map(e => String(e.element_token))), indices: new Set(visible.map(e => Number(e.element_index))) });
    const observation = { cuaObservation: true, elements: visible, ...(elements.length ? {} : { tree: data.tree_markdown }), truncated: data.elements_complete === false, filtered: options.query !== undefined, menusIncluded: options.includeMenus === true, limits: { maxDepth: options.maxDepth ?? 8, maxElements: options.maxElements ?? 300 }, degradedReason: data.degraded_reason };
    return { content: [{ type: "text", text: JSON.stringify(observation) }, ...response.content.filter(b => b.type === "image")], captureWindow: { pid: target.pid, windowId: target.windowId, processStartedAt: target.processStartedAt, title: String(data.window_title ?? target.title) } };
  }

  async verifyCapture(identity: ComputerUseWindowIdentity): Promise<boolean> {
    if (this.closed || await this.processStart(identity.pid) !== identity.processStartedAt) return false;
    const response = await this.native("list_windows", { pid: identity.pid }, false);
    const rows = cuaData(response).windows;
    return !response.isError && Array.isArray(rows) && rows.some(w => isRecord(w) && w.pid === identity.pid && w.window_id === identity.windowId);
  }

  private async verifyTarget(target: ComputerUseWindowIdentity): Promise<void> {
    if (!await this.verifyCapture(target)) throw new ComputerUseInputError("computer_use_target_expired", "List windows again; the process or window ended or changed.");
  }

  private async processStart(pid: number): Promise<number> {
    let value: number;
    if (process.platform === "darwin") {
      const { stdout } = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", "ObjC.import('AppKit');function run(a){return String(Number($.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(a[0])).launchDate.timeIntervalSince1970));}", String(pid)], { timeout: 3000 });
      value = Number(stdout.trim());
    } else if (process.platform === "linux") {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      value = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    } else {
      const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], { timeout: 3000, windowsHide: true });
      value = Number(stdout.trim());
    }
    if (!Number.isFinite(value) || value <= 0) throw new Error("computer_use_process_unavailable");
    return value;
  }

  private async native(name: string, args: Record<string, unknown>, session = true): Promise<ComputerUseResult> {
    if (!this.client || this.closed || !await this.options.approve({})) throw new Error("computer_use_stopped");
    const response = await this.client.callTool({ name, arguments: { ...args, ...(session ? { session: this.session } : {}) } }, undefined, { timeout: 30_000 });
    const content = Array.isArray(response.content) ? response.content.filter(isRecord) : [];
    const data = response.structuredContent;
    if (isRecord(data) && !["get_window_state", "list_apps", "list_windows"].includes(name)) {
      const images = content.filter(block => block.type === "image");
      content.splice(0, content.length, { type: "text", text: JSON.stringify(data) }, ...images);
    }
    return { content, structuredContent: data, isError: response.isError === true || (isRecord(data) && data.effect === "refused") };
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.stopping = (async () => {
      try {
        if (this.client) {
          const ended = await this.client.callTool({ name: "end_session", arguments: { session: this.session } }, undefined, { timeout: 1500 });
          this.cleanupStatus = ended.isError ? "failed" : "notified";
          if (ended.isError) this.cleanupFailure = "client_exit";
        } else this.cleanupStatus = "not_needed";
      } catch { this.cleanupStatus = "failed"; this.cleanupFailure = "client_unavailable"; }
      finally {
        await this.client?.close().catch(() => undefined);
        const daemon = this.daemon;
        if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
          const exited = new Promise<void>(r => daemon.once("exit", () => r()));
          daemon.stdin?.end();
          const kill = setTimeout(() => daemon.kill("SIGKILL"), 2000);
          await exited; clearTimeout(kill);
        }
        this.snapshots.clear(); this.targets.clear();
        if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
      }
    })();
    return this.stopping;
  }
}
