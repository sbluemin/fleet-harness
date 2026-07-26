import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { ScuttlebuttMascot } from "./mascot.js";
import { scuttlebuttSettingsSection } from "./settings-section.js";
import { connectScuttlebuttSettings } from "./settings-store.js";
import "./styles.css";

export const scuttlebuttPlugin = definePlugin({
  id: "scuttlebutt",
  floatingWidgets: [{ id: "mascot", render: (context) => <ScuttlebuttMascot context={context} /> }],
  settingsSections: [scuttlebuttSettingsSection],
  install: (context) => connectScuttlebuttSettings(context.settings),
});

export const plugins = [scuttlebuttPlugin] as const;
