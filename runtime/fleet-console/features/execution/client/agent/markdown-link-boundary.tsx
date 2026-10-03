import { createContext, useContext, useEffect, useRef, type MouseEventHandler, type ReactNode } from "react";
import type { RenderMarkdownOptions } from "@fleet-console/markdown/core";
import { bindMarkdownLinkActivation, type MarkdownLinkActivation } from "@fleet-console/markdown/link-activation";

const LinkResolverContext = createContext<RenderMarkdownOptions["resolveLink"]>(undefined);

export function useMarkdownLinkResolver() {
  return useContext(LinkResolverContext);
}

export function MarkdownLinkBoundary({ resolveLink, onActivate, className, onClick, onAuxClick, fleetLink, children }: {
  readonly resolveLink: RenderMarkdownOptions["resolveLink"];
  readonly onActivate: MarkdownLinkActivation;
  readonly className?: string;
  readonly onClick?: MouseEventHandler<HTMLDivElement>;
  /** 가운데 클릭은 click이 아니라 auxclick으로만 온다 — 뒤 탭 손짓을 받으려면 따로 건다. */
  readonly onAuxClick?: MouseEventHandler<HTMLDivElement>;
  /** 문서 링크 라우터 예외 표식(`data-fleet-link`). 자체 카드로 묻는 영역은 "self". */
  readonly fleetLink?: "self" | "native";
  readonly children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current ? bindMarkdownLinkActivation(root.current, onActivate) : undefined, [onActivate]);
  return <LinkResolverContext.Provider value={resolveLink}><div ref={root} className={className} onClick={onClick} onAuxClick={onAuxClick} data-fleet-link={fleetLink}>{children}</div></LinkResolverContext.Provider>;
}
