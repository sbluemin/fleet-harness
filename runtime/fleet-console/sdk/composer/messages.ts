import { createTranslator } from "../i18n/translate.js";
import type { ConsoleLocale, Translate } from "../i18n/types.js";

/**
 * 컴포저 첨부·「+」 메뉴의 문구 — 그룹 대화 입력창과 사령관 입력창이 한 벌을 쓴다.
 *
 * 같은 상한(`attachments.ts`)을 두 입력창이 서로 다른 말로 알리면 사람은 두 규칙이 있다고 읽는다. 그래서 문구도 상한과
 * 같은 자리에 둔다. 받는 이·보드처럼 표면마다 다른 말은 각 표면의 사전에 남는다.
 */
const en = {
  "composer.more": "Add to message",
  "composer.attach.image": "Attach image",
  "composer.attach.list": "Attached images",
  "composer.attach.pasted": "Pasted image",
  "composer.attach.remove": "Remove {name}",
  "composer.attach.limit": "Up to {count} images per message.",
  "composer.attach.tooLarge": "Each image must be {mb} MiB or smaller.",
  "composer.attach.failed": "Couldn't attach that image.",
  "composer.attach.commodoreBudget": "Images sent to the Commodore must total 8 MiB or less. Remove an image or choose smaller ones.",
  "composer.notice.dismiss": "Dismiss",
} as const;

export type ComposerMessageKey = keyof typeof en;

const ko: Record<ComposerMessageKey, string> = {
  "composer.more": "메시지에 추가",
  "composer.attach.image": "이미지 첨부",
  "composer.attach.list": "첨부한 이미지",
  "composer.attach.pasted": "붙여 넣은 이미지",
  "composer.attach.remove": "{name} 제거",
  "composer.attach.limit": "한 번에 이미지 {count}장까지 붙일 수 있습니다.",
  "composer.attach.tooLarge": "이미지 한 장은 {mb} MiB 이하여야 합니다.",
  "composer.attach.failed": "이미지를 첨부하지 못했습니다.",
  "composer.attach.commodoreBudget": "사령관에게 보내는 이미지의 합계는 8 MiB 이하여야 합니다. 이미지를 빼거나 작은 파일로 바꿔 주세요.",
  "composer.notice.dismiss": "닫기",
};

const translators: Record<ConsoleLocale, Translate<ComposerMessageKey>> = {
  en: createTranslator({ en, ko }, "en"),
  ko: createTranslator({ en, ko }, "ko"),
};

/** 컴포저 첨부 문구의 번역기 — 상태가 없는 상수 표라 호스트·플러그인 번들이 각자 적재해도 같은 말이다. */
export function composerT(locale: ConsoleLocale | undefined): Translate<ComposerMessageKey> {
  return translators[locale ?? "en"];
}
