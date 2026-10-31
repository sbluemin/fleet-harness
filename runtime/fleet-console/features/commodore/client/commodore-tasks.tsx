import { getT } from "./i18n/index.js";
import { CommodoreRoutines } from "./commodore-routines.js";
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
  return (
    <>
      {placement === "right" ? (
        <section className="objectives-commodore-panel-section" aria-label={t("commodore.tasks.goals")}>
          <tasks.List commodoreId={commodoreId} selectedId={selectedId} heading={(count) => <>{t("commodore.tasks.goals")} <span>{count}</span></>} />
        </section>
      ) : null}
      <CommodoreRoutines commodoreId={commodoreId} language={language} />
    </>
  );
}
