import type { PtyInputChunk } from "@dotobokuri/fleet-admiral";

import { parseSgrMouseInput, routeMouseInput, type InputRouterLayout, type RoutedMouseInput } from "./mouse.js";
export { encodeSgrMouseInput, parseSgrMouseInput } from "./mouse.js";
export type { InputRouterLayout, MouseWheelDirection, RoutedMouseInput, SgrMouseInput } from "./mouse.js";
import type { PtyHost } from "./types.js";

export function assertInputContract(keybindings: InputKeybindingConfig): void {
  assertNoDuplicateKeybindings(keybindings);
}

export function isKeyRelease(data: string): boolean {
  return data === "";
}

function assertNoDuplicateKeybindings(keybindings: InputKeybindingConfig): void {
  const keys = [
    ...keybindings.registeredKeybindings.map((binding) => binding.key),
  ];
  if (new Set(keys).size !== keys.length) {
    throw new Error("Dedicated Harness input keybindings must not conflict");
  }
}

export type InputAction = string;

export interface KeybindingRegistration {
  readonly action: InputAction;
  readonly key: string;
  readonly handler: () => void;
}

export interface KeybindingDefinition {
  readonly action: InputAction;
  readonly key: string;
  readonly label?: string;
  readonly description?: string;
  readonly normalizationAliases?: readonly string[];
}

export interface KeybindingRegistry {
  readonly register: (definition: KeybindingDefinition) => void;
  readonly get: (action: InputAction) => KeybindingDefinition | undefined;
  readonly list: () => readonly KeybindingDefinition[];
  readonly findByKey: (key: string) => KeybindingDefinition | undefined;
  readonly assertNoConflicts: () => void;
  readonly createCsiUNormalizationMap: () => ReadonlyMap<string, string>;
}

export interface CreateKeybindingRegistryDeps {
  readonly definitions?: readonly KeybindingDefinition[];
}

export interface InputKeybindingConfig {
  readonly registeredKeybindings: readonly KeybindingRegistration[];
  readonly dispatch: (data: string) => boolean;
}

export interface CreateInputKeybindingConfigDeps {
  readonly registeredKeybindings?: readonly KeybindingRegistration[];
}

export function createKeybindingRegistry(
  deps: CreateKeybindingRegistryDeps = {},
): KeybindingRegistry {
  const definitions = new Map<InputAction, KeybindingDefinition>();

  const registry: KeybindingRegistry = {
    register(definition): void {
      if (definitions.has(definition.action)) {
        throw new Error(`Keybinding action is already registered: ${definition.action}`);
      }

      const conflictingKey = findDefinitionByKey(definitions.values(), definition.key);
      if (conflictingKey !== undefined) {
        throw new Error(`Keybinding key is already registered: ${formatKeyForError(definition.key)}`);
      }

      definitions.set(definition.action, definition);
    },

    get(action): KeybindingDefinition | undefined {
      return definitions.get(action);
    },

    list(): readonly KeybindingDefinition[] {
      return [...definitions.values()];
    },

    findByKey(key): KeybindingDefinition | undefined {
      return findDefinitionByKey(definitions.values(), key);
    },

    assertNoConflicts(): void {
      assertNoKeybindingConflicts(definitions.values());
    },

    createCsiUNormalizationMap(): ReadonlyMap<string, string> {
      return createCsiUNormalizationMap(definitions.values());
    },
  };

  for (const definition of deps.definitions ?? []) {
    registry.register(definition);
  }

  return registry;
}

export function createInputKeybindingConfig(deps: CreateInputKeybindingConfigDeps): InputKeybindingConfig {
  const registeredKeybindings = [...deps.registeredKeybindings ?? []];

  return {
    registeredKeybindings,
    dispatch(data): boolean {
      for (const registration of registeredKeybindings) {
        if (data === registration.key) {
          registration.handler();
          return true;
        }
      }
      return false;
    },
  };
}

function legacyToCsiU(legacyKey: string): string | undefined {
  if (legacyKey.length === 1) {
    const code = legacyKey.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return `\x1b[${code + 96};5u`;
    }
    return undefined;
  }

  if (legacyKey.length === 2 && legacyKey[0] === "\x1b") {
    const code = legacyKey.charCodeAt(1);
    if (code >= 0x21 && code <= 0x7e) {
      return `\x1b[${code};3u`;
    }
  }

  return undefined;
}

