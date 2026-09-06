import type { MentionTargetDescriptor } from "@fleet-console/sdk/plugin";
import { definePlugin } from "@fleet-console/sdk/plugin/browser";

import { connectConsoleRead, isConsoleReadEnabled } from "./console-read.js";

import type { AdmiralId } from "./chat-session.js";
import { ScuttlebuttFlock } from "./flock.js";
import { readScuttlebuttMentionBridge } from "./mention-bridge.js";
import { QUAKER_HEAD_VIEW_BOX, QuakerFigure } from "./quaker-figure.js";
import { getT } from "./scuttlebutt-catalog.js";
import { scuttlebuttSettingsSection } from "./settings-section.js";
import { connectScuttlebuttSettings } from "./settings-store.js";
import "./styles.css";

/**
 * Quick Launch '@' 덱에 서는 부관들.
 *
 * 근무 중인 부관만 낸다 — 꺼 둔 부관을 흐리게라도 세우면 덱에 고를 수 없는 줄이 생기고, 고르는
 * 순간 켜 준다면 사용자가 꺼 둔 설정을 제품이 뒤집는다. 셋 다 꺼져 있으면 카테고리 자체가 서지
 * 않는다: 이 기능의 발견은 설정 섹션이 지고, 덱은 이미 부관을 들인 사람의 지름길이다.
 */
function mentionTargets(): readonly MentionTargetDescriptor[] {
  const bridge = readScuttlebuttMentionBridge();
  if (!bridge) return [];
  const t = getT(bridge.locale());
  return bridge.onDuty().map((admiral) => ({
    id: admiral,
    label: bridge.label(admiral),
    categoryLabel: t("mention.category"),
    capabilityLabel: t(isConsoleReadEnabled() ? "mention.capabilityConsole" : "mention.capability"),
    description: t(isConsoleReadEnabled() ? "mention.descriptionConsole" : "mention.description", { name: bridge.label(admiral) }),
    renderMark: () => <QuakerFigure morph={admiral} viewBox={QUAKER_HEAD_VIEW_BOX} />,
  }));
}

async function messageMentionTarget(targetId: string, text: string): Promise<void> {
  const bridge = readScuttlebuttMentionBridge();
  // 덱을 연 뒤 부관이 퇴근했을 수 있다 — 없는 대상에 보내는 것은 조용히 삼키지 않고 거절한다.
  if (!bridge || !bridge.onDuty().includes(targetId as AdmiralId)) {
    throw new Error("mention_target_gone");
  }
  await bridge.ask(targetId as AdmiralId, text);
}

const scuttlebuttPlugin = definePlugin({
  id: "scuttlebutt",
  floatingWidgets: [{ id: "mascot", render: (context) => <ScuttlebuttFlock context={context} /> }],
  settingsSections: [scuttlebuttSettingsSection],
  mentionTargets,
  messageMentionTarget,
  install: (context) => {
    connectConsoleRead(context);
    return connectScuttlebuttSettings(context.settings);
  },
});

export const plugins = [scuttlebuttPlugin] as const;
