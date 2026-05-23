export type KeyboardProtocolMode = "standard" | "enhanced";

export type KeyboardProtocolState = {
  outerEnabled: boolean;
  childRequested: boolean;
  effectiveMode: "passthrough" | "transform";
};

export interface KeyboardProtocol {
  detectChildRequest(chunk: string): void;
  getState(): KeyboardProtocolState;
  transformInput(data: string): string;
}

export interface CsiUInputNormalizer {
  readonly normalize: (data: string) => string;
}

export interface CreateCsiUInputNormalizerDeps {
  readonly csiUMap: ReadonlyMap<string, string>;
}

export const KITTY_ENABLE = "\x1b[>4;2m\x1b[>1u";
export const KITTY_DISABLE = "\x1b[<u\x1b[>4;0m";
export const KITTY_ENABLE_REGEX = /\x1b\[>(?:\d+u|4;\d+m)/;

const SHIFT_ENTER_CSI_U = "\x1b[13;2u";
const BASIC_SHIFT_ENTER = "\n";

export function createCsiUInputNormalizer(deps: CreateCsiUInputNormalizerDeps): CsiUInputNormalizer {
  return {
    normalize(data): string {
      return normalizeCsiUInput(data, deps.csiUMap);
    },
  };
}

export function normalizeCsiUInput(data: string, csiUMap: ReadonlyMap<string, string>): string {
  let result = data;
  for (const [csiU, legacy] of csiUMap) {
    if (result.includes(csiU)) {
      result = result.replaceAll(csiU, legacy);
    }
  }
  return result;
}

export function createKeyboardProtocol(): KeyboardProtocol {
  let childRequested = false;
  const outerEnabled = true;

  return {
    detectChildRequest(chunk: string): void {
      if (KITTY_ENABLE_REGEX.test(chunk)) {
        childRequested = true;
      }
    },

    getState(): KeyboardProtocolState {
      return {
        outerEnabled,
        childRequested,
        effectiveMode: resolveEffectiveMode(outerEnabled, childRequested),
      };
    },

    transformInput(data: string): string {
      if (resolveEffectiveMode(outerEnabled, childRequested) !== "transform") {
        return data;
      }

      return data.split(SHIFT_ENTER_CSI_U).join(BASIC_SHIFT_ENTER);
    },
  };
}

function resolveEffectiveMode(outerEnabled: boolean, childRequested: boolean): KeyboardProtocolState["effectiveMode"] {
  return outerEnabled && !childRequested ? "transform" : "passthrough";
}