function createCsiUNormalizationMap(
  definitions: Iterable<KeybindingDefinition>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const definition of definitions) {
    addCsiUNormalization(map, definition.key);
    for (const alias of definition.normalizationAliases ?? []) {
      addCsiUNormalization(map, alias);
    }
  }
  return map;
}

function assertNoKeybindingConflicts(definitions: Iterable<KeybindingDefinition>): void {
  const actions = new Set<InputAction>();
  const keys = new Set<string>();
  for (const definition of definitions) {
    if (actions.has(definition.action)) {
      throw new Error(`Keybinding action is already registered: ${definition.action}`);
    }
    if (keys.has(definition.key)) {
      throw new Error(`Keybinding key is already registered: ${formatKeyForError(definition.key)}`);
    }
    actions.add(definition.action);
    keys.add(definition.key);
  }
}

function addCsiUNormalization(map: Map<string, string>, legacyKey: string): void {
  const csiU = legacyToCsiU(legacyKey);
  if (csiU === undefined) {
    return;
  }
  map.set(csiU, legacyKey);
}

function findDefinitionByKey(
  definitions: Iterable<KeybindingDefinition>,
  key: string,
): KeybindingDefinition | undefined {
  for (const definition of definitions) {
    if (definition.key === key) {
      return definition;
    }
  }
  return undefined;
}

function formatKeyForError(key: string): string {
  return JSON.stringify(key);
}

type InputToken = string;

export interface InputRouterOptions {
  readonly getLayout?: () => InputRouterLayout;
  readonly keybindings: InputKeybindingConfig;
  readonly routeDedicatedMouse?: (event: RoutedMouseInput) => boolean;
  readonly routeFleetMouse?: (event: RoutedMouseInput) => boolean;
  readonly writeDedicated: (data: string) => void;
}

export interface InputRouter {
  readonly route: (data: string) => { readonly consume: boolean };
}

export function createInputRouter(options: InputRouterOptions): InputRouter {
  return {
    route(data: string) {
      let dedicatedOutput = "";
      for (const token of splitInputChunk(data)) {
        const mouseInput = parseSgrMouseInput(token);
        if (mouseInput !== null && routeMouseInput(mouseInput, options)) {
          continue;
        }

        if (isKeyRelease(token)) {
          continue;
        }

        if (options.keybindings.dispatch(token)) {
          continue;
        }

        dedicatedOutput += token;
      }

      if (dedicatedOutput.length > 0) {
        options.writeDedicated(dedicatedOutput);
      }
      return { consume: true };
    },
  };
}

function splitInputChunk(data: string): InputToken[] {
  const tokens: InputToken[] = [];
  let index = 0;
  while (index < data.length) {
    const char = data[index];
    if (char === "\x1b") {
      const end = readEscapeSequenceEnd(data, index);
      tokens.push(data.slice(index, end));
      index = end;
      continue;
    }

    if (isControlCharacter(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }

    const next = readPrintableRunEnd(data, index);
    tokens.push(data.slice(index, next));
    index = next;
  }
  return tokens;
}

function readEscapeSequenceEnd(data: string, start: number): number {
  const prefix = data[start + 1];
  if (prefix !== "[") {
    return Math.min(data.length, start + 2);
  }

  let index = start + 2;
  while (index < data.length) {
    const code = data.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) {
      return index;
    }
  }
  return data.length;
}

function readPrintableRunEnd(data: string, start: number): number {
  let index = start;
  while (index < data.length && data[index] !== "\x1b" && !isControlCharacter(data[index])) {
    index += 1;
  }
  return index;
}

