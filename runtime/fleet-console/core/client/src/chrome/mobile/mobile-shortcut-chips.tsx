import type { ReactNode } from "react";

import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";

import { useConsoleLocale, useT } from "../../i18n/index.js";
import type { ConsoleState } from "../../integration/types.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { useMobileAttentionRows } from "./mobile-attention-context.js";
import { featuredDestinationBinding, mobilePluginRows, useMobileDestinationBindings, useMobileDestinationTrailing } from "./mobile-destinations.js";
import { MobileIcon, type MobileIconName } from "./mobile-icons.js";
import { setMobileDestination } from "./mobile-store.js";

interface ShortcutChip {
  readonly key: string;
  readonly icon: { readonly name: MobileIconName } | { readonly node: ReactNode };
  readonly label: string;
  /** 플러그인이 올린 오른쪽 값(상태 낱말) — 있으면 건수 자리를 이것이 쓴다. */
  readonly trailing?: { readonly glyph?: Parameters<typeof statusGlyphClassName>[0]; readonly text: string; readonly tone?: string } | null;
  readonly count: number;
  readonly run: () => void;
}

/**
 * 홈 머리 아래 바로가기 칩 줄 — 옛 드로어의 목적지를 가로 한 줄로 옮겼다. `RailEntryDescriptor.mobile.destination`을 선언한 플러그인
 * 목적지(목표·파일·위키·Shell 등, `shown`이 허락한 것을 order 순으로, `trailing` 값과 확인 필요 건수를 칩에 그대로 단다)와 보관함이 서고,
 * 대표 행(`MobileHomeFeatured`)이 서는 목적지는 칩에서 빠진다. 목적지가 아닌 도구가 있으면 끝에 「더보기」가 「플러그인」 화면으로 이어 준다. 설정은 프로필 시트가 맡는다.
 */
export function MobileShortcutChips({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  const locale = useConsoleLocale();
  const attention = useMobileAttentionRows();
  const bindings = useRailEntries();
  const shown = useMobileDestinationBindings(bindings, state.activeTheaterId);
  const trailing = useMobileDestinationTrailing(bindings, state.activeTheaterId);

  // 대표 행이 홈 맨 위에 서 있으면 그 목적지는 칩에서 뺀다 — 한 번에 닿는 자리가 이미 있다.
  const featured = featuredDestinationBinding(shown);
  const chips: ShortcutChip[] = shown.filter((binding) => binding !== featured).map((binding): ShortcutChip => ({
    key: binding.entry.id,
    icon: { node: renderEntryIcon(binding.entry.mobile?.icon ?? binding.entry.icon) },
    label: resolveLocalizedText(binding.entry.mobile?.destination?.label ?? binding.entry.title, locale),
    trailing: trailing.get(binding.entry.id) ?? null,
    count: attention.filter((row) => row.kind === "plugin" && row.entryId === binding.entry.id).length,
    run: () => setMobileDestination({ kind: "plugin", entryId: binding.entry.id }),
  }));
  chips.push({ key: "archive", icon: { name: "archive" }, label: t("mobile.home.archive"), count: 0, run: () => setMobileDestination({ kind: "archive" }) });
  if (mobilePluginRows(bindings).length > 0) {
    chips.push({ key: "plugins", icon: { name: "grid" }, label: t("mobile.list.more"), count: 0, run: () => setMobileDestination({ kind: "plugins" }) });
  }

  return (
    <nav className="mobile-conv-shortcuts" aria-label={t("mobile.list.shortcutsAria")}>
      {chips.map((chip) => (
        <button type="button" key={chip.key} data-press="r1" className="mobile-conv-chip is-shortcut" onClick={chip.run}>
          <span className="mobile-conv-chip-icon" aria-hidden="true">{"name" in chip.icon ? <MobileIcon name={chip.icon.name} size={18} /> : chip.icon.node}</span>
          {chip.label}
          {chip.trailing ? (
            <span className={`mobile-conv-chip-state${chip.trailing.tone ? ` is-${chip.trailing.tone}` : ""}`}>
              {chip.trailing.glyph ? <span className={statusGlyphClassName(chip.trailing.glyph)} aria-hidden="true" /> : null}
              {chip.trailing.text}
            </span>
          ) : chip.count > 0 ? <span className="mobile-conv-chip-count">{chip.count}</span> : null}
        </button>
      ))}
    </nav>
  );
}

function renderEntryIcon(icon: ReactNode | (() => ReactNode)): ReactNode {
  return typeof icon === "function" ? icon() : icon;
}
