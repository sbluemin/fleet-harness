import { createTranslator } from "@fleet-console/i18n/translate";
import type { ConsoleLocale, Translate } from "@fleet-console/i18n";
import { COMPOSER_ATTACHMENT_MAX_BYTES, COMPOSER_MAX_ATTACHMENTS } from "./attachments.js";
import type { ComposerAttachmentNotice } from "./attachment-store.js";

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
  "composer.attach.unsupported": "Only PNG, JPEG, GIF, or WebP images can be attached.",
  "composer.attach.storage": "Too many unsent images are waiting. Remove one, or try again later.",
  "composer.attach.expired": "An attached image expired and was removed. Paste it again.",
  "composer.attach.open": "View {name}",
  "composer.attach.close": "Close",
  "composer.attach.previous": "Previous image",
  "composer.attach.next": "Next image",
  "composer.attach.edit": "Edit {name}",
  "composer.attach.edited": "Edited",
  "composer.attach.openEdited": "View {name}, edited",
  "composer.attach.tools": "Editing tools",
  "composer.attach.pen": "Pen",
  "composer.attach.shape": "Shape",
  "composer.attach.textTool": "Text",
  "composer.attach.cover": "Cover",
  "composer.attach.line": "Line",
  "composer.attach.arrow": "Arrow",
  "composer.attach.rect": "Rectangle",
  "composer.attach.ellipse": "Ellipse",
  "composer.attach.step": "Step",
  "composer.attach.solid": "Solid",
  "composer.attach.mosaic": "Mosaic",
  "composer.attach.color": "Color",
  "composer.attach.color.red": "Red",
  "composer.attach.color.blue": "Blue",
  "composer.attach.color.green": "Green",
  "composer.attach.color.black": "Black",
  "composer.attach.color.white": "White",
  "composer.attach.width": "Thickness",
  "composer.attach.width.thin": "Thin",
  "composer.attach.width.medium": "Medium",
  "composer.attach.width.thick": "Thick",
  "composer.attach.width.heavy": "Extra thick",
  "composer.attach.undo": "Undo",
  "composer.attach.redo": "Redo",
  "composer.attach.clear": "Clear all",
  "composer.attach.save": "Save",
  "composer.attach.revert": "Use original",
  "composer.attach.exitEdit": "Close editor",
  "composer.attach.unsaved": "This edit isn't saved.",
  "composer.attach.discard": "Discard",
  "composer.attach.keep": "Keep editing",
  "composer.attach.textInput": "Text",
  "composer.attach.saving": "Saving",
  "composer.attach.commodoreBudget": "Images sent to the Commodore must total 8 MiB or less. Remove an image or choose smaller ones.",
  "composer.notice.dismiss": "Dismiss",
  "composer.quote.list": "Attached quotes",
  "composer.quote.comment": "Comment",
  "composer.quote.question": "Question",
  "composer.quote.kind": "Kind",
  "composer.quote.edit": "Edit the note for “{excerpt}”",
  "composer.quote.remove": "Remove quote “{excerpt}”",
  "composer.quote.notePlaceholder": "A line for this quote only (optional)",
  "composer.quote.save": "Save",
  "composer.quote.editorHint": "Enter saves · Esc closes",
  "composer.quote.placeholder": "{count} quotes attached. Write your instruction…",
  "composer.quote.placeholderOne": "1 quote attached. Write your instruction…",
  "composer.quote.from": "Quoted from {source}",
} as const;

export type ComposerMessageKey = keyof typeof en;

