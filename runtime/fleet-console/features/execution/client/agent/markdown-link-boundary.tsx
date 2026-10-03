import { createContext, useContext, useEffect, useRef, type MouseEventHandler, type ReactNode } from "react";
import type { RenderMarkdownOptions } from "@fleet-console/markdown/core";
import { bindMarkdownLinkActivation, type MarkdownLinkActivation } from "@fleet-console/markdown/link-activation";

const LinkResolverContext = createContext<RenderMarkdownOptions["resolveLink"]>(undefined);

export function useMarkdownLinkResolver() {
  return useContext(LinkResolverContext);
}

export function MarkdownLinkBoundary({ resolveLink, onActivate, className, onClick, children }: {
  readonly resolveLink: RenderMarkdownOptions["resolveLink"];
  readonly onActivate: MarkdownLinkActivation;
  readonly className?: string;
  readonly onClick?: MouseEventHandler<HTMLDivElement>;
  readonly children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current ? bindMarkdownLinkActivation(root.current, onActivate) : undefined, [onActivate]);
  return <LinkResolverContext.Provider value={resolveLink}><div ref={root} className={className} onClick={onClick}>{children}</div></LinkResolverContext.Provider>;
}
