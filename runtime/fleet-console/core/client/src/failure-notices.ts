import type { FailureNoticeProps } from "@fleet-console/sdk/components/failure-notice";

import type { CoreMessageKey } from "./i18n/index.js";

type Translate = (key: CoreMessageKey) => string;

/**
 * Console core가 소유하는 실패 코드를 사람이 읽는 세 조각으로 옮긴다.
 *
 * 매핑은 코드를 아는 쪽이 소유한다 — SDK는 형태만 고정하고 어떤 코드가 어떤 문장이 되는지는
 * 알지 않는다. 플러그인이 소유한 코드는 그 플러그인이 같은 방식으로 자기 매핑을 둔다.
 */
export function describeTheaterFolderFailure(code: string | undefined, t: Translate): FailureNoticeProps {
  const diagnostic = code;
  switch (code) {
    case "invalid_path":
      return {
        title: t("chrome.failure.folder.invalidPath.title"),
        cause: t("chrome.failure.folder.invalidPath.cause"),
        diagnostic,
        tone: "warn",
      };
    case "not_found":
      return {
        title: t("chrome.failure.folder.notFound.title"),
        cause: t("chrome.failure.folder.notFound.cause"),
        diagnostic,
        tone: "warn",
      };
    case "forbidden":
      return {
        title: t("chrome.failure.folder.forbidden.title"),
        cause: t("chrome.failure.folder.forbidden.cause"),
        diagnostic,
        tone: "warn",
      };
    case "invalid_folder":
      return {
        title: t("chrome.failure.folder.invalidFolder.title"),
        cause: t("chrome.failure.folder.invalidFolder.cause"),
        diagnostic,
        tone: "coral",
      };
    case "unauthorized":
    case "Unauthorized":
      return {
        title: t("chrome.failure.folder.unauthorized.title"),
        cause: t("chrome.failure.folder.unauthorized.cause"),
        diagnostic,
        tone: "coral",
      };
    default:
      return {
        title: t("chrome.failure.folder.generic.title"),
        cause: t("chrome.failure.folder.generic.cause"),
        diagnostic,
        tone: "warn",
      };
  }
}
