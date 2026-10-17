// 컴포저 빌딩블록의 core client 셔임 — effort-track.tsx와 같은 갈래다. 컴포넌트는 SDK가
// 소유하고(플러그인과 같은 부품을 쓴다), core는 경로만 접는다.
export {
  AttachImageIcon,
  ComposerAttachmentTray,
  ComposerBar,
  ComposerChip,
  ComposerField,
  ComposerInput,
  ComposerMenu,
  ComposerMenuItem,
  ComposerPlusButton,
  ComposerRestStrip,
  ComposerSubmitButton,
  composerAttachmentNoticeText,
  composerT,
  createComposerAttachments,
  renderUltracodeHighlight,
  SubmitArrowIcon,
  syncComposerHighlight,
  useComposerAttachmentInput,
  useComposerAttachmentSnapshot,
} from "@fleet-console/sdk/composer";
export type { ComposerAttachments } from "@fleet-console/sdk/composer";
