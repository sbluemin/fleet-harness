export interface CsiUInputNormalizer {
  readonly normalize: (data: string) => string;
}

export interface CreateCsiUInputNormalizerDeps {
  readonly csiUMap: ReadonlyMap<string, string>;
}

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
