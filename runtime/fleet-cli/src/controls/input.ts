import type { PtyHost } from "./types.js";

type InputToken = string;
export type InputAction = string;
export type MouseWheelDirection = "up" | "down";

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
  readonly exitKeys: ReadonlySet<string>;
  readonly modeToggleKeys: ReadonlySet<string>;
  readonly registeredKeybindings: readonly KeybindingRegistration[];
  readonly dispatch: (data: string) => boolean;
}

export interface CreateInputKeybindingConfigDeps {
  readonly exitKeys: readonly string[];
  readonly modeToggleKeys: readonly string[];
  readonly registeredKeybindings?: readonly KeybindingRegistration[];
}

export interface SgrMouseInput {
  readonly buttonCode: number;
  readonly column: number;
  readonly final: "M" | "m";
  readonly raw: string;
  readonly row: number;
  readonly wheelDirection: MouseWheelDirection | null;
}

export interface InputRouterLayout {
  readonly columns: number;
  readonly dedicatedRows: number;
  readonly fleetRows: number;
  readonly totalRows: number;
}

export type RoutedMouseInput = SgrMouseInput & {
  readonly localColumn: number;
  readonly localRow: number;
};

export interface InputRouterOptions<TMode extends string = string> {
  readonly getLayout?: () => InputRouterLayout;
  readonly initialMode: TMode;
  readonly keybindings: InputKeybindingConfig;
  readonly onExit: () => void;
  readonly onModeChange: (mode: TMode) => void;
  readonly routeDedicatedMouse?: (event: RoutedMouseInput) => boolean;
  readonly routeFleetInput?: (data: string) => boolean;
  readonly routeFleetMouse?: (event: RoutedMouseInput) => boolean;
  readonly toggleMode: (mode: TMode) => TMode;
  readonly writeDedicated: (data: string) => void;
}

export interface InputRouter<TMode extends string = string> {
  readonly getMode: () => TMode;
  readonly route: (data: string) => { readonly consume: boolean };
}

export interface ProgrammaticInputProfile {
  readonly messagePolicy?: CliMessagePolicy;
}

export interface CliMessagePolicy {
  readonly bracketedPaste?: boolean;
  readonly lineTerminator?: string;
  readonly multilineStrategy?: "literal" | "paste-mode";
}

export interface ProgrammaticInput {
  readonly sendMessage: (
    text: string,
    opts?: {
      readonly bracketedPaste?: boolean;
      readonly lineTerminator?: string;
      readonly multilineStrategy?: "literal" | "paste-mode";
    },
  ) => void;
  readonly sendKeys: (data: string) => void;
  readonly sendCommand: (line: string) => void;
}

interface AppliedMessagePolicy {
  readonly payload: string;
  readonly submit?: string;
}

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/;
const SGR_MOUSE_WHEEL_UP = 64;
const SGR_MOUSE_WHEEL_DOWN = 65;
const DEFAULT_BRACKETED_PASTE = false;
const DEFAULT_LINE_TERMINATOR = "\r";
const DEFAULT_MULTILINE_STRATEGY = "literal";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const LINE_BREAK_PATTERN = /[\r\n]/;

