import type { ConsoleLocale } from "@fleet-console/i18n";
import { memo, useEffect, useRef, useState } from "react";

import type { WorldActorSpec, WorldDistrictSpec, WorldVillageSpec } from "../../shared/world-types.js";
import type { TheWorldClientDeps } from "../deps.js";
import { playDistrictSelect, playFlagPlant, playSend } from "../engine/world-audio.js";
import { getWorldT } from "../i18n/index.js";
import {
  pushActorSpeech,
  setOperationFlag,
  useOperationFlag,
  type WorldOperationFlag,
  type WorldOperationFlagDeployInput,
  type WorldSkyQuickMenu,
} from "../world-store.js";
import { WorldIcon } from "./world-icons.js";

export type { WorldOperationFlagDeployInput };

export interface WorldSkyHoverTarget {
  readonly village: WorldVillageSpec;
  readonly district: WorldDistrictSpec | null;
  readonly actor: WorldActorSpec | null;
  readonly x: number;
  readonly y: number;
}

export interface WorldSkyCommandProps {
  readonly overviewMode: boolean;
  readonly hoverTarget: WorldSkyHoverTarget | null;
  readonly quickMenu: WorldSkyQuickMenu | null;
  readonly villages: readonly WorldVillageSpec[];
  readonly actors: readonly WorldActorSpec[];
  readonly deps: TheWorldClientDeps;
  readonly locale: ConsoleLocale | undefined;
  readonly onCloseQuickMenu: () => void;
  readonly onAnswerAsk: (actorId: string) => void;
  readonly onDiveToTarget: (x: number, z: number, label: string) => void;
  readonly onOpenNotebook: (actorId: string) => void;
  readonly onStatusBanner: (msg: string) => void;
  readonly operationFlag?: WorldOperationFlag | null | undefined;
  readonly onDeployOperationFlag?: ((input: WorldOperationFlagDeployInput) => void) | undefined;
  readonly onClearOperationFlag?: (() => void) | undefined;
}

function clampPosition(x: number, y: number, width: number, height: number): { readonly left: number; readonly top: number } {
  if (typeof window === "undefined") return { left: x, top: y };
  const pad = 12;
  const left = Math.max(pad, Math.min(x, window.innerWidth - width - pad));
  const top = Math.max(pad, Math.min(y, window.innerHeight - height - pad));
  return { left, top };
}

function resolveStatusDotClass(village: WorldVillageSpec, actor: WorldActorSpec | null): string {
  if (village.hasError || actor?.state === "error") return "is-error";
  if (village.needsAttention || village.openAsksCount > 0 || actor?.needsAttention) return "is-attention";
  if (village.workStep || actor?.state === "running") return "is-working";
  return "";
}

/**
 * 하늘 비행(`overviewMode`) 전용 스카이 커맨드 UI.
 *
 * - 공중 호버 스캔 카드(`.the-world-sky-hover-card`): 마우스 근접 미니 상태 카드
 * - 공중 우클릭 퀵 커맨드 팝오버(`.the-world-sky-cmd-popover`): 인라인 1줄 지시 · 질문 바로 답하기 · 유성 착지 · 작전 수첩 열기
 */
