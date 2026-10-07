import { React, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import { CaptionComputerUseGlyph, CaptionConsoleUseGlyph } from "@fleet-console/sdk/components/caption-actions";
import { ChatSurfaceContext, HeadAction, MoreIcon } from "./head-action.js";
import { ChatCard, MenuRow } from "./chat-card.js";
import { getT } from "./scuttlebutt-catalog.js";
import type { AdmiralId, ChatSession } from "./chat-session.js";
import { isComputerUseExperimentEnabled, isConsoleReadEnabled, subscribeConsoleRead } from "./console-read.js";
import { GrantLine } from "./grant-chips.js";
import { showScuttlebuttConversation, readScuttlebuttMentionBridge, subscribeScuttlebuttMentions } from "./mention-bridge.js";
import { getScuttlebuttSettings, subscribeScuttlebuttSettings, writeAideGrants } from "./settings-store.js";

/** 세션 소유권은 무리에 남는다. 레인·모달을 닫아도 대화 스트림을 닫지 않는다. */
export function QuickLaunchConversation({ admiral }: { readonly admiral: AdmiralId }) {
  const bridge = useStoreSnapshot(subscribeScuttlebuttMentions, readScuttlebuttMentionBridge);
  const session = bridge?.session(admiral);
  return session ? <Conversation key={admiral} admiral={admiral} session={session} /> : null;
}

const noop = () => undefined;

function Conversation({ admiral, session }: { readonly admiral: AdmiralId; readonly session: ChatSession }) {
  React.useLayoutEffect(() => showScuttlebuttConversation(admiral), [admiral]);
  const chat = useStoreSnapshot(session.subscribe, session.snapshot);
  const settings = useStoreSnapshot(subscribeScuttlebuttSettings, getScuttlebuttSettings);
  const bridge = readScuttlebuttMentionBridge();
  const [extensions, setExtensions] = React.useState(() => ({ consoleUse: isConsoleReadEnabled(), computerUse: isComputerUseExperimentEnabled() }));
  React.useEffect(() => subscribeConsoleRead(() => setExtensions({ consoleUse: isConsoleReadEnabled(), computerUse: isComputerUseExperimentEnabled() })), []);
  return <ChatCard
    embedded
    admiral={admiral}
    state={chat.state}
    draft={chat.draft}
    mascot={{ current: null }}
    moored={false}
    docked={false}
    canDock={false}
    grants={settings.grants[admiral]}
    extensions={extensions}
    onGrantChange={(patch) => { void writeAideGrants(admiral, patch).catch(noop); }}
    onDock={noop}
    onUndock={noop}
    onAsk={(text) => { void session.ask(text); }}
    onRetry={() => { void session.retry(); }}
    onStop={() => { void session.stop(); }}
    onClear={session.clear}
    onHandoff={(text) => bridge?.handoff(text)}
    onDraftChange={session.setDraft}
    onToggleMoored={noop}
    onClose={noop}
    onTuck={noop}
    locale={bridge?.locale()}
    positionRevision={0}
  />;
}

export function QuickLaunchGrants({ admiral }: { readonly admiral: AdmiralId }) {
  const settings = useStoreSnapshot(subscribeScuttlebuttSettings, getScuttlebuttSettings);
  const bridge = useStoreSnapshot(subscribeScuttlebuttMentions, readScuttlebuttMentionBridge);
  const t = getT(bridge?.locale());
  const grants = settings.grants[admiral];
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLSpanElement>(null);
  const [extensions, setExtensions] = React.useState(() => ({ consoleUse: isConsoleReadEnabled(), computerUse: isComputerUseExperimentEnabled() }));
  React.useEffect(() => subscribeConsoleRead(() => setExtensions({ consoleUse: isConsoleReadEnabled(), computerUse: isComputerUseExperimentEnabled() })), []);
  React.useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const rows = [
    extensions.consoleUse ? { id: "console", key: "consoleUse" as const, glyph: <CaptionConsoleUseGlyph />, name: t("menu.consoleUse"), hint: t(grants.consoleUse ? "menu.consoleUseOn" : "menu.consoleUseOff") } : null,
    extensions.computerUse ? { id: "computer", key: "computerUse" as const, glyph: <CaptionComputerUseGlyph />, name: t("menu.computerUse"), hint: t(grants.computerUse ? "menu.computerUseOn" : "menu.computerUseOff") } : null,
  ].filter((row) => row !== null);
  return <ChatSurfaceContext.Provider value="composer">
    <span ref={rootRef} className="scuttlebutt-quick-launch-grants" onKeyDown={(event) => {
      if (event.key !== "Escape" || !open) return;
      event.stopPropagation();
      setOpen(false);
      rootRef.current?.querySelector<HTMLButtonElement>(".scuttlebutt-head-action")?.focus();
    }}>
      <GrantLine responsive grants={grants} locale={bridge?.locale()} onOpenMenu={() => setOpen(true)} />
      <span className="scuttlebutt-head-slot">
        <HeadAction id={`scuttlebutt-more-${admiral}`} label={t("menu.more")} hint={t("menu.more.hint")} icon={<MoreIcon />} pressed={open} quiet={open} onClick={() => setOpen((value) => !value)} />
        {open ? <div className="scuttlebutt-menu is-upward" data-scuttlebutt-surface="composer" role="menu" aria-label={t("menu.aiExtensions")}>
          <div className="scuttlebutt-menu-label">{t("menu.aiExtensions")}</div>
          {rows.length === 0 ? <div className="scuttlebutt-menu-hint">{t("menu.experimentOff")}</div> : rows.map((row) => <MenuRow key={row.id} id={`scuttlebutt-menu-${admiral}-${row.id}`} item={row.id} name={row.name} hint={row.hint} glyph={row.glyph} checked={grants[row.key]} onToggle={() => { void writeAideGrants(admiral, { [row.key]: !grants[row.key] }).catch(noop); }} />)}
        </div> : null}
      </span>
    </span>
  </ChatSurfaceContext.Provider>;
}
