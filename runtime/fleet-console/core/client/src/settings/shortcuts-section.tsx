import { useEffect, useMemo, useState } from "react";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { CompanionPanelDescriptor } from "@fleet-console/sdk/plugin";

import { SettingsHelp } from "../components/settings-help.js";
import { setGlobalSettingsField } from "../global-settings-store.js";
import { useConsoleLocale, useT } from "../i18n/index.js";
import { usePluginRegistry } from "../plugin-registry.js";
import {
  CORE_SHORTCUT_COMMANDS,
  chordFromKeyboardEvent,
  chordKeyLabels,
  chordLabel,
  chordsEquivalent,
  companionDefaultChord,
  companionShortcutCommandId,
  judgeRecordedChord,
  setShortcutRecording,
  useShortcutOverrides,
  withShortcutOverride,
  type ShortcutBindings,
  type ShortcutCommandGroup,
} from "../shortcut-bindings.js";
import { usableCompanionShortcuts } from "../shortcuts.js";
import type { GlobalSettingsState } from "../types.js";

interface ShortcutRow {
  readonly commandId: string;
  readonly group: ShortcutCommandGroup;
  readonly title: string;
  readonly defaults: readonly string[];
}

interface RecordingSlot {
  readonly commandId: string;
  readonly index: number;
}

type RowNote =
  | { readonly kind: "saved" | "warn" | "reject"; readonly text: string }
  | { readonly kind: "conflict"; readonly text: string; readonly swap: () => void };

/**
 * 단축키 카드 — 명령마다 현재 조합이 버튼으로 서고, 누르면 다음 키 하나가 새 조합이 된다.
 * 저장값은 서버 general 설정의 `shortcuts`(테마·언어와 같은 「이 콘솔의 취향」)이며, 기본값과
 * 같은 명령은 담지 않는다. 켜고 끄는 스위치는 두지 않는다 — 모든 명령은 늘 어떤 조합을 갖는다.
 */
