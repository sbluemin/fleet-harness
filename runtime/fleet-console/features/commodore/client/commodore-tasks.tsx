import { getT } from "./i18n/index.js";
import { CommodoreRoutines } from "./commodore-routines.js";
import { openCommanderConversation } from "../../workspace/client/commander-tab/commander-navigation.js";
import { openCommanderWindow } from "../../workspace/client/commander-tab/commander-window.js";
import type { CommodoreTasksList as TasksList } from "./deps.js";
import { commodoreTasksList } from "./commodore-state.js";

/**
 * 사령관 오른쪽 패널의 「작업」 탭 — 오른쪽 배치일 때 위 「목표」 섹션(지휘관 목록 카드)에 아래 「루틴」 섹션을 둔다.
 * 왼쪽 배치이면 목표 섹션이 없고 안내 문구도 없이 루틴만 선다. 목표 목록 렌더러는 조립이 넘긴다.
 */
export function CommodoreTasks({ commodoreId, language, selectedId }: {
  readonly commodoreId: string;
  readonly language: "en" | "ko";
  readonly selectedId: string | null;
}) {
  const tasks = commodoreTasksList();
  if (tasks === null) return <CommodoreRoutines commodoreId={commodoreId} language={language} />;
  return <CommodoreTasksInner commodoreId={commodoreId} language={language} selectedId={selectedId} tasks={tasks} />;
}

function CommodoreTasksInner({ commodoreId, language, selectedId, tasks }: {
  readonly commodoreId: string;
  readonly language: "en" | "ko";
  readonly selectedId: string | null;
  readonly tasks: TasksList;
}) {
  const t = getT(language);
  const placement = tasks.usePlacement();
  // 오른쪽 배치에만 목표·루틴 두 섹션이 선다. 왼쪽 배치의 루틴만은 그대로 둔다.
  if (placement !== "right") return <CommodoreRoutines commodoreId={commodoreId} language={language} />;
  return (
    <>
      <section className="objectives-commodore-panel-section" aria-label={t("commodore.tasks.goals")}>
        <tasks.List
          commodoreId={commodoreId}
          selectedId={selectedId}
          heading={(count) => <>{t("commodore.tasks.goals")} <span>{count}</span></>}
          onSelect={({ objectiveId, open, hasRecord }) => {
            // 목표 섹션에서 고르면 같은 떠 있는 창으로 바뀐다. 가운데는 사령관 대화 유지다.
            // 대화 기록이 없으면 시작 전 목표라 왼쪽 목록과 같은 시작 화면으로 보낸다.
            if (objectiveId !== null && hasRecord) openCommanderWindow(commodoreId, objectiveId, document.activeElement instanceof HTMLElement ? document.activeElement : null);
            else if (objectiveId !== null) openCommanderConversation(commodoreId, objectiveId);
            else open?.();
          }}
        />
      </section>
      <section className="objectives-commodore-panel-section" aria-label={t("commodore.tasks.routines")}>
        <h3 className="objectives-commodore-panel-title">{t("commodore.tasks.routines")}</h3>
        <CommodoreRoutines commodoreId={commodoreId} language={language} />
      </section>
    </>
  );
}
