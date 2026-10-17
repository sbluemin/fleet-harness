/**
 * 컴포저 빌딩블록 패키지 — 한 벌의 부품, 여러 조립.
 *
 * 새 세션(core client)과 채팅 컴포저(터미널 플러그인)가 같은 블록을 조립한다. '@'·'/' 덱(`deck.tsx`)은 새 세션·사령관·
 * 지휘관/구성원·채팅 원장 네 곳이 같이 쓰는 한 벌이다.
 * 블록은 구조·동작 문법만 소유한다: 클래스는 호출부가 싣고(스타일은 호스트 CSS 소유 —
 * "controlled, host-styled"), 상태(초안·선택·접힘)는 조립이 가진다. 호스트·플러그인 번들이
 * 이 모듈을 각자 적재하므로 모듈 스코프 싱글턴 상태는 금지다.
 */
export {
  COMPOSER_ATTACHMENT_MAX_BYTES,
  COMPOSER_MAX_ATTACHMENTS,
  isComposerAttachmentCandidate,
  uploadComposerAttachment,
  discardComposerAttachment,
} from "./attachments.js";
export {
  createComposerAttachments,
  isComposerAttachmentExpired,
} from "./attachment-store.js";
export type {
  ComposerAttachmentDraftItem,
  ComposerAttachmentLimits,
  ComposerAttachmentNotice,
  ComposerAttachmentNoticeKind,
  ComposerAttachmentPort,
  ComposerAttachmentRecord,
  ComposerAttachments,
  ComposerAttachmentsSnapshot,
} from "./attachment-store.js";
export { useComposerAttachmentInput, useComposerAttachmentSnapshot } from "./attachment-input.js";
export {
  EffortGaugeGlyph,
  EffortTrack,
  effortLadderPosition,
  gatedEffortNames,
  resolveRowEffort,
} from "./effort-track.js";
export type { EffortTrackProps } from "./effort-track.js";
export { ComposerInput, SyncedTextarea, useTextareaValue } from "./input.js";
export type { ComposerInputProps, SyncedTextareaProps } from "./input.js";
export {
  ComposerAttachControl,
  ComposerBar,
  ComposerChip,
  ComposerField,
  ComposerRestStrip,
  ComposerSubmitButton,
} from "./primitives.js";
export type {
  ComposerAttachControlProps,
  ComposerChipProps,
  ComposerSubmitButtonProps,
} from "./primitives.js";
export {
  MENTION_CHIP_CLASS,
  MENTION_CHIP_LABEL_CLASS,
  MENTION_CHIP_MARK_CLASS,
  MENTION_CHIP_REMOVE_CLASS,
  MentionChip,
  mentionChipElement,
  mentionChipHtml,
} from "./mention-chip.js";
export type { MentionChipMarkup, MentionChipProps } from "./mention-chip.js";
export { AttachImageIcon, SubmitArrowIcon } from "./icons.js";
export {
  ComposerAttachmentTray,
  ComposerAttachmentViewer,
  ComposerMenu,
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerNotice,
  ComposerPlusButton,
  ComposerSendButton,
} from "./attachment-surface.js";
export type {
  ComposerAttachmentItem,
  ComposerAttachmentTrayProps,
  ComposerAttachmentViewImage,
  ComposerMenuItemProps,
  ComposerNoticeProps,
} from "./attachment-surface.js";
export {
  ComposerDeck,
  ComposerDeckBand,
  ComposerDeckCategory,
  ComposerDeckEmpty,
  ComposerDeckGroup,
  ComposerDeckRow,
  composerDeckActiveIndex,
  composerDeckKeyDown,
} from "./deck.js";
export type { ComposerDeckKeyEvent, ComposerDeckKeyRow, ComposerDeckProps, ComposerDeckRowProps } from "./deck.js";
export { composerAttachmentNoticeText, composerT } from "./messages.js";
export {
  COMPOSER_MAX_QUOTES,
  COMPOSER_QUOTE_LINE_PREFIX,
  COMPOSER_QUOTE_MAX_EXCERPT,
  COMPOSER_QUOTE_MAX_LABEL,
  COMPOSER_QUOTE_MAX_NOTE,
  COMPOSER_QUOTE_MAX_REF,
  composeQuotedPrompt,
  composerQuoteValues,
  createComposerQuotes,
  normalizeComposerQuote,
  normalizeComposerQuotes,
  splitQuotedPrompt,
} from "./quotes.js";
export type {
  ComposerQuote,
  ComposerQuoteAttachResult,
  ComposerQuoteItem,
  ComposerQuoteKind,
  ComposerQuotes,
  ComposerQuoteSource,
  ComposerQuoteTarget,
} from "./quotes.js";
export { ComposerQuoteList, ComposerQuoteTray, composerQuotePlaceholder, useComposerQuotes } from "./quote-tray.js";
export type { ComposerQuoteTrayProps } from "./quote-tray.js";
export type { ComposerMessageKey } from "./messages.js";
export {
  isUltracodeDisarmCaret,
  nextUltracodeIgnored,
  readUltracodeTokens,
  renderUltracodeHighlight,
  syncComposerHighlight,
} from "./ultracode.js";
export type { UltracodeToken } from "./ultracode.js";
