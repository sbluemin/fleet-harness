import { TheaterBadge, theaterInitials } from "@fleet-console/sdk/components/theater-badge";
import type { ExpandedSurfaceContext } from "@fleet-console/sdk/expanded-surface";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getT } from "../../agent/i18n/index.js";
import { useShellSession } from "./shell-session-store.js";

/**
 * 전역 Shell의 현재 위치만 보여 준다. 보고 있는 대화와 위치가 달라도 경고하지 않는다.
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
  return (
    <span className="global-shell-badge" aria-label={t("terminal.shell.badgeAria")}>
      <TheaterBadge label={label} initials={theater ? theaterInitials(theater.label) : "--"} {...(detail ? { detail } : {})} tone="normal" />
    </span>
  );
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
