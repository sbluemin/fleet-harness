import * as React from "react";
import { createPortal } from "react-dom";

import type { ConsoleLocale } from "@fleet-console/i18n";
import { ChevronGlyph, MenuCheckGlyph, useSelect, type SelectOption } from "@fleet-console/ui/react";
import { launchProviderGlyph } from "../../../ai-gateway/client/components/launch-provider-glyphs.js";
import { useCommodoreList } from "../../../commodore/client/commodore-list.js";
import { TerminalSurface, type TerminalSurfaceProps } from "../terminal/shared/index.js";
import { getT } from "../agent/i18n/index.js";
import {
  closeStandaloneCliPalette,
  endStandaloneCli,
  failStandaloneCli,
  selectStandaloneCli,
  STANDALONE_CLI_KINDS,
  stopStandaloneCli,
  takeStandaloneCliReturnFocus,
  useStandaloneCliState,
  type StandaloneCliKind,
  type StandaloneCliPlacement,
} from "./store.js";
import "./standalone-cli.css";

const STANDALONE_CLI_TICKET_PATH = "/api/v1/standalone-cli/ticket";
const TERMINAL_WS_PATH = "/api/v1/terminal/ws";

function standaloneCliSessionId(cli: StandaloneCliKind): string {
  return `standalone-cli:${cli}`;
}

/** Antigravity 공식 제품 마크(단일 currentColor 경로, 커밋 1f7a0ab1b 기준). */
function AntigravityGlyph() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <path d="M85.2843 88.0301C90.1329 91.6664 97.4057 89.2422 90.7389 82.5755C70.7389 63.1816 74.9813 9.84827 50.1329 9.84827C25.2843 9.84827 29.5267 63.1816 9.52673 82.5755C2.25402 89.8483 10.1328 91.6664 14.9813 88.0301C33.7692 75.3028 32.5571 52.8786 50.1329 52.8786C67.7086 52.8786 66.4965 75.3028 85.2843 88.0301Z" fill="currentColor" />
    </svg>
  );
}

interface StandaloneCliTerminalPaneProps {
  readonly cli: StandaloneCliKind;
  readonly open: boolean;
  readonly placement: StandaloneCliPlacement;
  readonly generation: number;
  readonly focusRequest: number;
  readonly language: ConsoleLocale;
  readonly theme: NonNullable<TerminalSurfaceProps["theme"]>;
}

