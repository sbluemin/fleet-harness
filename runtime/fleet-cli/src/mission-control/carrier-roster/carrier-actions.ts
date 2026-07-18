import type { CarrierStatusEntry } from "./types.js";

export type CarrierAction = "agent-cli" | "model" | "taskforce" | "rename" | "details";

const ACTION_LABELS: Readonly<Record<CarrierAction, string>> = {
  "agent-cli": "Agent CLI",
  model: "Model",
  taskforce: "Configure TaskForce",
  rename: "Rename Carrier",
  details: "Toggle Details",
};

export function getCarrierActions(entry: CarrierStatusEntry | null): readonly CarrierAction[] {
  if (!entry) return [];
  return entry.taskForceCapable
    ? ["agent-cli", "model", "taskforce", "rename", "details"]
    : ["agent-cli", "model", "rename", "details"];
}

export function getCarrierActionLabels(entry: CarrierStatusEntry | null): string[] {
  return getCarrierActions(entry).map((action) => ACTION_LABELS[action]);
}
