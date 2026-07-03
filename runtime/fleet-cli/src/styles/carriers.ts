export const PROVIDER_RGBS: Record<string, readonly [number, number, number]> = {
  claude: [255, 149, 0],
  codex: [169, 169, 169],
  "opencode-go": [0, 200, 160],
  cursor: [0, 122, 204],
};

const PROVIDER_BG_RGBS: Record<string, readonly [number, number, number]> = {
  claude: [40, 25, 8],
  codex: [35, 35, 35],
  "opencode-go": [8, 32, 28],
  cursor: [10, 25, 41],
};

export const PROVIDER_ANSI_COLORS: Record<string, string> = mapAnsi(PROVIDER_RGBS, rgb);
export const PROVIDER_BG_ANSI_COLORS: Record<string, string> = mapAnsi(PROVIDER_BG_RGBS, bgRgb);

export const SUBAGENT_PRESENTATION_RGB: readonly [number, number, number] = [216, 100, 168];
export const SUBAGENT_PRESENTATION_ANSI = rgb(...SUBAGENT_PRESENTATION_RGB);
export const SUBAGENT_PRESENTATION_BG_ANSI = bgRgb(30, 14, 26);

export const TASKFORCE_BADGE_RGB: [number, number, number] = [100, 180, 255];
export const TASKFORCE_BADGE_COLOR = rgb(...TASKFORCE_BADGE_RGB);

export function getCarrierAnsi(cliType: string): string {
  return PROVIDER_ANSI_COLORS[cliType] ?? "";
}

export function getCarrierBgAnsi(cliType: string): string | undefined {
  return PROVIDER_BG_ANSI_COLORS[cliType];
}

function mapAnsi(
  values: Record<string, readonly [number, number, number]>,
  formatter: (r: number, g: number, b: number) => string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([cliType, [r, g, b]]) => [cliType, formatter(r, g, b)]),
  );
}

function rgb(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bgRgb(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}
