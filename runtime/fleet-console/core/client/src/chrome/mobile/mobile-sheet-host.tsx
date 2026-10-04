import { useEffect, useRef, useState } from "react";

import { resolveOperationActivity } from "../../../../../features/execution/client/operation-activity.js";
import type { DeferredDeletionReceipt } from "../../integration/api.js";
import { forgetTheaterCompletely, registerTheaterFromPath } from "../../../../../features/workspace/client/theater.js";
import { useT } from "../../i18n/index.js";
import { useMobileAppearance } from "../../integration/mobile-appearance-store.js";
import { setActiveTheater } from "../../integration/store.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import type { ConsoleState } from "../../integration/types.js";
import { MobileFolderSheet } from "./mobile-folder-sheet.js";
import { MobileIcon } from "./mobile-icons.js";
import { showMobileToast } from "./mobile-toast.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { pushOverlayHistory, releaseOverlayHistory } from "./mobile-overlay-history.js";
import { MobileSheet } from "./mobile-sheet.js";
import { closeMobileSheets, popMobileSheet, pushMobileSheet, useMobileSheetStack } from "./mobile-store.js";

/**
 * 하단 시트의 호스트. 쌓인 시트 가운데 맨 위 하나만 그리고, 닫으면 앞 시트로 돌아간다.
 * 쌓인 시트 전체가 history 항목 하나를 든다.
 */
export function MobileSheetHost({ state, onDeferredDeletion }: { readonly state: ConsoleState; readonly onDeferredDeletion: (deletion: DeferredDeletionReceipt | null) => void }) {
  const stack = useMobileSheetStack();
  const depth = stack.length;
  const historyIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (depth === 0) {
      if (historyIdRef.current !== null) { releaseOverlayHistory(historyIdRef.current); historyIdRef.current = null; }
      return;
    }
    // 한 항목이 쌓인 모든 시트를 든다 — 뒤로가 시트를 하나 닫으면 남은 시트를 위해 이 효과가 항목을 다시 세운다.
    if (historyIdRef.current === null) {
      historyIdRef.current = pushOverlayHistory(() => { historyIdRef.current = null; popMobileSheet(); });
    }
  }, [depth]);

  const top = stack.at(-1);
  if (!top) return null;
  if (top.kind === "rename") return <RenameSheet key={top.operationId} state={state} operationId={top.operationId} />;
  if (top.kind === "console") return <ConsoleSheet />;
  if (top.kind === "folder") return <MobileFolderSheet onClose={popMobileSheet} onConfirm={(path) => { closeMobileSheets(); void registerTheaterFromPath(path); }} />;
  if (top.kind === "forget") return <ForgetSheet key={top.theaterId} state={state} theaterId={top.theaterId} onDeferredDeletion={onDeferredDeletion} />;
  return <TheaterSheet state={state} />;
}

/** S-13 — 입력칸 하나. 저장하면 닫히고 토스트가 알린다. 빈 문자열은 저장하지 않는다. */
function RenameSheet({ state, operationId }: { readonly state: ConsoleState; readonly operationId: string }) {
  const t = useT();
  const capabilities = useHostCapabilities();
  const operation = state.operations.find((item) => item.id === operationId);
  const [value, setValue] = useState(operation?.title ?? "");
  const [saving, setSaving] = useState(false);
  const trimmed = value.trim();
  const save = () => {
    if (trimmed === "" || saving) return;
    setSaving(true);
    void capabilities.operations.rename(operationId, trimmed).then(() => { closeMobileSheets(); showMobileToast(t("mobile.toast.renamed")); }).catch(() => setSaving(false));
  };
  return (
    <MobileSheet
      title={t("mobile.sheet.rename.title")}
      onClose={popMobileSheet}
      footer={<>
        <button type="button" className="mobile-pill-secondary" onClick={popMobileSheet}>{t("mobile.sheet.cancel")}</button>
        <button type="button" className="mobile-pill-secondary is-inverse" onClick={save} disabled={trimmed === "" || saving}>{t("mobile.sheet.save")}</button>
      </>}
    >
      <input
        className="mobile-field"
        value={value}
        aria-label={t("mobile.sheet.rename.aria")}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }}
        autoFocus
      />
    </MobileSheet>
  );
}

