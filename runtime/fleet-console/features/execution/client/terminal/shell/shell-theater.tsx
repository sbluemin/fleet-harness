import { TheaterBadge, theaterInitials } from "@fleet-console/sdk/components/theater-badge";
import type { ExpandedSurfaceContext } from "@fleet-console/sdk/expanded-surface";
import type { ShellOpenAtResult } from "@fleet-console/sdk/navigation";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getT } from "../../agent/i18n/index.js";
import { useShellSession, type ShellSessionState } from "./shell-session-store.js";

/**
 * Shell이 지금 어느 Theater에 서 있는지(K-02 B). Shell은 콘솔에 하나라 활성 Theater를 따라 움직이지
 * 않는다 — 그래서 위치를 늘 보여 주고, 활성 Theater와 갈리면 경고 톤으로 그린다.
 */
export function ShellTheaterBadge({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  const session = useShellSession();
  const theaters = useTheaters(ctx);
  const t = getT(ctx.language ?? "en");
  if (!session?.open || !session.cwd) return null;
  const theater = session.cwd.theaterId ? theaters.find((item) => item.id === session.cwd?.theaterId) : undefined;
  const label = theater?.label ?? t("terminal.shell.outsideTheaters");
  const detail = !session.cwdTracked
    ? t("terminal.shell.untracked")
    : session.cwd.relative ? session.cwd.relative : undefined;
  const mismatched = ctx.theaterId !== null && session.cwd.theaterId !== ctx.theaterId;
  return (
    <span className="global-shell-badge" aria-label={t("terminal.shell.badgeAria")}>
      <TheaterBadge label={label} initials={theater ? theaterInitials(theater.label) : "--"} {...(detail ? { detail } : {})} tone={mismatched ? "warning" : "normal"} />
    </span>
  );
}

type BandStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "confirm-restart" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * 활성 Theater와 Shell 위치가 갈렸을 때만 서는 띠. 옮기기는 프롬프트에서만 하고(서버가 판정한다),
 * 새로 시작하기는 돌고 있는 프로그램을 끝내므로 확인을 한 번 더 받는다.
 */
export function ShellTheaterBand({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  const session = useShellSession();
  const theaters = useTheaters(ctx);
  const t = getT(ctx.language ?? "en");
  const [status, setStatus] = React.useState<BandStatus>({ kind: "idle" });
  const activeTheaterId = ctx.theaterId;
  const mismatch = readMismatch(session, activeTheaterId);

  // 위치가 맞춰지면(이동·재시작 성공, 사용자가 직접 cd) 지난 거절 문구를 거둔다.
  React.useEffect(() => {
    if (!mismatch) setStatus({ kind: "idle" });
  }, [mismatch]);

  if (!mismatch || !activeTheaterId) return null;
  const active = theaters.find((item) => item.id === activeTheaterId)?.label ?? activeTheaterId;
  const mismatchText = mismatch.theaterId
    ? t("terminal.shell.mismatch", { shell: theaters.find((item) => item.id === mismatch.theaterId)?.label ?? mismatch.theaterId, active })
    : t("terminal.shell.mismatchOutside", { active });

  const settle = (result: ShellOpenAtResult) => {
    if (result.ok) setStatus({ kind: "idle" });
    else setStatus({ kind: "refused", message: describeRefusal(result.reason, t) });
  };
  const move = () => {
    setStatus({ kind: "pending" });
    ctx.shell.openAt({ theaterId: activeTheaterId }).then(settle, () => setStatus({ kind: "refused", message: t("terminal.shell.failed") }));
  };
  const restart = () => {
    setStatus({ kind: "pending" });
    ctx.shell.restartAt({ theaterId: activeTheaterId }).then(settle, () => setStatus({ kind: "refused", message: t("terminal.shell.failed") }));
  };
  const pending = status.kind === "pending";
  const fullMessage = status.kind === "confirm-restart"
    ? t("terminal.shell.restartConfirm", { active })
    : status.kind === "refused" ? `${mismatchText} · ${status.message}` : mismatchText;
  const label = (full: string, compact: string) => <><span className="global-shell-band-full">{full}</span><span className="global-shell-band-compact">{compact}</span></>;

  return (
    <div className="global-shell-band" role="status" aria-label={fullMessage} title={fullMessage}>
      {status.kind === "confirm-restart" ? (
        <>
          <span className="global-shell-band-text is-confirm" aria-hidden="true">{label(fullMessage, t("terminal.shell.compactRestartConfirm", { active }))}</span>
          <span className="global-shell-band-actions">
            <button type="button" className="global-shell-band-action is-danger" onClick={restart} aria-label={t("terminal.shell.restartConfirmAction")} title={t("terminal.shell.restartConfirmAction")}>{t("terminal.shell.restartConfirmAction")}</button>
            <button type="button" className="global-shell-band-action" onClick={() => setStatus({ kind: "idle" })}>{t("terminal.shell.cancel")}</button>
          </span>
        </>
      ) : (
        <>
          {/* 띠는 한 줄 고정 높이다 — 거절 문구가 줄을 늘리면 터미널 행 수가 바뀌어 PTY가 리사이즈된다.
              넘치는 문구는 말줄임으로 접고 전체 문장은 title로 준다(role=status가 읽어 준다). */}
          <span className="global-shell-band-text" aria-hidden="true">
            <span className="global-shell-band-full">
              {status.kind === "refused" ? <span className="global-shell-band-refusal">{status.message}</span> : null}
              {mismatchText}
            </span>
            <span className="global-shell-band-compact">{t("terminal.shell.compactMismatch")}</span>
          </span>
          <span className="global-shell-band-actions">
            <button type="button" className="global-shell-band-action" disabled={pending} onClick={move} aria-label={t("terminal.shell.moveTo", { active })} title={t("terminal.shell.moveTo", { active })}>{label(t("terminal.shell.moveTo", { active }), t("terminal.shell.compactMove"))}</button>
            <button type="button" className="global-shell-band-action" disabled={pending} onClick={() => setStatus({ kind: "confirm-restart" })} aria-label={t("terminal.shell.startFresh")} title={t("terminal.shell.startFresh")}>{label(t("terminal.shell.startFresh"), t("terminal.shell.compactFresh"))}</button>
          </span>
        </>
      )}
    </div>
  );
}

function readMismatch(session: ShellSessionState | null, activeTheaterId: string | null): { readonly theaterId: string | null } | null {
  if (!session?.open || !session.cwd || !activeTheaterId) return null;
  return session.cwd.theaterId === activeTheaterId ? null : { theaterId: session.cwd.theaterId };
}

function describeRefusal(reason: Exclude<ShellOpenAtResult, { ok: true }>["reason"], t: ReturnType<typeof getT>): string {
  switch (reason) {
    case "busy": return t("terminal.shell.busy");
    case "input_pending": return t("terminal.shell.inputPending");
    case "read_only": return t("terminal.shell.readOnly");
    case "not_found": return t("terminal.shell.notFound");
    case "outside_theater": return t("terminal.shell.outsideTheater");
  }
}

type TheaterList = ReturnType<ExpandedSurfaceContext["consoleState"]["getTheaters"]>;

/**
 * Theater 목록. 호스트의 `getTheaters()`는 부를 때마다 새 배열을 주므로, 내용이 같으면 앞의 배열을
 * 돌려줘 useSyncExternalStore가 무한히 다시 그리지 않게 한다.
 */
function useTheaters(ctx: ExpandedSurfaceContext): TheaterList {
  const cache = React.useRef<TheaterList>([]);
  const read = React.useCallback(() => {
    const next = ctx.consoleState.getTheaters();
    const previous = cache.current;
    const same = next.length === previous.length
      && next.every((theater, index) => theater.id === previous[index]?.id && theater.label === previous[index]?.label);
    if (!same) cache.current = next;
    return cache.current;
  }, [ctx.consoleState]);
  return React.useSyncExternalStore(ctx.consoleState.subscribe, read, read);
}