function StandaloneCliTerminalPane({
  cli,
  open,
  placement,
  generation,
  focusRequest,
  language,
  theme,
}: StandaloneCliTerminalPaneProps) {
  const ticketFields = React.useMemo(
    () => ({ cli, commodoreId: placement.commodoreId, theaterId: placement.theaterId }),
    [cli, placement.commodoreId, placement.theaterId],
  );
  return (
    <div
      className={`standalone-cli-pane${open ? " is-active" : ""}`}
      data-standalone-cli-pane={cli}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
    >
      <div className="conversation-column">
        <div className="conversation-body">
          <div className="conversation-body-slot">
            <div className="agent-stream-host">
              <TerminalSurface
                key={generation}
                objectiveId={standaloneCliSessionId(cli)}
                ticketPath={STANDALONE_CLI_TICKET_PATH}
                ticketFields={ticketFields}
                wsPath={TERMINAL_WS_PATH}
                active={open}
                visible={open}
                keyboardFocusRequestId={focusRequest}
                // 숨겼다 다시 열면 보던 자리(스크롤)로 돌아온다 — 바닥 추적을 다시 걸지 않는다.
                keepScrollOnActivate
                theme={theme}
                locale={language}
                onExit={() => endStandaloneCli(cli, generation)}
                onUnavailable={() => failStandaloneCli(cli, generation)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface TheaterChoice {
  readonly key: string;
  readonly label: string;
  readonly placement: StandaloneCliPlacement;
}

function StandaloneCliTheaterSelect({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
}) {
  const select = useSelect({ value, options, onChange });
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <div ref={select.rootRef} className={`${select.rootProps.className} fc-select--compact`}>
      <button {...select.triggerProps} aria-label={label}>
        <span className="fc-select__value">{selected?.label ?? ""}</span>
        <ChevronGlyph direction="down" className="fc-select__caret" />
      </button>
      {select.isOpen
        ? createPortal(
            <ul {...select.listboxProps} aria-label={label}>
              {options.map((option, index) => (
                <li key={option.value} {...select.getOptionProps(index)}>
                  {option.label}
                  <MenuCheckGlyph className="fc-select__check" size={14} />
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * 가운데 칸 위에 서는 독립 CLI(Claude Code · Antigravity) 층과 미니멀 선택 팔레트.
 * 상단 칩 없이 칸 전체를 채운 터미널이다(#2562). 닫아도 표면을 걷지 않아 PTY·스크롤백이 유지된다.
 */
export function StandaloneCliLayer({ language, theme, shortcutLabel }: {
  readonly language: ConsoleLocale;
  readonly theme: NonNullable<TerminalSurfaceProps["theme"]>;
  /** 여닫는 단축키의 표기. Theater 안내가 쓴다. */
  readonly shortcutLabel: string;
}) {
  const t = getT(language);
  const view = useStandaloneCliState();
  const commodores = useCommodoreList();

  const theaterChoices = React.useMemo<readonly TheaterChoice[]>(() => {
    const list: TheaterChoice[] = [];
    for (const commodore of commodores) {
      for (const theater of commodore.theaters) {
        if (theater.status !== "available") continue;
        list.push({
          key: `${commodore.commodoreId}:${theater.theaterId}`,
          label: `${theater.label} (${commodore.alias || commodore.label})`,
          placement: { commodoreId: commodore.commodoreId, theaterId: theater.theaterId },
        });
      }
    }
    return list;
  }, [commodores]);

  const [fallbackTheaterKey, setFallbackTheaterKey] = React.useState<string>("");
  React.useEffect(() => {
    if (theaterChoices.length === 0) {
      setFallbackTheaterKey("");
      return;
    }
    if (!theaterChoices.some((item) => item.key === fallbackTheaterKey)) {
      setFallbackTheaterKey(theaterChoices[0]!.key);
    }
  }, [theaterChoices, fallbackTheaterKey]);

  const fallbackPlacement = React.useMemo(
    () => theaterChoices.find((item) => item.key === fallbackTheaterKey)?.placement ?? null,
    [theaterChoices, fallbackTheaterKey],
  );

  const [activeIndex, setActiveIndex] = React.useState(0);
  const paletteCardRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!view.paletteOpen) return;
    const focusCli = view.activeCli ?? view.lastCli ?? "claude";
    setActiveIndex(focusCli === "antigravity" ? 1 : 0);
    paletteCardRef.current?.focus({ preventScroll: true });
  }, [view.paletteOpen, view.activeCli, view.lastCli]);

  // 열기 전 포커스를 패널·팔레트가 모두 닫히면 그 자리(보던 대화의 입력창 등)로 돌려준다.
  const layerRef = React.useRef<HTMLDivElement | null>(null);
  const isLayerOpen = view.activeCli !== null || view.needsTheater;
  const wasVisibleRef = React.useRef(isLayerOpen || view.paletteOpen);
  React.useLayoutEffect(() => {
    const visible = isLayerOpen || view.paletteOpen;
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (visible || !wasVisible) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (layerRef.current?.contains(active) || active.closest(".standalone-cli-palette-overlay"))) {
      active.blur();
    }
    const target = takeStandaloneCliReturnFocus();
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [isLayerOpen, view.paletteOpen]);

  const handlePaletteKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeStandaloneCliPalette();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % STANDALONE_CLI_KINDS.length);
      return;
    }
    if (event.key === "1") {
      event.preventDefault();
      void selectStandaloneCli("claude", fallbackPlacement);
      return;
    }
    if (event.key === "2") {
      event.preventDefault();
      void selectStandaloneCli("antigravity", fallbackPlacement);
      return;
    }
    if (event.key === "Enter") {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".fc-select, .fc-select__listbox, [data-standalone-cli-stop]")) return;
      event.preventDefault();
      const cli = STANDALONE_CLI_KINDS[activeIndex] ?? "claude";
      void selectStandaloneCli(cli, fallbackPlacement);
    }
  }, [activeIndex, fallbackPlacement]);

  // 사람이 손쓸 수 있는 몫만 — 로그인이 필요한 원격 MCP가 실린 전역 플러그인. 건너뛴 몫·변환은 전역 플러그인 화면이 보인다.
  const signInPlugins = view.antigravityPluginNotes.filter((note) => note.signIn?.length).map((note) => note.pluginId.slice(0, note.pluginId.lastIndexOf("@")));
  const agySignInNote = signInPlugins.length === 1
    ? t("terminal.standaloneCli.agySignInOne", { plugin: signInPlugins[0]! })
    : signInPlugins.length > 1 ? t("terminal.standaloneCli.agySignInMany", { n: signInPlugins.length }) : null;

  const hasMountedPane = STANDALONE_CLI_KINDS.some((cli) => view.slots[cli].placement !== null);
  const showFallbackTheater = view.viewed.theaterId === null && theaterChoices.length > 0;

  return (
    <>
      {hasMountedPane || view.needsTheater ? (
        <div
          ref={layerRef}
          className={`standalone-cli-layer${isLayerOpen ? " is-open" : ""}`}
          data-standalone-cli={isLayerOpen ? "open" : "hidden"}
          data-standalone-cli-active={view.activeCli ?? undefined}
          role="region"
          aria-label={t("terminal.standaloneCli.aria")}
          aria-hidden={isLayerOpen ? undefined : true}
          inert={isLayerOpen ? undefined : true}
        >
          {STANDALONE_CLI_KINDS.map((cli) => {
            const slot = view.slots[cli];
            if (slot.placement === null) return null;
            return (
              <StandaloneCliTerminalPane
                key={cli}
                cli={cli}
                open={view.activeCli === cli}
                placement={slot.placement}
                generation={slot.generation}
                focusRequest={view.focusRequest}
                language={language}
                theme={theme}
              />
            );
          })}
          {view.needsTheater && view.activeCli === null ? (
            <div className="conversation-column">
              <div className="conversation-body">
                <div className="conversation-empty" role="status">
                  <strong>{t("terminal.standaloneCli.selectTheaterTitle")}</strong>
                  <span>{t("terminal.standaloneCli.selectTheaterBody", { shortcut: shortcutLabel })}</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {view.paletteOpen ? (
        <div
          className="standalone-cli-palette-overlay"
          data-standalone-cli-palette="open"
          role="dialog"
          aria-modal="true"
          aria-label={t("terminal.standaloneCli.paletteAria")}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeStandaloneCliPalette();
          }}
        >
          <div
            ref={paletteCardRef}
            className="standalone-cli-palette-card"
            tabIndex={-1}
            role="listbox"
            aria-label={t("terminal.standaloneCli.paletteAria")}
            onKeyDown={handlePaletteKeyDown}
          >
            {STANDALONE_CLI_KINDS.map((cli, index) => {
              const slot = view.slots[cli];
              const name = cli === "claude" ? t("terminal.standaloneCli.claude") : t("terminal.standaloneCli.antigravity");
              const keyLabel = cli === "claude" ? "1" : "2";
              const isSelected = activeIndex === index;
              const note = cli === "antigravity" && slot.installed ? agySignInNote : null;
              return (
                <button
                  key={cli}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={!slot.installed || undefined}
                  data-standalone-cli-option={cli}
                  className={`standalone-cli-palette-row${isSelected ? " is-active" : ""}${!slot.installed ? " is-disabled" : ""}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => { void selectStandaloneCli(cli, fallbackPlacement); }}
                >
                  <span className="standalone-cli-palette-row-left">
                    <span className={`standalone-cli-palette-glyph is-${cli}`} aria-hidden="true">
                      {cli === "claude" ? launchProviderGlyph("claude") : <AntigravityGlyph />}
                    </span>
                    <span className="standalone-cli-palette-label">
                      <span className="standalone-cli-palette-name">{name}</span>
                      {note ? <span className="standalone-cli-palette-note" data-standalone-cli-note={cli}>{note}</span> : null}
                    </span>
                  </span>
                  <span className="standalone-cli-palette-row-right">
                    {!slot.installed ? (
                      <span className="standalone-cli-palette-missing">{t("terminal.standaloneCli.notInstalled")}</span>
                    ) : slot.live ? (
                      <>
                        <span className="standalone-cli-palette-live-dot" aria-label={t("terminal.standaloneCli.running")} />
                        <span
                          role="button"
                          tabIndex={0}
                          className="standalone-cli-palette-stop"
                          data-standalone-cli-stop={cli}
                          title={t("terminal.standaloneCli.stop", { cli: name })}
                          aria-label={t("terminal.standaloneCli.stop", { cli: name })}
                          onClick={(event) => {
                            event.stopPropagation();
                            void stopStandaloneCli(cli);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            event.stopPropagation();
                            void stopStandaloneCli(cli);
                          }}
                        >
                          ×
                        </span>
                      </>
                    ) : null}
                    <kbd className="standalone-cli-palette-key">{keyLabel}</kbd>
                  </span>
                </button>
              );
            })}
            {showFallbackTheater ? (
              <div className="standalone-cli-palette-theater">
                <span>{t("terminal.standaloneCli.theater")}</span>
                <StandaloneCliTheaterSelect
                  label={t("terminal.standaloneCli.theater")}
                  value={fallbackTheaterKey}
                  options={theaterChoices.map((choice) => ({ value: choice.key, label: choice.label }))}
                  onChange={setFallbackTheaterKey}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