/** S-07 — 지금 Theater를 바꾼다. 고르면 시트만 닫고 드로어는 그대로 둔다(새 Theater의 최근 목록이 거기 있다). */
function TheaterSheet({ state }: { readonly state: ConsoleState }) {
  const t = useT();
  return (
    <>
      <MobileSheet title={t("mobile.sheet.theater.title")} onClose={popMobileSheet}>
        {state.theaters.map((theater) => {
          const operations = state.operations.filter((operation) => operation.theaterId === theater.id);
          const awaiting = operations.filter((operation) => resolveOperationActivity(operation, state.operationRuntime) === "awaiting").length;
          const here = theater.id === state.activeTheaterId;
          return (
            <button
              type="button"
              className="mobile-sheet-row"
              key={theater.id}
              aria-current={here ? "true" : undefined}
              onClick={() => { setActiveTheater(theater.id); closeMobileSheets(); }}
            >
              <MobileMonogram label={theater.label} toneKey={theater.id} />
              <span className="mobile-sheet-row-copy">
                <strong>{theater.label}</strong>
                <small className={awaiting > 0 ? "is-awaiting" : undefined}>
                  {t("mobile.sheet.theater.summary", { count: operations.length })}{awaiting > 0 ? ` · ${t("mobile.sheet.theater.awaiting", { count: awaiting })}` : ""}
                </small>
              </span>
              {here ? <MobileIcon name="check" className="mobile-sheet-check" /> : null}
            </button>
          );
        })}
        <button type="button" className="mobile-sheet-row" onClick={() => pushMobileSheet({ kind: "folder" })} disabled={state.addingTheater}>
          <span className="mobile-sheet-row-glyph"><MobileIcon name="plus" /></span>
          <span className="mobile-sheet-row-copy"><strong>{t("mobile.sheet.theater.add")}</strong></span>
        </button>
        {state.theaterError !== null ? <p className="mobile-sheet-error" role="alert">{state.theaterError}</p> : null}
      </MobileSheet>
    </>
  );
}

/** S-17 — 목록에서 빼기 확인. 폴더와 파일은 지우지 않는다. 되돌리기는 앱의 삭제 토스트가 맡는다. */
function ForgetSheet({ state, theaterId, onDeferredDeletion }: { readonly state: ConsoleState; readonly theaterId: string; readonly onDeferredDeletion: (deletion: DeferredDeletionReceipt | null) => void }) {
  const t = useT();
  const theater = state.theaters.find((item) => item.id === theaterId);
  const [busy, setBusy] = useState(false);
  const confirm = () => {
    if (busy) return;
    setBusy(true);
    void forgetTheaterCompletely(theaterId).then((deletion) => { onDeferredDeletion(deletion); closeMobileSheets(); });
  };
  return (
    <MobileSheet
      title={t("mobile.sheet.forget.title")}
      onClose={popMobileSheet}
      footer={<>
        <button type="button" className="mobile-pill-secondary" onClick={popMobileSheet}>{t("mobile.sheet.cancel")}</button>
        <button type="button" className="mobile-pill-secondary is-danger" disabled={busy} onClick={confirm}>{t("mobile.sheet.forget.confirm")}</button>
      </>}
    >
      <p className="mobile-sheet-lead">{t("mobile.sheet.forget.body", { name: theater?.label ?? "" })}</p>
    </MobileSheet>
  );
}

/** S-18 (브라우저, D12) — 이 Console 한 줄만. 다른 Console의 이름·주소·상태는 이 페이지에 오지 않는다. 앱에서는 네이티브가 같은 모양의 시트를 직접 띄운다. */
function ConsoleSheet() {
  const t = useT();
  const appearance = useMobileAppearance();
  const name = appearance.console?.label ?? window.location.hostname;
  return (
    <MobileSheet title={t("mobile.sheet.console.title")} onClose={popMobileSheet}>
      <div className="mobile-sheet-row" aria-current="true">
        <MobileMonogram label={name} toneKey={name} tone={appearance.console?.tone ?? null} letters={appearance.console?.monogram ?? null} round size={36} />
        <span className="mobile-sheet-row-copy"><strong>{name}</strong><small>{t("mobile.sheet.console.connected")}</small></span>
        <MobileIcon name="check" className="mobile-sheet-check" />
      </div>
    </MobileSheet>
  );
}
