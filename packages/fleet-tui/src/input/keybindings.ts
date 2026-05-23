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

export function isKeyRelease(data: string): boolean {
  return data === "";
}

export function isHostExit(data: string, keybindings: InputKeybindingConfig): boolean {
  return keybindings.exitKeys.has(data);
}

export function isModeToggle(data: string, keybindings: InputKeybindingConfig): boolean {
  return keybindings.modeToggleKeys.has(data);
}

export function legacyToCsiU(legacyKey: string): string | undefined {
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

export function createCsiUNormalizationMap(
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