function isControlCharacter(char: string): boolean {
  if (char.length === 0) {
    return false;
  }

  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

export interface ProgrammaticInputProfile {
  readonly messagePolicy?: CliMessagePolicy;
}

export interface CliMessagePolicy {
  readonly bracketedPaste?: boolean;
  readonly conptyPasteBurst?: boolean;
  readonly lineTerminator?: string;
  readonly multilineStrategy?: "literal" | "paste-mode";
}

export interface ProgrammaticInput {
  readonly sendMessage: (
    text: string,
    opts?: {
      readonly bracketedPaste?: boolean;
      readonly conptyPasteBurst?: boolean;
      readonly lineTerminator?: string;
      readonly multilineStrategy?: "literal" | "paste-mode";
    },
  ) => void;
  readonly sendKeys: (data: string) => void;
  readonly sendCommand: (line: string) => void;
}

const DEFAULT_BRACKETED_PASTE = false;
const DEFAULT_CONPTY_PASTE_BURST = false;
const DEFAULT_LINE_TERMINATOR = "\r";
const DEFAULT_MULTILINE_STRATEGY = "literal";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const LINE_BREAK_PATTERN = /[\r\n]/;
// Windows crossterm reads INPUT_RECORD rather than bracketed paste, then Codex suppresses Enter during its paste burst window.
const WINDOWS_CONPTY_SUBMIT_DELAY_MS = 250;

export function createProgrammaticInput(
  ptyHost: PtyHost,
  profile: ProgrammaticInputProfile,
  platform: NodeJS.Platform = process.platform,
): ProgrammaticInput {
  return {
    sendMessage(text, opts) {
      writeChunksWithDelay((data) => ptyHost.write(data), formatProgrammaticInputMessage(resolvePolicy(profile, opts), text, platform));
    },

    sendKeys(data) {
      ptyHost.write(data);
    },

    sendCommand(line) {
      assertSingleLineCommand(line);
      writeChunksWithDelay((data) => ptyHost.write(data), formatProgrammaticInputMessage(resolvePolicy(profile), line, platform));
    },
  };
}

function resolvePolicy(
  profile: ProgrammaticInputProfile,
  opts: {
    readonly bracketedPaste?: boolean;
    readonly conptyPasteBurst?: boolean;
    readonly lineTerminator?: string;
    readonly multilineStrategy?: "literal" | "paste-mode";
  } = {},
): Required<CliMessagePolicy> {
  return {
    bracketedPaste: opts.bracketedPaste ?? profile.messagePolicy?.bracketedPaste ?? DEFAULT_BRACKETED_PASTE,
    conptyPasteBurst: opts.conptyPasteBurst ?? profile.messagePolicy?.conptyPasteBurst ?? DEFAULT_CONPTY_PASTE_BURST,
    lineTerminator: opts.lineTerminator ?? profile.messagePolicy?.lineTerminator ?? DEFAULT_LINE_TERMINATOR,
    multilineStrategy: opts.multilineStrategy ?? profile.messagePolicy?.multilineStrategy ?? DEFAULT_MULTILINE_STRATEGY,
  };
}

export function formatProgrammaticInputMessage(
  policy: Required<CliMessagePolicy>,
  text: string,
  platform: NodeJS.Platform = process.platform,
): PtyInputChunk[] {
  return applyMessagePolicy(text, policy, platform);
}

function applyMessagePolicy(
  text: string,
  policy: Required<CliMessagePolicy>,
  platform: NodeJS.Platform,
): PtyInputChunk[] {
  const usePasteMode = policy.bracketedPaste || (policy.multilineStrategy === "paste-mode" && LINE_BREAK_PATTERN.test(text));

  if (policy.conptyPasteBurst && platform === "win32" && usePasteMode) {
    return [
      { data: text },
      { data: policy.lineTerminator, submitDelayMs: WINDOWS_CONPTY_SUBMIT_DELAY_MS },
    ];
  }

  return [{
    data: usePasteMode
      ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}${policy.lineTerminator}`
      : `${text}${policy.lineTerminator}`,
  }];
}

function writeChunksWithDelay(write: (data: string) => void, chunks: readonly PtyInputChunk[]): void {
  let index = 0;

  const writeNext = (): void => {
    const chunk = chunks[index++];
    if (!chunk) return;

    const commit = () => {
      try {
        write(chunk.data);
      } catch {
        // Sessions may close before a deferred submit reaches the host PTY.
      }
      writeNext();
    };

    if (chunk.submitDelayMs === undefined) {
      commit();
    } else {
      setTimeout(commit, chunk.submitDelayMs);
    }
  };

  writeNext();
}

function assertSingleLineCommand(line: string): void {
  if (LINE_BREAK_PATTERN.test(line)) {
    throw new Error("Programmatic command must be a single line.");
  }
}
