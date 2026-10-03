import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { closeGlobalLinkCard, getGlobalLinkCardRequest, subscribeGlobalLinkCard } from "./global-link.js";
import { LinkOpenCard } from "./link-open-card.js";

/**
 * Operation 밖 Console의 링크 선택 카드 호스트 — Console 수명 동안 한 번 선다.
 * 카드는 전역 Shell과 같은 2행(Fleet 브라우저 / 내 브라우저)이다.
 */
export function GlobalLinkCardHost({ language }: { readonly language: ConsoleLocale | undefined }) {
  const request = React.useSyncExternalStore(subscribeGlobalLinkCard, getGlobalLinkCardRequest, () => null);
  if (request === null) return null;
  return (
    <LinkOpenCard
      key={request.serial}
      language={language}
      url={request.url}
      at={request.at}
      onClose={closeGlobalLinkCard}
    />
  );
}
