import * as React from "react";
import type { OpenUIOpenPort } from "@fleet-console/markdown/openui";
import { openInDefaultOsBrowser } from "@fleet-console/link/core";
import type { ConsoleLocale } from "@fleet-console/i18n";
import { LinkOpenCard, type LinkOpenAt } from "../../../browser/client/link-open-card.js";
import { useBrowserEngine } from "../../../browser/client/browser-panel-store.js";

/** Operation의 링크 선택기를 그대로 건넨다. 모델 출력·DOM 속성은 이 권한을 만들지 않는다. */
export const OpenUIHttpsContext = React.createContext<((url: string, at: LinkOpenAt) => boolean) | null>(null);
export const OpenUINavigationContext = React.createContext<OpenUIOpenPort | null>(null);
export function useOpenUIOpenPort(): OpenUIOpenPort | null {
  const https = React.useContext(OpenUIHttpsContext);
  const navigation = React.useContext(OpenUINavigationContext);
  return React.useMemo(() => https || navigation ? {
    accepts: (target) => target.kind === "https" ? https !== null : navigation?.accepts(target) === true,
    open: (target, at) => {
      if (target.kind === "https") { if (https && !https(target.url, at)) openInDefaultOsBrowser(target.url); }
      else if (navigation?.accepts(target)) navigation.open(target, at);
    },
  } : null, [https, navigation]);
}

/** Operation이 없는 플러그인 원장도 기존 링크 카드를 쓴다. Operation 브라우저 행만 없다. */
export function OpenUIPluginBoundary({ port, language, children }: { readonly port?: OpenUIOpenPort | undefined; readonly language: ConsoleLocale; readonly children: React.ReactNode }) {
  const inherited = React.useContext(OpenUIHttpsContext);
  const engine = useBrowserEngine();
  const [pending, setPending] = React.useState<{ url: string; at: LinkOpenAt } | null>(null);
  const choose = React.useCallback((url: string, at: LinkOpenAt) => {
    if (engine !== null && !engine.available) { openInDefaultOsBrowser(url); return true; }
    setPending({ url, at });
    return true;
  }, [engine]);
  const close = React.useCallback(() => setPending(null), []);
  return <OpenUIHttpsContext.Provider value={inherited ?? choose}><OpenUINavigationContext.Provider value={port ?? null}>{children}
    {pending ? <LinkOpenCard language={language} url={pending.url} at={pending.at} onClose={close} /> : null}
  </OpenUINavigationContext.Provider></OpenUIHttpsContext.Provider>;
}
