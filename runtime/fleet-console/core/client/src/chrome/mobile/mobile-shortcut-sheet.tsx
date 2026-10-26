import { getViewedTheaterId } from "../../integration/viewed-theater.js";
import type { ReactNode } from "react";

import { resolveLocalizedText } from "@fleet-console/i18n/translate";

import { useConsoleLocale, useT } from "../../i18n/index.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { useMobileAttentionRows } from "./mobile-attention-context.js";
import { featuredDestinationBinding, isChipDestination, mobilePluginRows, renderEntryIcon, useMobileDestinationBindings, useMobileDestinationTrailing } from "./mobile-destinations.js";
import { MobileIcon, type MobileIconName } from "./mobile-icons.js";
import { MobileSheet } from "./mobile-sheet.js";
import { openMobilePluginDestination, setMobileDestination } from "./mobile-store.js";

interface ShortcutRow {
  readonly key: string;
  readonly icon: { readonly name: MobileIconName } | { readonly node: ReactNode };
  readonly label: string;
  /** 플러그인이 올린 오른쪽 값(상태 낱말) — 있으면 건수 자리를 이것이 쓴다. */
  readonly trailing?: { readonly text: string; readonly tone?: string } | null;
  readonly count: number;
  readonly run: () => void;
}

/**
 * 홈 아래 왼쪽 바로가기 단추의 시트 — 옛 칩 줄의 목적지를 한 장에 세로로 모았다. `RailEntryDescriptor.mobile.destination`을 선언한 플러그인
 * 목적지(파일·위키·Shell 등, `shown`이 허락하고 `chip: false`가 아닌 것을 order 순으로, `trailing` 값과 확인 필요 건수를 행 끝에 그대로 단다)와 보관함이 서고,
 * 상태를 말하는 목적지(사령관 — 홈 목록 자체가 그 입구다)는 빠진다. 목적지가 아닌 도구가 있으면 끝에 「더보기」가 「플러그인」 화면으로 이어 준다. 설정은 프로필 시트가 맡는다.
 */
export function MobileShortcutSheet({ onClose }: { readonly onClose: () => void }) {
  const t = useT();
  const locale = useConsoleLocale();
  const attention = useMobileAttentionRows();
  const bindings = useRailEntries();
  const shown = useMobileDestinationBindings(bindings, getViewedTheaterId());
  const trailing = useMobileDestinationTrailing(bindings, getViewedTheaterId());

  const featured = featuredDestinationBinding(shown);
  const rows: ShortcutRow[] = shown.filter((binding) => binding !== featured && isChipDestination(binding)).map((binding): ShortcutRow => ({
    key: binding.entry.id,
    icon: { node: renderEntryIcon(binding.entry.mobile?.icon ?? binding.entry.icon) },
    label: resolveLocalizedText(binding.entry.mobile?.destination?.label ?? binding.entry.title, locale),
    trailing: trailing.get(binding.entry.id) ?? null,
    count: attention.filter((row) => row.kind === "plugin" && row.entryId === binding.entry.id).length,
    run: () => openMobilePluginDestination(binding.entry.id, getViewedTheaterId()),
  }));
  rows.push({ key: "archive", icon: { name: "archive" }, label: t("mobile.home.archive"), count: 0, run: () => setMobileDestination({ kind: "archive" }) });
  if (mobilePluginRows(bindings).length > 0) {
    rows.push({ key: "plugins", icon: { name: "grid" }, label: t("mobile.list.more"), count: 0, run: () => setMobileDestination({ kind: "plugins" }) });
  }

  return (
    <MobileSheet title={t("mobile.list.shortcutsAria")} onClose={onClose} focusInputOnTouch={false}>
      {rows.map((row) => (
        <button type="button" key={row.key} className="mobile-sheet-row" onClick={() => { onClose(); row.run(); }}>
          <span className="mobile-sheet-row-glyph" aria-hidden="true">{"name" in row.icon ? <MobileIcon name={row.icon.name} /> : row.icon.node}</span>
          <span className="mobile-sheet-row-copy"><strong>{row.label}</strong></span>
          {row.trailing ? (
            <span className={`mobile-conv-chip-state${row.trailing.tone ? ` is-${row.trailing.tone}` : ""}`}>{row.trailing.text}</span>
          ) : row.count > 0 ? <span className="mobile-conv-chip-count">{row.count}</span> : null}
        </button>
      ))}
    </MobileSheet>
  );
}
