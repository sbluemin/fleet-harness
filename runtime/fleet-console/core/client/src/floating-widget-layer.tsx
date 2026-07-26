import { useMemo } from "react";
import type { FloatingWidgetContext, FloatingWidgetDescriptor } from "@fleet-console/sdk/floating";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";

import { useConsoleLocale } from "./i18n/index.js";
import { createHostCapabilities } from "./plugin-capabilities.js";
import { usePluginRegistry } from "./plugin-registry.js";

export function FloatingWidgetLayer() {
  const { floatingWidgets } = usePluginRegistry();
  const language = useConsoleLocale();
  const capabilities = useMemo(() => createHostCapabilities(), []);
  const context = useMemo<FloatingWidgetContext>(() => ({
    api: capabilities.api,
    lifecycle: capabilities.lifecycle,
    preferences: capabilities.preferences,
    language,
  }), [capabilities, language]);

  if (floatingWidgets.length === 0) return null;

  return (
    <div className="floating-widget-layer">
      {floatingWidgets.map((descriptor) => (
        <div key={descriptor.id} className="floating-widget">
          <PluginErrorBoundary>
            <FloatingWidget descriptor={descriptor} context={context} />
          </PluginErrorBoundary>
        </div>
      ))}
    </div>
  );
}

function FloatingWidget({ descriptor, context }: {
  readonly descriptor: FloatingWidgetDescriptor;
  readonly context: FloatingWidgetContext;
}) {
  return <>{descriptor.render(context)}</>;
}
