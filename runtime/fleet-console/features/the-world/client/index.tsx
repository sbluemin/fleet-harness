import { FeatureErrorBoundary } from "@fleet-console/ui/react";
import { lazy, Suspense } from "react";

import type { ClientFeatureDescriptor } from "../../workspace/shared/feature-surfaces.js";
import type { TheWorldClientDeps } from "./deps.js";
import { PortalDockEntry } from "./surfaces/portal-dock-entry.js";
import "./the-world.css";
import { enterTheWorld, exitTheWorld, getWorldStoreSnapshot, useWorldStore } from "./world-store.js";

export const THE_WORLD_PLUGIN_ID = "the-world";

const LazyWorldStage = lazy(() => import("./surfaces/world-stage.js"));

export interface TheWorldClient {
  readonly descriptor: ClientFeatureDescriptor;
  readonly Layer: () => React.JSX.Element | null;
  readonly toggleShortcut: () => boolean;
}

export function createTheWorldClient(deps: TheWorldClientDeps): TheWorldClient {
  const descriptor: ClientFeatureDescriptor = {
    id: THE_WORLD_PLUGIN_ID,
    sidebarFooterEntries: [
      {
        id: "portal",
        render: () => <PortalDockEntry deps={deps} />,
      },
    ],
  };

  function Layer() {
    const store = useWorldStore();
    if (store.lifecycle === "closed") return null;
    return (
      <FeatureErrorBoundary fallback={null}>
        <Suspense fallback={null}>
          <LazyWorldStage deps={deps} />
        </Suspense>
      </FeatureErrorBoundary>
    );
  }

  function toggleShortcut(): boolean {
    const current = getWorldStoreSnapshot().lifecycle;
    if (current === "closed") {
      enterTheWorld({ reducedMotion: deps.isReducedMotion() });
      return true;
    }
    if (current === "open") {
      exitTheWorld({ reducedMotion: deps.isReducedMotion() });
      return true;
    }
    return false;
  }

  return { descriptor, Layer, toggleShortcut };
}