export function createInputRouter<TMode extends string = string>(options: InputRouterOptions<TMode>): InputRouter<TMode> {
  let mode = options.initialMode;

  return {
    getMode: () => mode,
    route(data: string) {
      let dedicatedOutput = "";
      for (const token of splitInputChunk(data)) {
        const mouseInput = parseSgrMouseInput(token);
        if (mouseInput !== null && routeMouseInput(mouseInput, options)) {
          continue;
        }

        if (isHostExit(token, options.keybindings)) {
          if (dedicatedOutput.length > 0) {
            options.writeDedicated(dedicatedOutput);
          }
          options.onExit();
          return { consume: true };
        }

        if (isKeyRelease(token)) {
          continue;
        }

        if (options.keybindings.dispatch(token)) {
          continue;
        }

        if (isModeToggle(token, options.keybindings)) {
          if (dedicatedOutput.length > 0) {
            options.writeDedicated(dedicatedOutput);
            dedicatedOutput = "";
          }
          mode = options.toggleMode(mode);
          options.onModeChange(mode);
          continue;
        }

        if (options.routeFleetInput?.(token)) {
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

export function parseSgrMouseInput(token: string): SgrMouseInput | null {
  const match = SGR_MOUSE_PATTERN.exec(token);
  if (match === null) {
    return null;
  }

  const buttonCode = Number.parseInt(match[1] ?? "", 10);
  const column = Number.parseInt(match[2] ?? "", 10);
  const row = Number.parseInt(match[3] ?? "", 10);
  const final = match[4] as "M" | "m";
  if (!isValidCoordinate(column) || !isValidCoordinate(row) || !Number.isSafeInteger(buttonCode)) {
    return null;
  }

  return {
    buttonCode,
    column,
    final,
    raw: token,
    row,
    wheelDirection: getWheelDirection(buttonCode),
  };
}

export function encodeSgrMouseInput(event: SgrMouseInput, coords?: { readonly column?: number; readonly row?: number }): string {
  const column = coords?.column ?? event.column;
  const row = coords?.row ?? event.row;
  if (!isValidCoordinate(column) || !isValidCoordinate(row)) {
    return event.raw;
  }

  return `\x1b[<${event.buttonCode};${column};${row}${event.final}`;
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
  const exitKeys = new Set(deps.exitKeys);
  const modeToggleKeys = new Set(deps.modeToggleKeys);
  const registeredKeybindings = [...deps.registeredKeybindings ?? []];

  return {
    exitKeys,
    modeToggleKeys,
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

export function assertInputContract(keybindings: InputKeybindingConfig): void {
  assertNoDuplicateKeybindings(keybindings);
}

export function createProgrammaticInput(ptyHost: PtyHost, profile: ProgrammaticInputProfile): ProgrammaticInput {
  return {
    sendMessage(text, opts) {
      const policy = resolvePolicy(profile, opts);
      const appliedPolicy = applyMessagePolicy(text, policy);
      writeAppliedMessagePolicy(ptyHost, appliedPolicy);
    },

    sendKeys(data) {
      ptyHost.write(data);
    },

    sendCommand(line) {
      assertSingleLineCommand(line);
      const policy = resolvePolicy(profile);
      const appliedPolicy = applyMessagePolicy(line, policy);
      writeAppliedMessagePolicy(ptyHost, appliedPolicy);
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

function clampLayout(layout: InputRouterLayout): InputRouterLayout {
  return {
    columns: Math.max(0, Math.floor(layout.columns)),
    dedicatedRows: Math.max(0, Math.floor(layout.dedicatedRows)),
    fleetRows: Math.max(0, Math.floor(layout.fleetRows)),
    totalRows: Math.max(0, Math.floor(layout.totalRows)),
  };
}

function getWheelDirection(buttonCode: number): MouseWheelDirection | null {
  if (buttonCode === SGR_MOUSE_WHEEL_UP) {
    return "up";
  }

  if (buttonCode === SGR_MOUSE_WHEEL_DOWN) {
    return "down";
  }

  return null;
}

function isValidCoordinate(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function routeMouseInput<TMode extends string>(event: SgrMouseInput, options: InputRouterOptions<TMode>): boolean {
  const layoutProvider = options.getLayout;
  if (layoutProvider === undefined) {
    return false;
  }

  const layout = clampLayout(layoutProvider());
  if (event.column > layout.columns || event.row > layout.totalRows || event.row < 1 || event.column < 1) {
    return true;
  }

  if (event.row <= layout.dedicatedRows) {
    return options.routeDedicatedMouse?.({
      ...event,
      localColumn: event.column,
      localRow: event.row,
    }) ?? true;
  }

  if (event.row <= layout.dedicatedRows + layout.fleetRows) {
    return options.routeFleetMouse?.({
      ...event,
      localColumn: event.column,
      localRow: event.row - layout.dedicatedRows,
    }) ?? true;
  }

  return true;
}

function isKeyRelease(data: string): boolean {
  return data === "";
}

function isHostExit(data: string, keybindings: InputKeybindingConfig): boolean {
  return keybindings.exitKeys.has(data);
}

function isModeToggle(data: string, keybindings: InputKeybindingConfig): boolean {
  return keybindings.modeToggleKeys.has(data);
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

function assertNoDuplicateKeybindings(keybindings: InputKeybindingConfig): void {
  const keys = [
    ...keybindings.exitKeys,
    ...keybindings.modeToggleKeys,
    ...keybindings.registeredKeybindings.map((binding) => binding.key),
  ];
  if (new Set(keys).size !== keys.length) {
    throw new Error("Dedicated Harness input keybindings must not conflict");
  }
}

function resolvePolicy(
  profile: ProgrammaticInputProfile,
  opts: {
    readonly bracketedPaste?: boolean;
    readonly lineTerminator?: string;
    readonly multilineStrategy?: "literal" | "paste-mode";
  } = {},
): Required<CliMessagePolicy> {
  return {
    bracketedPaste: opts.bracketedPaste ?? profile.messagePolicy?.bracketedPaste ?? DEFAULT_BRACKETED_PASTE,
    lineTerminator: opts.lineTerminator ?? profile.messagePolicy?.lineTerminator ?? DEFAULT_LINE_TERMINATOR,
    multilineStrategy: opts.multilineStrategy ?? profile.messagePolicy?.multilineStrategy ?? DEFAULT_MULTILINE_STRATEGY,
  };
}

function applyMessagePolicy(
  text: string,
  policy: Required<CliMessagePolicy>,
): AppliedMessagePolicy {
  const usePasteMode = policy.bracketedPaste || (policy.multilineStrategy === "paste-mode" && LINE_BREAK_PATTERN.test(text));

  if (!usePasteMode) {
    return { payload: `${text}${policy.lineTerminator}` };
  }

  return {
    payload: `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`,
    submit: policy.lineTerminator,
  };
}

function writeAppliedMessagePolicy(ptyHost: PtyHost, appliedPolicy: AppliedMessagePolicy): void {
  ptyHost.write(appliedPolicy.payload);

  if (appliedPolicy.submit !== undefined && appliedPolicy.submit.length > 0) {
    ptyHost.write(appliedPolicy.submit);
  }
}

function assertSingleLineCommand(line: string): void {
  if (LINE_BREAK_PATTERN.test(line)) {
    throw new Error("Programmatic command must be a single line.");
  }
}