export function ShortcutsCard({ state, saving }: {
  readonly state: GlobalSettingsState | null;
  readonly saving: boolean;
}) {
  const t = useT();
  const locale = useConsoleLocale();
  const registry = usePluginRegistry();
  const overrides = useShortcutOverrides();
  const [recording, setRecording] = useState<RecordingSlot | null>(null);
  const [notes, setNotes] = useState<Readonly<Record<string, RowNote>>>({});

  const rows = useMemo((): readonly ShortcutRow[] => {
    const core = CORE_SHORTCUT_COMMANDS.map((command): ShortcutRow => ({
      commandId: command.id,
      group: command.group,
      title: t(command.descriptionKey),
      defaults: command.defaults,
    }));
    // companion 패널은 플러그인이 선언한다 — 지금 활성인 작전과 무관하게 선언된 전부를 세운다.
    // 같은 패널 id가 여러 작전 종류에 실려도 한 행이다(같은 명령 id로 저장된다).
    const seen = new Set<string>();
    const companions: ShortcutRow[] = [];
    for (const kind of registry.operationKinds) {
      for (const companion of usableCompanionShortcuts(kind.companions ?? []) as readonly CompanionPanelDescriptor[]) {
        if (!companion.shortcut) continue;
        const commandId = companionShortcutCommandId(kind.pluginId, companion.id);
        if (seen.has(commandId)) continue;
        seen.add(commandId);
        companions.push({
          commandId,
          group: "companion",
          title: t("shortcuts.operations.toggleCompanion", { title: resolveLocalizedText(companion.title, locale) }),
          defaults: [companionDefaultChord(companion.shortcut.code)],
        });
      }
    }
    return [...core, ...companions];
  }, [locale, registry.operationKinds, t]);

  const rowById = useMemo(() => new Map(rows.map((row) => [row.commandId, row])), [rows]);
  const chordsOf = (row: ShortcutRow, bindings: ShortcutBindings = overrides) => {
    const custom = bindings[row.commandId];
    return custom !== undefined && custom.length === row.defaults.length ? custom : row.defaults;
  };
  const isCustom = (row: ShortcutRow) => chordsOf(row).some((chord, index) => chord !== row.defaults[index]);
  const anyCustom = rows.some(isCustom);

  // 등록부는 설정 스토어가 몬다 — 낙관 반영과 실패 되돌림이 한 곳(setSnapshot)에서 일어난다.
  const persist = (next: ShortcutBindings) => {
    void setGlobalSettingsField("shortcuts", next);
  };

  const setNote = (commandId: string, note: RowNote | null) => {
    setNotes((current) => {
      const { [commandId]: _dropped, ...rest } = current;
      return note === null ? rest : { ...rest, [commandId]: note };
    });
  };

  const assign = (row: ShortcutRow, index: number, chord: string, bindings: ShortcutBindings = overrides): ShortcutBindings => {
    const chords = chordsOf(row, bindings).map((current, at) => (at === index ? chord : current));
    return withShortcutOverride(bindings, row.commandId, chords, row.defaults);
  };

  const stopRecording = () => {
    setShortcutRecording(false);
    setRecording(null);
  };

  useEffect(() => {
    if (recording === null) return;
    setShortcutRecording(true);
    const slot = recording;
    const row = rowById.get(slot.commandId);
    if (!row) { stopRecording(); return; }
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.code === "Escape") { stopRecording(); return; }
      const chord = chordFromKeyboardEvent(event);
      if (chord === null) return;
      const verdict = judgeRecordedChord(chord);
      if (verdict.kind === "reject") {
        setNote(row.commandId, { kind: "reject", text: t(verdict.reason === "blocked" ? "settings.shortcuts.rejectBlocked" : "settings.shortcuts.rejectNoModifier", { chord: chordLabel(chord) }) });
        return;
      }
      // 같은 명령의 다른 자리(Quick Launch의 대안 조합)와 겹치면 두 문이 하나가 된다 — 거부.
      if (chordsOf(row).some((current, at) => at !== slot.index && chordsEquivalent(current, chord))) {
        setNote(row.commandId, { kind: "reject", text: t("settings.shortcuts.rejectSameCommand", { chord: chordLabel(chord) }) });
        return;
      }
      const other = rows.find((candidate) => candidate.commandId !== row.commandId && chordsOf(candidate).some((current) => chordsEquivalent(current, chord)));
      stopRecording();
      if (other) {
        // 충돌은 막되 길을 남긴다 — 두 명령의 조합을 서로 바꾸면 어느 쪽도 조합을 잃지 않는다.
        const previousChord = chordsOf(row)[slot.index] ?? chord;
        const otherIndex = chordsOf(other).findIndex((current) => chordsEquivalent(current, chord));
        setNote(row.commandId, {
          kind: "conflict",
          text: t("settings.shortcuts.conflict", { chord: chordLabel(chord), other: other.title }),
          swap: () => {
            const next = assign(other, otherIndex, previousChord, assign(row, slot.index, chord));
            persist(next);
            setNote(row.commandId, { kind: "saved", text: t("settings.shortcuts.swapped", { chord: chordLabel(chord), other: other.title, otherChord: chordLabel(previousChord) }) });
          },
        });
        return;
      }
      persist(assign(row, slot.index, chord));
      setNote(row.commandId, verdict.warning === null
        ? { kind: "saved", text: t("settings.shortcuts.saved", { chord: chordLabel(chord) }) }
        : { kind: "warn", text: t(verdict.warning === "ime" ? "settings.shortcuts.warnIme" : "settings.shortcuts.warnSpotlight", { chord: chordLabel(chord) }) });
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(`[data-shortcut-slot="${slot.commandId}:${slot.index}"]`)) return;
      stopRecording();
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      setShortcutRecording(false);
    };
    // rows/overrides는 기록 중 바뀌지 않는다 — 기록이 끝나야 저장이 나간다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const groups: readonly { readonly group: ShortcutCommandGroup; readonly title: string }[] = [
    { group: "console", title: t("settings.shortcuts.groupConsole") },
    { group: "operations", title: t("settings.shortcuts.groupOperations") },
    { group: "companion", title: t("settings.shortcuts.groupCompanion") },
  ];
  const disabled = saving || state === null;

  return (
    <section className="global-settings-card" aria-label={t("settings.shortcuts.title")}>
      <h2 className="global-settings-card-title">
        {t("settings.shortcuts.title")}
        <SettingsHelp title={t("settings.shortcuts.title")}>{t("settings.shortcuts.help")}</SettingsHelp>
        <span className="global-settings-card-title-spacer" />
        <button
          type="button"
          className="fc-settings-reset"
          disabled={disabled || !anyCustom}
          onClick={() => { persist({}); setNotes({}); }}
        >
          {t("settings.shortcuts.resetAll")}
        </button>
      </h2>
      <div className="global-settings-shortcut-groups">
        {groups.map(({ group, title }) => {
          const groupRows = rows.filter((row) => row.group === group);
          if (groupRows.length === 0) return null;
          return (
            <div key={group} className="global-settings-shortcut-group">
              <h3 className="global-settings-shortcut-group-title">{title}</h3>
              {groupRows.map((row) => {
                const chords = chordsOf(row);
                const custom = isCustom(row);
                const note = notes[row.commandId];
                return (
                  <div key={row.commandId} className="global-settings-row global-settings-shortcut-row">
                    <div className="global-settings-row-text">
                      <p className="global-settings-resp-title">{row.title}</p>
                      {note ? (
                        <p className={`global-settings-shortcut-note is-${note.kind}`} role="status">
                          {note.text}
                          {note.kind === "conflict" ? (
                            <button type="button" className="fc-settings-reset" onClick={note.swap}>{t("settings.shortcuts.swap")}</button>
                          ) : null}
                        </p>
                      ) : null}
                    </div>
                    <div className="global-settings-shortcut-controls">
                      {chords.map((chord, index) => {
                        const active = recording?.commandId === row.commandId && recording.index === index;
                        return (
                          <span key={`${row.commandId}:${index}`} className="global-settings-shortcut-slot">
                            {index > 0 ? <span className="global-settings-shortcut-or">{t("chrome.shortcuts.or")}</span> : null}
                            <button
                              type="button"
                              data-shortcut-slot={`${row.commandId}:${index}`}
                              className={`global-settings-shortcut-chord${active ? " is-recording" : ""}${custom && chord !== row.defaults[index] ? " is-custom" : ""}`}
                              disabled={disabled}
                              aria-label={active ? t("settings.shortcuts.recording") : t("settings.shortcuts.chordAria", { title: row.title, chord: chordLabel(chord) })}
                              onClick={() => {
                                if (active) { stopRecording(); return; }
                                setNote(row.commandId, null);
                                setRecording({ commandId: row.commandId, index });
                              }}
                            >
                              {active
                                ? <span className="global-settings-shortcut-prompt">{t("settings.shortcuts.pressKeys")}</span>
                                : chordKeyLabels(chord).map((key, keyIndex) => <kbd key={`${keyIndex}:${key}`}>{key}</kbd>)}
                            </button>
                          </span>
                        );
                      })}
                      {custom ? (
                        <button
                          type="button"
                          className="fc-settings-reset"
                          disabled={disabled}
                          aria-label={t("settings.shortcuts.resetRowAria", { title: row.title })}
                          onClick={() => {
                            const { [row.commandId]: _dropped, ...rest } = overrides;
                            persist(rest);
                            setNote(row.commandId, null);
                          }}
                        >
                          {t("settings.slider.reset")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
