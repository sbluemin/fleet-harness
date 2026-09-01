import type { ReactNode } from "react";

import { SettingsHelpTip } from "@fleet-console/sdk/settings/browser";

import { useT } from "../i18n/index.js";

/**
 * 코어 설정 표면의 '?' 래퍼 — 접근성 이름("{제목} 도움말")을 코어 카탈로그에서 조립한다.
 * 플러그인은 SDK의 SettingsHelpTip에 자기 카탈로그로 같은 꼴을 만들어 넘긴다.
 */
export function SettingsHelp({ title, id, children }: {
  readonly title: string;
  readonly id?: string;
  readonly children: ReactNode;
}) {
  const t = useT();
  return (
    <SettingsHelpTip ariaLabel={t("settings.helpTip.aria", { title })} id={id}>
      {children}
    </SettingsHelpTip>
  );
}
