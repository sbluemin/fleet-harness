/**
 * 컴포저 빌딩블록 패키지 — 한 벌의 부품, 여러 조립.
 *
 * Quick Launch(core client)와 채팅 컴포저(터미널 플러그인)가 같은 블록을 조립한다.
 * 블록은 구조·동작 문법만 소유한다: 클래스는 호출부가 싣고(스타일은 호스트 CSS 소유 —
 * "controlled, host-styled"), 상태(초안·선택·접힘)는 조립이 가진다. 호스트·플러그인 번들이
 * 이 모듈을 각자 적재하므로 모듈 스코프 싱글턴 상태는 금지다.
 */
export {
  COMPOSER_ATTACHMENT_MAX_BYTES,
  COMPOSER_MAX_ATTACHMENTS,
  isComposerAttachmentCandidate,
} from "./attachments.js";
export {
  EffortGaugeGlyph,
  EffortTrack,
  effortLadderPosition,
  gatedEffortNames,
  resolveRowEffort,
} from "./effort-track.js";
export type { EffortTrackProps } from "./effort-track.js";
export { ComposerInput } from "./input.js";
export type { ComposerInputProps } from "./input.js";
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
export { AttachImageIcon, SubmitArrowIcon } from "./icons.js";
