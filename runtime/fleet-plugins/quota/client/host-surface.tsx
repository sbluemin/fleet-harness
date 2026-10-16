import { useMemo } from "react";
import type { HostSurfaceContext, HostSurfaceDescriptor } from "@fleet-console/sdk/host-context";
import { QuotaPanel, type QuotaDataScope, type RememberedPanel } from "./quota-panel.js";
import { getT } from "./i18n/index.js";

function HostQuota({ context }: { readonly context: HostSurfaceContext }) {
  const scope = useMemo<QuotaDataScope>(() => ({
    signal: context.transport.scope.signal,
    read: () => context.state.read<RememberedPanel | null>("quota", null),
    write: (value) => context.state.write("quota", value),
  }), [context]);
  return <QuotaPanel api={context.api} locale={context.language} labelId="host-quota-title" scope={scope}
    source={{ hostKey: context.selection.hostKey, label: context.hostLabel, caption: getT(context.language)("quota.host.source") }} />;
}

export const hostQuotaSurface: HostSurfaceDescriptor = {
  id: "quota", slot: "quota", render: (context) => <HostQuota context={context} />,
};
