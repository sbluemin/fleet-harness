import { React, useStoreSnapshot } from "@fleet-console/sdk/plugin/browser";

import { ChatSurfaceContext } from "./head-action.js";
import { ChatCard } from "./chat-card.js";
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
  return <ChatSurfaceContext.Provider value="composer"><GrantLine responsive grants={settings.grants[admiral]} locale={bridge?.locale()} /></ChatSurfaceContext.Provider>;
}
