import { useMemo, useState, useSyncExternalStore } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";
import { objectiveRecordAvatarKey } from "../../../../../features/workspace/shared/avatars.js";
import type { RailEntryFinishedItem } from "../../../../../features/workspace/shared/rail.js";
import { KeyedAvatar } from "../../../../../features/workspace/client/avatars.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import { useRailEntries, type RailEntryBinding } from "../pane/pane-registry.js";
import { entryIconOf } from "./mobile-destinations.js";
import { MobileIcon } from "./mobile-icons.js";

/** 보관한 완료 목표는 살아 있는 지휘관 명단과 별개다. 세션 없는 목표도 복원 없이 읽을 입구를 남긴다. */
export function MobileArchivedFinished({ commodoreId, leave }: {
  readonly commodoreId: string;
  readonly leave: (run: () => void) => void;
}) {
  const t = useT();
  const locale = useConsoleLocale();
  const bindings = useRailEntries();
  const finished = useFinishedItems(bindings, commodoreId, locale);
  const [open, setOpen] = useState(false);
  if (finished.length === 0) return null;
  return <>
    <div className="mobile-conv-section is-fold">
      <button type="button" data-press="r1" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t("mobile.list.archivedFinished", { count: finished.length })}<MobileIcon name={open ? "down" : "right"} size={16} />
      </button>
    </div>
    {open ? finished.map(({ entryId, item }) => <button key={`${entryId}:${item.id}`} type="button" data-press="r1" className="mobile-conv-row" onClick={() => leave(item.open)}>
      <span className="mobile-conv-row-av">{item.avatarObjectiveId !== undefined
        ? <KeyedAvatar avatarKey={objectiveRecordAvatarKey(item.avatarObjectiveId)} role="commander" state="done" size={52} label="" decorative />
        : <span className="mobile-conv-round is-static">{entryIconOf(bindings, entryId)}</span>}</span>
      <span className="mobile-conv-row-copy">
        <span className="mobile-conv-row-top"><span className="mobile-conv-row-title">{item.title}</span></span>
        <span className="mobile-conv-row-sub"><span className="mobile-conv-state is-done">{t("mobile.search.state.done")}</span>{item.detail ? ` · ${item.detail}` : null}</span>
      </span>
    </button>) : null}
  </>;
}

/** 엔트리들이 `mobile.finished`로 올린 끝난 일 — 각 공급원의 구독을 하나의 틱으로 묶고, 값(id·제목·둘째 줄)이 같으면 다시 그리지 않는다. */
function useFinishedItems(bindings: readonly RailEntryBinding[], context: string | null, locale: ConsoleLocale): readonly { readonly entryId: string; readonly item: RailEntryFinishedItem }[] {
  const key = useSyncExternalStore(
    (listener) => {
      const disposers = bindings.flatMap((binding) => binding.entry.mobile?.finished ? [binding.entry.mobile.finished.subscribe(listener)] : []);
      return () => { for (const dispose of disposers) dispose(); };
    },
    () => finishedVersion(bindings, context, locale),
    () => finishedVersion(bindings, context, locale),
  );
  return useMemo(() => bindings.flatMap((binding) => {
    if (!binding.entry.mobile?.finished || binding.entry.visible?.() === false) return [];
    return binding.entry.mobile.finished.items(scopeOf(binding, context), locale).map((item) => ({ entryId: binding.entry.id, item }));
  }), // eslint-disable-next-line react-hooks/exhaustive-deps -- key는 끝난 일이 바뀌었다는 신호다.
  [bindings, context, locale, key]);
}

function scopeOf(binding: RailEntryBinding, context: string | null): string | null {
  return binding.entry.scope === "fleet" ? null : context;
}

function finishedVersion(bindings: readonly RailEntryBinding[], context: string | null, locale: ConsoleLocale): string {
  return bindings.map((binding) => {
    const finished = binding.entry.mobile?.finished;
    if (!finished || binding.entry.visible?.() === false) return "";
    return `${binding.entry.id}:${finished.items(scopeOf(binding, context), locale).map((item) => `${item.id}\u0001${item.title}\u0001${item.detail ?? ""}\u0001${item.avatarObjectiveId ?? ""}`).join("\u0002")}`;
  }).join("|");
}