const ko: Record<ComposerMessageKey, string> = {
  "composer.more": "메시지에 추가",
  "composer.attach.image": "이미지 첨부",
  "composer.attach.list": "첨부한 이미지",
  "composer.attach.pasted": "붙여 넣은 이미지",
  "composer.attach.remove": "{name} 제거",
  "composer.attach.limit": "한 번에 이미지를 {count}장까지 붙일 수 있어요.",
  "composer.attach.tooLarge": "이미지 한 장은 {mb} MiB 이하여야 해요.",
  "composer.attach.failed": "이미지를 첨부하지 못했어요.",
  "composer.attach.unsupported": "PNG·JPEG·GIF·WebP 이미지만 첨부할 수 있어요.",
  "composer.attach.storage": "보내지 않은 이미지가 너무 많이 쌓였어요. 하나를 빼거나 잠시 뒤 다시 시도해 주세요.",
  "composer.attach.expired": "첨부한 이미지가 만료되어 빠졌어요. 다시 붙여 넣어 주세요.",
  "composer.attach.open": "{name} 크게 보기",
  "composer.attach.close": "닫기",
  "composer.attach.previous": "이전 이미지",
  "composer.attach.next": "다음 이미지",
  "composer.attach.edit": "{name} 편집",
  "composer.attach.edited": "편집됨",
  "composer.attach.openEdited": "{name} 크게 보기, 편집됨",
  "composer.attach.tools": "편집 도구",
  "composer.attach.pen": "펜",
  "composer.attach.shape": "도형",
  "composer.attach.textTool": "텍스트",
  "composer.attach.cover": "가리기",
  "composer.attach.line": "선",
  "composer.attach.arrow": "화살표",
  "composer.attach.rect": "사각형",
  "composer.attach.ellipse": "타원",
  "composer.attach.step": "단계",
  "composer.attach.solid": "단색",
  "composer.attach.mosaic": "모자이크",
  "composer.attach.color": "색",
  "composer.attach.color.red": "빨간색",
  "composer.attach.color.blue": "파란색",
  "composer.attach.color.green": "녹색",
  "composer.attach.color.black": "검정색",
  "composer.attach.color.white": "흰색",
  "composer.attach.width": "굵기",
  "composer.attach.width.thin": "가늘게",
  "composer.attach.width.medium": "중간",
  "composer.attach.width.thick": "굵게",
  "composer.attach.width.heavy": "매우 굵게",
  "composer.attach.undo": "실행 취소",
  "composer.attach.redo": "다시 실행",
  "composer.attach.clear": "모두 지우기",
  "composer.attach.save": "저장",
  "composer.attach.revert": "원본으로",
  "composer.attach.exitEdit": "편집 닫기",
  "composer.attach.unsaved": "저장하지 않은 편집이 있어요.",
  "composer.attach.discard": "버리기",
  "composer.attach.keep": "계속 편집",
  "composer.attach.textInput": "텍스트",
  "composer.attach.saving": "저장하는 중",
  "composer.attach.commodoreBudget": "사령관에게 보내는 이미지는 합계 8 MiB 이하여야 해요. 이미지를 빼거나 더 작은 파일로 바꿔 주세요.",
  "composer.notice.dismiss": "닫기",
  "composer.quote.list": "붙인 인용",
  "composer.quote.comment": "댓글",
  "composer.quote.question": "질문",
  "composer.quote.kind": "종류",
  "composer.quote.edit": "“{excerpt}” 메모 고치기",
  "composer.quote.remove": "인용 “{excerpt}” 빼기",
  "composer.quote.notePlaceholder": "이 인용에만 붙일 한 줄 (선택)",
  "composer.quote.save": "저장",
  "composer.quote.editorHint": "Enter 저장 · Esc 닫기",
  "composer.quote.placeholder": "인용 {count}개를 붙였어요. 지시를 입력해 주세요…",
  "composer.quote.placeholderOne": "인용 1개를 붙였어요. 지시를 입력해 주세요…",
  "composer.quote.from": "{source}에서 인용",
};

const translators: Record<ConsoleLocale, Translate<ComposerMessageKey>> = {
  en: createTranslator({ en, ko }, "en"),
  ko: createTranslator({ en, ko }, "ko"),
};

/** 컴포저 첨부 문구의 번역기 — 상태가 없는 상수 표라 호스트·플러그인 번들이 각자 적재해도 같은 말이다. */
export function composerT(locale: ConsoleLocale | undefined): Translate<ComposerMessageKey> {
  return translators[locale ?? "en"];
}

/** 스토어 안내를 한 벌의 말로 옮긴다. 표면 고유 안내(사령관 합계, 능력 없음)는 여기 두지 않는다. */
export function composerAttachmentNoticeText(notice: ComposerAttachmentNotice | null, t: Translate<ComposerMessageKey>): string | null {
  if (notice === null) return null;
  switch (notice.kind) {
    case "limit": return t("composer.attach.limit", { count: String(COMPOSER_MAX_ATTACHMENTS) });
    case "tooLarge": return t("composer.attach.tooLarge", { mb: String(Math.round(COMPOSER_ATTACHMENT_MAX_BYTES / (1024 * 1024))) });
    case "expired": return t("composer.attach.expired");
    case "unsupported": return t("composer.attach.unsupported");
    case "storage": return t("composer.attach.storage");
    case "failed": return t("composer.attach.failed");
  }
}
