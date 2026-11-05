import * as React from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";
import { TerminalSurface, type TerminalSurfaceProps } from "../terminal/shared/index.js";
import { CaptionActionButton } from "../../../workspace/client/components/caption-actions.js";
import { ConversationPill } from "../../../workspace/client/conversation/pill-takeover.js";
import { launchProviderGlyph } from "../../../ai-gateway/client/components/launch-provider-glyphs.js";
import { theaterLabelOrNull } from "../../../commodore/client/theater-owner.js";
import { subscribeCommodoreList } from "../../../commodore/client/commodore-list.js";
import { getT } from "../agent/i18n/index.js";
import { closeStandaloneCli, endStandaloneCli, failStandaloneCli, focusStandaloneCli, takeStandaloneCliReturnFocus, useStandaloneCliState } from "./store.js";
import "./standalone-cli.css";

const STANDALONE_CLI_SESSION_ID = "standalone-cli";
const STANDALONE_CLI_TICKET_PATH = "/api/v1/standalone-cli/ticket";
const TERMINAL_WS_PATH = "/api/v1/terminal/ws";

/**
 * 가운데 칸 위에 서는 독립 Claude Code CLI. 지휘관이 CLI 화면이던 때의 칸과 같은 틀이다 — 맨 위 줄의 pill,
 * 그 밑으로 칸 전체를 채운 터미널. 닫으면 칸 밑에 그대로 있던 대화가 다시 보인다.
 *
 * 닫아도 걷지 않는다: 숨긴 채 크기를 유지해 터미널이 격자·화면·스크롤·입력 줄을 그대로 쥐고, PTY 소켓도 붙어 있다.
 */
export function StandaloneCliLayer({ language, theme, shortcutLabel }: {
  readonly language: ConsoleLocale;
  readonly theme: NonNullable<TerminalSurfaceProps["theme"]>;
  /** 여닫는 단축키의 표기. 닫기 단추의 이름표와 Theater 안내가 쓴다. */
  readonly shortcutLabel: string;
}) {
  const t = getT(language);
  const view = useStandaloneCliState();
  const placement = view.placement;
  const theaterLabel = React.useSyncExternalStore(
    subscribeCommodoreList,
    () => (placement ? theaterLabelOrNull(placement.commodoreId, placement.theaterId) : null),
    () => null,
  );
  const ticketFields = React.useMemo(
    () => (placement ? { commodoreId: placement.commodoreId, theaterId: placement.theaterId } : undefined),
    [placement],
  );
  // 열기 전 포커스(스토어가 열기 직전에 붙잡음)를 닫으면 그 자리(보던 대화의 입력창 등)로 돌려준다.
  const layerRef = React.useRef<HTMLDivElement | null>(null);
  const wasOpenRef = React.useRef(view.open);
  React.useLayoutEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = view.open;
    if (view.open || !wasOpen) return;
    const layer = layerRef.current;
    const target = takeStandaloneCliReturnFocus();
    if (layer?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [view.open]);

  if (placement === null && !view.needsTheater) return null;
  const close = () => closeStandaloneCli();
  const generation = view.generation;
  return (
    <div
      ref={layerRef}
      className={`standalone-cli-layer${view.open ? " is-open" : ""}`}
      data-standalone-cli={view.open ? "open" : "hidden"}
      role="region"
      aria-label={t("terminal.standaloneCli.aria")}
      aria-hidden={view.open ? undefined : true}
      inert={view.open ? undefined : true}
    >
      <div className="conversation-column">
        <div className="conversation-pill-row">
          <ConversationPill
            takeover={null}
            label={t("terminal.standaloneCli.aria")}
            // pill 은 이름표다 — 누르면 입력이 터미널로 돌아간다.
            onPress={focusStandaloneCli}
            controls={(
              <CaptionActionButton label={t("terminal.standaloneCli.close", { shortcut: shortcutLabel })} actionId="standalone-cli-close" onClick={close}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              </CaptionActionButton>
            )}
          >
            <span className="conversation-pill-surface-mark" aria-hidden="true">{launchProviderGlyph("claude")}</span>
            <span className="conversation-pill-title">{t("terminal.standaloneCli.title")}</span>
            {theaterLabel ? <span className="conversation-pill-sub" data-standalone-cli-theater="">· {theaterLabel}</span> : null}
          </ConversationPill>
        </div>
        <div className="conversation-body">
          {placement !== null ? (
            <div className="conversation-body-slot">
              <div className="agent-stream-host">
                <TerminalSurface
                  key={generation}
                  objectiveId={STANDALONE_CLI_SESSION_ID}
                  ticketPath={STANDALONE_CLI_TICKET_PATH}
                  {...(ticketFields ? { ticketFields } : {})}
                  wsPath={TERMINAL_WS_PATH}
                  active={view.open}
                  visible={view.open}
                  keyboardFocusRequestId={view.focusRequest}
                  // 숨겼다 다시 열면 보던 자리(스크롤)로 돌아온다 — 바닥 추적을 다시 걸지 않는다.
                  keepScrollOnActivate
                  theme={theme}
                  locale={language}
                  onExit={() => endStandaloneCli(generation)}
                  onUnavailable={() => failStandaloneCli(generation)}
                />
              </div>
            </div>
          ) : (
            <div className="conversation-empty" role="status">
              <strong>{t("terminal.standaloneCli.selectTheaterTitle")}</strong>
              <span>{t("terminal.standaloneCli.selectTheaterBody", { shortcut: shortcutLabel })}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
