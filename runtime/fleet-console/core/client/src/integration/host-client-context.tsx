import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createBrowserLocalTransport } from "@fleet-console/sdk/host-context/browser";
import type { HostTransport } from "@fleet-console/sdk/host-context";
import type { PluginInstallContext } from "@fleet-console/sdk/plugin";

export interface HostClientBindings {
  readonly transport: HostTransport;
  /** 원격에는 이 host의 store/모델/이벤트만 주입한다. 로컬 store를 대체값으로 읽지 않는다. */
  readonly capabilities?: Partial<PluginInstallContext>;
}

const Context = createContext<HostClientBindings | null>(null);

export function HostClientProvider({ bindings, children }: { readonly bindings: HostClientBindings; readonly children: ReactNode }) {
  return <Context.Provider value={bindings}>{children}</Context.Provider>;
}

export function useHostClientBindings(): HostClientBindings {
  const bound = useContext(Context);
  // 단독 미리보기는 명시적인 로컬 인스턴스다. 앱은 루트에서 한 인스턴스를 공유한다.
  return useMemo(() => bound ?? { transport: createBrowserLocalTransport() }, [bound]);
}
