import type { Translate } from "@fleet-console/sdk/i18n";

import type { UpdateSummary } from "../server/skill-types.js";
import type { SkillsMessageKey } from "./i18n/index.js";

/**
 * 업데이트가 끝난 뒤 무엇이 바뀌었는지 한 줄로 말한다. 요약이 없으면(lock을 읽지 못함) 바뀐 것이
 * 없다고 단정하지 않고 완료 사실만 말한다.
 */
export function updateResultLabel(summary: UpdateSummary | undefined, t: Translate<SkillsMessageKey>): string {
  if (!summary) return t("skills.status.updated");
  const { updated } = summary;
  if (updated.length === 0) return t("skills.update.resultNone");
  return t(updated.length === 1 ? "skills.update.resultSome_one" : "skills.update.resultSome_other", {
    count: updated.length,
    names: updated.join(", "),
  });
}
