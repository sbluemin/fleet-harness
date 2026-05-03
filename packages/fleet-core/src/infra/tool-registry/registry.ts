import type { ToolPromptManifest } from "./types.js";

interface ToolPromptManifestRegistryState {
  order: string[];
  entries: Map<string, ToolPromptManifest>;
}

const TOOL_PROMPT_MANIFEST_REGISTRY_KEY = "__pi_tool_prompt_manifest_registry__";
const TOOL_PROMPT_MANIFEST_ID_PATTERN = /^[a-z0-9_]+$/;

function getRegistryState(): ToolPromptManifestRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [TOOL_PROMPT_MANIFEST_REGISTRY_KEY]?: ToolPromptManifestRegistryState;
  };

  if (!globalState[TOOL_PROMPT_MANIFEST_REGISTRY_KEY]) {
    globalState[TOOL_PROMPT_MANIFEST_REGISTRY_KEY] = {
      order: [],
      entries: new Map<string, ToolPromptManifest>(),
    };
  }

  return globalState[TOOL_PROMPT_MANIFEST_REGISTRY_KEY]!;
}

function assertManifestId(value: string, field: "id" | "tag"): void {
  if (!TOOL_PROMPT_MANIFEST_ID_PATTERN.test(value)) {
    throw new Error(`Invalid tool prompt manifest ${field}: "${value}"`);
  }
}

function assertUniqueTag(manifest: ToolPromptManifest, entries: Map<string, ToolPromptManifest>): void {
  for (const existing of entries.values()) {
    if (existing.id === manifest.id) continue;
    if (existing.tag === manifest.tag) {
      throw new Error(
        `Tool prompt manifest tag "${manifest.tag}" is already registered by "${existing.id}"`,
      );
    }
  }
}

export function registerToolPromptManifest(manifest: ToolPromptManifest): void {
  assertManifestId(manifest.id, "id");
  assertManifestId(manifest.tag, "tag");

  const state = getRegistryState();
  assertUniqueTag(manifest, state.entries);

  if (!state.entries.has(manifest.id)) {
    state.order.push(manifest.id);
  }

  state.entries.set(manifest.id, manifest);
}

export function getAllToolPromptManifests(): ToolPromptManifest[] {
  const state = getRegistryState();
  return state.order
    .map((id) => state.entries.get(id))
    .filter((manifest): manifest is ToolPromptManifest => manifest != null);
}
