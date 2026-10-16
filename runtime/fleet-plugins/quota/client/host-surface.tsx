import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HostSurfaceContext, HostSurfaceDescriptor } from "@fleet-console/sdk/host-context";
import { PROVIDER_ORDER_DEFAULT } from "../provider-order.js";
import { providerGlyph } from "./cli-glyphs.js";
import { PROVIDER_NAME, QuotaPanelView, useQuotaData, windowLabel, type QuotaDataScope, type RememberedPanel } from "./quota-panel.js";
import { placePopover, toolbarReadings } from "./toolbar-summary.js";
import { getT } from "./i18n/index.js";
import "./host-surface.css";

/** 원격 수집·캐시는 명시 scope에 한정하고 로컬 install/login 상태는 읽지 않는다. */
function HostQuota({ context }: { readonly context: HostSurfaceContext }) {
  const scope = useMemo<QuotaDataScope>(() => ({
    signal: context.transport.scope.signal,
    read: () => context.state.read<RememberedPanel | null>("quota", null),
    write: (value) => context.state.write("quota", value),
  }), [context]);
  const state = useQuotaData(context.api, scope);
  const t = getT(context.language);
  const source = { hostKey: context.selection.hostKey, label: context.hostLabel, caption: t("quota.host.source") };
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const titleId = `${popupId}-title`;
  const [placement, setPlacement] = useState<ReturnType<typeof placePopover> | null>(null);
  const readings = toolbarReadings(state.data, PROVIDER_ORDER_DEFAULT).filter((reading) => reading.lines.length > 0);
  const stale = state.data !== null && (!state.validated || state.requestError || Object.values(state.data.providers).some((provider) => provider?.status === "stale"));
  const summary = readings.length === 0 ? t("quota.toolbar.empty") : readings.map((reading) => t("quota.toolbar.reading", {
    provider: PROVIDER_NAME[reading.id],
    windows: reading.lines.map((window) => `${windowLabel(window, t)} ${t("quota.meter.used", { pct: Math.round(window.usedPercent) })}`).join(" · "),
  })).join(" / ");
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus && !scope.signal.aborted) trigger.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (trigger.current) setPlacement(placePopover(trigger.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (trigger.current) observer?.observe(trigger.current);
    return () => { observer?.disconnect(); window.removeEventListener("resize", place); document.removeEventListener("scroll", place, true); };
  }, [open]);
  const placed = placement !== null;
  useEffect(() => {
    const stop = () => setOpen(false);
    scope.signal.addEventListener("abort", stop, { once: true });
    return () => scope.signal.removeEventListener("abort", stop);
  }, [scope]);
  useEffect(() => {
    if (!open || !placed) return;
    popup.current?.focus({ preventScroll: true });
    const pointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || popup.current?.contains(event.target) || trigger.current?.contains(event.target)) return;
      close(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("keydown", keyboard); };
  }, [open, placed, scope]);

  return <>
    <button ref={trigger} type="button" disabled={scope.signal.aborted} className="quota-toolbar-summary host-quota-button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined}
      aria-label={`${context.hostLabel} · ${t("quota.panel.title")} · ${summary}${stale ? ` · ${t("quota.host.cached")}` : ""}`} title={`${source.caption} ${summary}`}
      data-host-key={context.selection.hostKey} data-stale={stale} onClick={() => setOpen((value) => !value)}>
      <span className="host-quota-source">{context.hostLabel}</span>
      <span className="host-quota-readings" aria-hidden="true">
        {readings.length === 0 ? <span>{t("quota.panel.title")} —</span> : readings.map((reading) => <span key={reading.id} className="quota-toolbar-summary__cell">
          <span className="quota-toolbar-summary__mark">{providerGlyph(reading.id)}</span>
          <span className="quota-toolbar-summary__lines">{reading.lines.map((window, index) => <span className="quota-toolbar-summary__pct" key={`${window.id}-${index}`}>{Math.round(window.usedPercent)}%</span>)}</span>
        </span>)}
      </span>
      {stale ? <span className="host-quota-cached">{t("quota.host.cached")}</span> : null}
    </button>
    {open ? createPortal(<div ref={popup} id={popupId} className="quota-popover host-quota-popover" role="dialog" aria-labelledby={titleId} tabIndex={-1}
      data-host-key={context.selection.hostKey} style={placement ? { left: placement.left, width: placement.width, maxHeight: placement.maxHeight, ...(placement.top !== undefined ? { top: placement.top } : { bottom: placement.bottom }) } : { visibility: "hidden" }}>
      <QuotaPanelView api={context.api} locale={context.language} labelId={titleId} scope={scope} source={source} state={state} />
    </div>, document.body) : null}
  </>;
}

export const hostQuotaSurface: HostSurfaceDescriptor = {
  id: "quota", slot: "quota", render: (context) => <HostQuota context={context} />,
};
