import type { OnboardingContribution } from "@fleet-console/sdk/onboarding";

import { browserOnboarding } from "../../../../features/browser/client/onboarding.js";
import { executionOnboarding } from "../../../../features/execution/client/onboarding.js";
import { remoteAccessOnboarding } from "../../../../features/remote-access/client/onboarding.js";
import { workspaceOnboarding } from "../../../../features/workspace/client/onboarding.js";

/**
 * Console 코어 기능의 온보딩 기여 — 나열만 한다. 내용은 각 기능이 소유하고, 이 순서가 같은 단계 안의 재생 순서다
 * (먼저 선 투어가 같은 화면에서 이긴다). 플러그인 기여는 플러그인 레지스트리가 모아 이 목록 뒤에 선다.
 */
export const CORE_ONBOARDING: readonly OnboardingContribution[] = [
  workspaceOnboarding,
  executionOnboarding,
  browserOnboarding,
  remoteAccessOnboarding,
];