export const WorldSkyCommand = memo(function WorldSkyCommand({
  overviewMode,
  hoverTarget,
  quickMenu,
  villages,
  actors,
  deps,
  locale,
  onCloseQuickMenu,
  onAnswerAsk,
  onDiveToTarget,
  onOpenNotebook,
  onStatusBanner,
  operationFlag: operationFlagProp,
  onDeployOperationFlag,
  onClearOperationFlag,
}: WorldSkyCommandProps) {
  const t = getWorldT(locale);
  const isEn = locale === "en";
  const bi = (ko: string, en: string) => (isEn ? en : ko);
  const storeOperationFlag = useOperationFlag();
  const activeOperationFlag = operationFlagProp !== undefined ? operationFlagProp : storeOperationFlag;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [flagFormOpen, setFlagFormOpen] = useState(false);
  const [flagDirective, setFlagDirective] = useState("");
  const popoverRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const flagInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft("");
    setSending(false);
    setFlagFormOpen(false);
    setFlagDirective("");
    if (!quickMenu) return;
    const raf = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [quickMenu]);

  useEffect(() => {
    if (!flagFormOpen) return;
    const raf = window.requestAnimationFrame(() => {
      flagInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [flagFormOpen]);

  useEffect(() => {
    if (!quickMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (popoverRef.current && event.target instanceof Node && popoverRef.current.contains(event.target)) {
        return;
      }
      onCloseQuickMenu();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [onCloseQuickMenu, quickMenu]);

  if (!overviewMode) return null;

  const menuVillage = quickMenu
    ? villages.find((v) => v.commodoreId === quickMenu.commodoreId) ?? null
    : null;
  const menuDistrict = quickMenu && menuVillage
    ? menuVillage.districts.find((d) => d.id === quickMenu.districtId) ?? null
    : null;
  const menuActor = quickMenu
    ? actors.find((a) => a.id === quickMenu.actorId || (a.role === "commodore" && a.commodoreId === quickMenu.commodoreId)) ?? null
    : null;

  const hoverPos = hoverTarget && !quickMenu
    ? clampPosition(hoverTarget.x + 18, hoverTarget.y + 18, 280, 138)
    : null;

  const menuPos = quickMenu && menuVillage
    ? clampPosition(quickMenu.x + 8, quickMenu.y + 8, 320, 250)
    : null;

  const handleSubmitOrder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!quickMenu || !menuVillage || sending) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const commodoreName = menuActor?.name ?? menuVillage.label;
      const result = await deps.sendMessageToCommodore(quickMenu.commodoreId, trimmed);
      if (result.ok) {
        playSend();
        pushActorSpeech(menuActor?.id ?? quickMenu.actorId, t("theWorld.chat.receivedSpeech", { text: trimmed.slice(0, 24) }));
        onStatusBanner(t("theWorld.rpg.sentToast", { name: commodoreName }));
        setDraft("");
        onCloseQuickMenu();
      } else {
        const reason = result.error === "mention_target_gone"
          ? t("theWorld.rpg.boardNotReady")
          : t("theWorld.rpg.sendFailed", { error: result.error ?? "unknown" });
        onStatusBanner(t("theWorld.rpg.sendFailedBanner", { name: commodoreName, reason }));
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {hoverTarget && hoverPos ? (
        <div
          className="the-world-sky-hover-card"
          style={{ left: `${hoverPos.left}px`, top: `${hoverPos.top}px` }}
          aria-hidden="true"
        >
          <div className="the-world-sky-hover-head">
            <div className="the-world-sky-hover-title">
              <span className={`the-world-sky-hover-dot ${resolveStatusDotClass(hoverTarget.village, hoverTarget.actor)}`} />
              <span className="the-world-sky-hover-name">{hoverTarget.actor?.name ?? hoverTarget.village.label}</span>
            </div>
            <span className="the-world-sky-hover-sub">
              {hoverTarget.district
                ? hoverTarget.district.label
                : t("theWorld.tier.badge", { tier: hoverTarget.village.overallTier })}
            </span>
          </div>

          <div className="the-world-sky-hover-chips">
            <span className="the-world-sky-hover-chip">
              <WorldIcon name="questMap" size={11} tone="cerulean" />
              <span>{t("theWorld.skyCmd.openGoals", { count: hoverTarget.village.activeObjectiveCount })}</span>
            </span>
            {hoverTarget.village.openAsksCount > 0 ? (
              <span className="the-world-sky-hover-chip is-urgent">
                <WorldIcon name="bell" size={11} tone="amber" />
                <span>{t("theWorld.skyCmd.pendingAsks", { count: hoverTarget.village.openAsksCount })}</span>
              </span>
            ) : null}
          </div>

          <div className="the-world-sky-hover-hint">
            {t("theWorld.skyCmd.rightClickHint")}
          </div>
        </div>
      ) : null}

      {quickMenu && menuVillage && menuPos ? (
        <section
          ref={popoverRef}
          className="the-world-sky-cmd-popover"
          style={{ left: `${menuPos.left}px`, top: `${menuPos.top}px` }}
          role="dialog"
          aria-label={t("theWorld.skyCmd.title")}
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <header className="the-world-sky-cmd-head">
            <div className="the-world-sky-cmd-identity">
              <span className="the-world-sky-cmd-kicker">{t("theWorld.skyCmd.title")}</span>
              <span className="the-world-sky-cmd-who">
                {menuActor?.name ?? menuVillage.label}
                {menuDistrict ? ` · ${menuDistrict.label}` : ""}
              </span>
            </div>
            <button
              type="button"
              className="the-world-sky-cmd-close"
              aria-label={t("theWorld.panel.closeAria")}
              onClick={onCloseQuickMenu}
            >
              <WorldIcon name="close" size={13} />
            </button>
          </header>

          <div className="the-world-sky-cmd-stats">
            <span className="the-world-sky-hover-chip">
              <WorldIcon name="questMap" size={11} tone="cerulean" />
              <span>{t("theWorld.skyCmd.openGoals", { count: menuVillage.activeObjectiveCount })}</span>
            </span>
            {menuVillage.openAsksCount > 0 ? (
              <span className="the-world-sky-hover-chip is-urgent">
                <WorldIcon name="bell" size={11} tone="amber" />
                <span>{t("theWorld.skyCmd.pendingAsks", { count: menuVillage.openAsksCount })}</span>
              </span>
            ) : null}
          </div>

          <form className="the-world-sky-cmd-form" onSubmit={(e) => void handleSubmitOrder(e)}>
            <input
              ref={inputRef}
              type="text"
              className="the-world-sky-cmd-input"
              value={draft}
              disabled={sending}
              placeholder={t("theWorld.skyCmd.quickOrderPlaceholder", { name: menuActor?.name ?? menuVillage.label })}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="submit"
              className="the-world-sky-cmd-send"
              disabled={sending || draft.trim().length === 0}
            >
              {t("theWorld.skyCmd.sendOrder")}
            </button>
          </form>

          <div className="the-world-sky-cmd-actions">
            {menuVillage.openAsksCount > 0 ? (
              <button
                type="button"
                className="the-world-sky-cmd-btn is-ask"
                onClick={() => {
                  playDistrictSelect();
                  const targetActorId = menuActor?.id ?? quickMenu.actorId;
                  onCloseQuickMenu();
                  onAnswerAsk(targetActorId);
                }}
              >
                <WorldIcon name="question" size={13} tone="amber" />
                <span>{t("theWorld.skyCmd.answerAsk")}</span>
              </button>
            ) : null}

            <button
              type="button"
              className="the-world-sky-cmd-btn is-dive"
              onClick={() => {
                const landX = menuDistrict
                  ? menuDistrict.x
                  : menuVillage.x + Math.cos(menuVillage.gateAngle) * Math.max(2.0, menuVillage.radius * 0.45);
                const landZ = menuDistrict
                  ? menuDistrict.z
                  : menuVillage.z + Math.sin(menuVillage.gateAngle) * Math.max(2.0, menuVillage.radius * 0.45);
                const label = menuDistrict?.label ?? menuVillage.label;
                onCloseQuickMenu();
                onDiveToTarget(landX, landZ, label);
              }}
            >
              <WorldIcon name="sparkle" size={13} tone="amber" />
              <span>{t("theWorld.skyCmd.diveHere")}</span>
            </button>

            <button
              type="button"
              className="the-world-sky-cmd-btn is-notebook"
              onClick={() => {
                playDistrictSelect();
                const targetActorId = menuActor?.id ?? quickMenu.actorId;
                onCloseQuickMenu();
                onOpenNotebook(targetActorId);
              }}
            >
              <WorldIcon name="chat" size={13} tone="cerulean" />
              <span>{t("theWorld.skyCmd.openNotebook")}</span>
            </button>

            {activeOperationFlag && activeOperationFlag.villageId === menuVillage.id ? (
              <button
                type="button"
                className="the-world-sky-cmd-btn is-opflag-clear"
                onClick={() => {
                  playDistrictSelect();
                  if (onClearOperationFlag) onClearOperationFlag();
                  else setOperationFlag(null);
                  onStatusBanner(bi("작전 깃발을 회수했습니다.", "Operation flag cleared."));
                  onCloseQuickMenu();
                }}
              >
                <WorldIcon name="flag" size={13} tone="rose" />
                <span>{bi("깃발 회수", "Clear Flag")}</span>
              </button>
            ) : (
              <button
                type="button"
                className={`the-world-sky-cmd-btn is-opflag${flagFormOpen ? " is-active" : ""}`}
                onClick={() => {
                  playDistrictSelect();
                  if (!flagFormOpen && !flagDirective && draft.trim()) {
                    setFlagDirective(draft.trim());
                  }
                  setFlagFormOpen((prev) => !prev);
                }}
              >
                <WorldIcon name="flag" size={13} tone="amber" />
                <span>{bi("작전 깃발 꽂고 지시", "Plant Flag & Order")}</span>
              </button>
            )}
          </div>

          {flagFormOpen ? (
            <form
              className="the-world-opflag-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!menuVillage || sending) return;
                const directive = flagDirective.trim();
                if (!directive) return;
                const targetX = menuDistrict ? menuDistrict.x : menuVillage.x;
                const targetZ = menuDistrict ? menuDistrict.z : menuVillage.z;
                const targetLabel = menuDistrict?.label ?? menuVillage.label;
                const commodoreName = menuActor?.name ?? menuVillage.label;
                const payload: WorldOperationFlagDeployInput = {
                  villageId: menuVillage.id,
                  districtId: menuDistrict?.id,
                  commodoreId: quickMenu.commodoreId,
                  commodoreName,
                  label: targetLabel,
                  directive,
                  x: targetX,
                  z: targetZ,
                };
                playFlagPlant();
                if (onDeployOperationFlag) {
                  onDeployOperationFlag(payload);
                } else {
                  setOperationFlag({
                    ...payload,
                    id: `opflag:${Date.now()}`,
                    createdAt: Date.now(),
                  });
                  void deps.sendMessageToCommodore(quickMenu.commodoreId, directive);
                }
                setFlagDirective("");
                setFlagFormOpen(false);
                onCloseQuickMenu();
              }}
            >
              <input
                ref={flagInputRef}
                type="text"
                className="the-world-sky-cmd-input"
                value={flagDirective}
                maxLength={240}
                placeholder={bi("깃발 지시 내용을 1줄로 입력...", "Enter 1-line flag directive...")}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") setFlagFormOpen(false);
                }}
                onChange={(e) => setFlagDirective(e.target.value)}
              />
              <button
                type="submit"
                className="the-world-sky-cmd-send"
                disabled={flagDirective.trim().length === 0}
              >
                {bi("깃발 배치", "Deploy")}
              </button>
            </form>
          ) : null}
        </section>
      ) : null}
    </>
  );
});
