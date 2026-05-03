/**
 * metaphor.ts — Metaphor 도메인 Pi 통합 진입점
 *
 * worldview 커맨드, 작전명 설정, 지령 재다듬기 설정/실행을 단일 파일에서 등록한다.
 */

import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  infra,
  metaphor,
  type DirectiveRefinementSettings,
  type DirectiveReasoningLevel,
  type OperationNameSettings,
  type OperationReasoningLevel,
} from "@sbluemin/fleet-core";

import { getKeybindAPI } from "./keybinds.js";
import { completeSimple } from "./provider.js";
import type { Api, Model, ThinkingLevel } from "./provider.js";

const {
  composeDirectiveRefinementRequest,
  constants: directiveConstants,
  settings: directiveSettings,
  isValidReasoning: isValidDirectiveReasoning,
  SECTION_KEY: DIRECTIVE_SECTION_KEY,
} = metaphor.directiveRefinement;
const {
  constants: operationConstants,
  settings: operationSettings,
  isValidReasoning: isValidOperationReasoning,
} = metaphor.operationName;
const { isWorldviewEnabled, setWorldviewEnabled } = metaphor.worldview;
const {
  loadSettings: loadDirectiveSettings,
  saveSettings: saveDirectiveSettings,
} = directiveSettings;
const {
  REASONING_COLORS: DIRECTIVE_REASONING_COLORS,
  REASONING_LABELS: DIRECTIVE_REASONING_LABELS,
  REASONING_LEVELS: DIRECTIVE_REASONING_LEVELS,
  REFINE_DIRECTIVE_COMMAND,
} = directiveConstants;
const {
  loadSettings: loadOperationSettings,
  saveSettings: saveOperationSettings,
} = operationSettings;
const {
  REASONING_LABELS: OPERATION_REASONING_LABELS,
  REASONING_LEVELS: OPERATION_REASONING_LEVELS,
} = operationConstants;

export function registerMetaphor(ctx: ExtensionAPI): void {
  registerWorldviewCommand(ctx);
  registerDirectiveRefinement(ctx);
  registerOperationName(ctx);
}

export default registerMetaphor;

export function resolveDirectiveRefinementModel(
  ctx: ExtensionContext,
  settings: DirectiveRefinementSettings,
): Model<Api> | null {
  const { provider, model: modelId } = settings;
  if (!provider && modelId?.startsWith("acp:")) {
    ctx.ui.notify(
      "기존 ACP 전용 지령 재다듬기 설정은 그대로 복원할 수 없습니다. /fleet:metaphor:directive 로 재설정하세요.",
      "error",
    );
    return null;
  }

  const resolved = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : ctx.model;

  if (!resolved) {
    const hint =
      provider && modelId
        ? `모델을 찾을 수 없습니다: ${provider}/${modelId} — /fleet:metaphor:directive 로 재설정하세요.`
        : "모델이 선택되지 않았습니다. /fleet:metaphor:directive 로 설정하세요.";
    ctx.ui.notify(hint, "error");
  }

  return resolved ?? null;
}

export async function refineDirectiveWithLoader(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
  userDirective: string,
  reasoning: DirectiveReasoningLevel,
): Promise<string | null> {
  const reasoningLabel = DIRECTIVE_REASONING_LABELS[reasoning];
  const worldviewEnabled = isWorldviewEnabled();

  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(
      tui,
      theme,
      `${
        worldviewEnabled
          ? "지령 재다듬기 가동 중..."
          : "프롬프트 다듬는 중..."
      } (${model.id} · reasoning: ${reasoningLabel})`,
    );
    loader.onAbort = () => done(null);

    const doRefinement = async () => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        throw new Error(auth.error);
      }

      if (!auth.apiKey && !auth.headers && ctx.modelRegistry.isUsingOAuth(model)) {
        throw new Error(
          `OAuth 인증 정보를 사용할 수 없습니다: ${model.provider}/${model.id} — /login ${model.provider} 로 다시 인증하세요.`,
        );
      }

      const composed = composeDirectiveRefinementRequest({ worldviewEnabled, userDirective });
      const response = await completeSimple(
        model,
        {
          systemPrompt: composed.systemPrompt,
          messages: composed.messages.map((message) => ({ ...message, timestamp: Date.now() })),
        },
        {
          ...(auth.apiKey && { apiKey: auth.apiKey }),
          ...(auth.headers && { headers: auth.headers }),
          signal: loader.signal,
          ...(reasoning !== "off" && { reasoning: reasoning as ThinkingLevel }),
        },
      );

      if (response.stopReason === "aborted") return null;

      const refinedDirective = response.content
        .filter((content): content is { type: "text"; text: string } => content.type === "text")
        .map((content) => content.text)
        .join("\n");

      return refinedDirective.trim() || null;
    };

    doRefinement()
      .then(done)
      .catch((error) => {
        ctx.ui.notify(
          `${
            worldviewEnabled
              ? "지령 재다듬기 실패"
              : "프롬프트 다듬기 실패"
          }: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        done(null);
      });

    return loader;
  });
}

function registerWorldviewCommand(pi: ExtensionAPI): void {
  pi.registerCommand("metaphor:worldview", {
    description: "metaphor PERSONA/TONE worldview 토글 (on/off)",
    handler: async (_args, ctx) => {
      const current = isWorldviewEnabled();
      const next = !current;
      setWorldviewEnabled(next);
      ctx.ui.notify(
        `Metaphor Worldview → ${next ? "ON" : "OFF"} (다음 턴부터 적용)`,
        "info",
      );
    },
  });
}

function registerOperationName(pi: ExtensionAPI): void {
  let currentReasoning = resolveCurrentOperationReasoning();

  pi.registerCommand("fleet:metaphor:operation", {
    description: "작전명 자동 생성 설정 (모델 + reasoning 레벨)",
    handler: async (_args, ctx) => {
      const currentSettings = loadOperationSettings();
      const sourceOptions = [
        `세션 모델 사용 (ctx.model)${!currentSettings.provider ? " [current]" : ""}`,
        `모델 직접 선택${currentSettings.provider ? " [current]" : ""}`,
      ];
      const sourceChoice = await ctx.ui.select(
        "작전명 생성 모델 소스:",
        sourceOptions,
      );
      if (sourceChoice === undefined) {
        ctx.ui.notify("설정이 취소되었습니다.", "warning");
        return;
      }

      const newSettings: OperationNameSettings = { reasoning: currentReasoning };

      if (sourceChoice.startsWith("모델 직접 선택")) {
        const allModels = ctx.modelRegistry.getAvailable();
        if (allModels.length === 0) {
          ctx.ui.notify(
            "사용 가능한 모델이 없습니다. API 키를 설정하세요.",
            "error",
          );
          return;
        }

        const providerMap = new Map<string, Model<Api>[]>();
        for (const model of allModels) {
          const group = providerMap.get(model.provider) ?? [];
          group.push(model);
          providerMap.set(model.provider, group);
        }

        const providers = [...providerMap.keys()];
        const providerOptions = providers.map((provider) => {
          const count = providerMap.get(provider)!.length;
          const marker = provider === currentSettings.provider ? " [current]" : "";
          return `${provider} (${count} models)${marker}`;
        });

        const providerChoice = await ctx.ui.select(
          "프로바이더 선택:",
          providerOptions,
        );
        if (providerChoice === undefined) {
          ctx.ui.notify("설정이 취소되었습니다.", "warning");
          return;
        }

        const selectedProvider = providerChoice.split(" (")[0]!;
        const models = providerMap.get(selectedProvider)!;
        const modelOptions = models.map((model) => {
          const marker =
            model.provider === currentSettings.provider && model.id === currentSettings.model
              ? " [current]"
              : "";
          return `${model.id} — ${model.name}${marker}`;
        });

        const modelChoice = await ctx.ui.select(
          `${selectedProvider} 모델 선택:`,
          modelOptions,
        );
        if (modelChoice === undefined) {
          ctx.ui.notify("설정이 취소되었습니다.", "warning");
          return;
        }

        const selectedModelId = modelChoice.split(" — ")[0]!.trim();
        newSettings.provider = selectedProvider;
        newSettings.model = selectedModelId;
      }

      const reasoningOptions = OPERATION_REASONING_LEVELS.map((level) => {
        const marker = level === currentReasoning ? " ✓" : "";
        return `${OPERATION_REASONING_LABELS[level]}${marker}`;
      });

      const reasoningChoice = await ctx.ui.select("Reasoning 레벨:", reasoningOptions);
      if (reasoningChoice === undefined) {
        ctx.ui.notify("설정이 취소되었습니다.", "warning");
        return;
      }

      const reasoningIdx = reasoningOptions.indexOf(reasoningChoice);
      currentReasoning = OPERATION_REASONING_LEVELS[reasoningIdx]!;
      newSettings.reasoning = currentReasoning;

      saveOperationSettings(newSettings);

      const modelSummary =
        newSettings.provider && newSettings.model
          ? `${newSettings.provider}/${newSettings.model}`
          : "세션 모델";
      ctx.ui.notify(
        `설정 저장 완료: 모델=${modelSummary}, reasoning=${OPERATION_REASONING_LABELS[currentReasoning]}`,
        "info",
      );
    },
  });
}

function registerDirectiveRefinement(pi: ExtensionAPI): void {
  const initialSettings = loadDirectiveSettings();
  const worldviewAtRegister = isWorldviewEnabled();
  let currentReasoning: DirectiveReasoningLevel =
    initialSettings.reasoning && isValidDirectiveReasoning(initialSettings.reasoning)
      ? initialSettings.reasoning
      : "off";

  const settingsApi = infra.settings.getSettingsService();
  settingsApi?.registerSection({
    key: DIRECTIVE_SECTION_KEY,
    displayName: "Directive Refinement",
    getDisplayFields() {
      const settings = loadDirectiveSettings();
      return [
        { label: "Model", value: settings.model || "session model", color: settings.model ? "accent" : "dim" },
        { label: "Provider", value: settings.provider || "session model", color: settings.provider ? "accent" : "dim" },
        {
          label: "Reasoning",
          value: DIRECTIVE_REASONING_LABELS[currentReasoning],
          color: DIRECTIVE_REASONING_COLORS[currentReasoning],
        },
      ];
    },
  });

  pi.registerCommand(REFINE_DIRECTIVE_COMMAND, {
    description: "작전 지령 재다듬기 설정 (모델 선택 + reasoning 레벨)",
    handler: async (_args, ctx) => {
      const currentSettings = loadDirectiveSettings();
      const sourceOptions = [
        `세션 모델 사용 (ctx.model)${!currentSettings.provider ? " [current]" : ""}`,
        `모델 직접 선택${currentSettings.provider ? " [current]" : ""}`,
      ];
      const sourceChoice = await ctx.ui.select("지령 재다듬기 모델 소스:", sourceOptions);
      if (sourceChoice === undefined) {
        ctx.ui.notify("설정이 취소되었습니다.", "warning");
        return;
      }

      const newSettings: DirectiveRefinementSettings = { reasoning: currentReasoning };

      if (sourceChoice.startsWith("모델 직접 선택")) {
        const allModels = ctx.modelRegistry.getAvailable();
        if (allModels.length === 0) {
          ctx.ui.notify("사용 가능한 모델이 없습니다. API 키를 설정하세요.", "error");
          return;
        }

        const providerMap = new Map<string, Model<Api>[]>();
        for (const model of allModels) {
          const group = providerMap.get(model.provider) ?? [];
          group.push(model);
          providerMap.set(model.provider, group);
        }

        const providers = [...providerMap.keys()];
        const providerOptions = providers.map((provider) => {
          const count = providerMap.get(provider)!.length;
          const marker = provider === currentSettings.provider ? " [current]" : "";
          return `${provider} (${count} models)${marker}`;
        });

        const providerChoice = await ctx.ui.select("프로바이더 선택:", providerOptions);
        if (providerChoice === undefined) {
          ctx.ui.notify("설정이 취소되었습니다.", "warning");
          return;
        }

        const selectedProvider = providerChoice.split(" (")[0]!;
        const models = providerMap.get(selectedProvider)!;
        const modelOptions = models.map((model) => {
          const markers: string[] = [];
          if (model.provider === currentSettings.provider && model.id === currentSettings.model) {
            markers.push("current");
          }
          const suffix = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
          return `${model.id} — ${model.name}${suffix}`;
        });

        const modelChoice = await ctx.ui.select(`${selectedProvider} 모델 선택:`, modelOptions);
        if (modelChoice === undefined) {
          ctx.ui.notify("설정이 취소되었습니다.", "warning");
          return;
        }

        const selectedModelId = modelChoice.split(" — ")[0]!.trim();
        const selectedModel = models.find((model) => model.id === selectedModelId);
        if (!selectedModel) {
          ctx.ui.notify(`모델을 찾을 수 없습니다: ${selectedModelId}`, "error");
          return;
        }

        newSettings.provider = selectedModel.provider;
        newSettings.model = selectedModel.id;
      }

      const reasoningOptions = DIRECTIVE_REASONING_LEVELS.map((level) => {
        const marker = level === currentReasoning ? " ✓" : "";
        return `${DIRECTIVE_REASONING_LABELS[level]}${marker}`;
      });

      const reasoningChoice = await ctx.ui.select("Reasoning 레벨:", reasoningOptions);
      if (reasoningChoice === undefined) {
        ctx.ui.notify("설정이 취소되었습니다.", "warning");
        return;
      }

      const reasoningIdx = reasoningOptions.indexOf(reasoningChoice);
      currentReasoning = DIRECTIVE_REASONING_LEVELS[reasoningIdx]!;
      newSettings.reasoning = currentReasoning;

      saveDirectiveSettings(newSettings);

      const modelSummary =
        newSettings.provider && newSettings.model
          ? `${newSettings.provider}/${newSettings.model}`
          : "세션 모델";
      ctx.ui.notify(
        `설정 저장 완료: 모델=${modelSummary}, reasoning=${DIRECTIVE_REASONING_LABELS[currentReasoning]}`,
        "info",
      );
    },
  });

  const keybind = getKeybindAPI();
  keybind.register({
    extension: DIRECTIVE_SECTION_KEY,
    action: "refine-directive",
    defaultKey: "alt+m",
    description: worldviewAtRegister
      ? "현재 입력을 사령부 메모 양식의 작전 지령으로 재다듬기 (스피너 + ESC 취소)"
      : "현재 입력 텍스트를 다듬기 (스피너 + ESC 취소)",
    category: "Metaphor",
    handler: async (ctx) => {
      const editorText = ctx.ui.getEditorText();
      const trimmed = editorText?.trim();

      if (!trimmed) {
        const worldviewEnabledNow = isWorldviewEnabled();
        ctx.ui.notify(
          worldviewEnabledNow
            ? "입력창에 작전 지령 초안을 먼저 작성하세요."
            : "입력창에 다듬을 텍스트를 먼저 작성하세요.",
          "warning",
        );
        return;
      }

      const settings = loadDirectiveSettings();
      const model = resolveDirectiveRefinementModel(ctx, settings);
      if (!model) return;

      const result = await refineDirectiveWithLoader(ctx, model, trimmed, currentReasoning);
      if (result === null) return;

      ctx.ui.setEditorText(result);
    },
  });
}

function resolveCurrentOperationReasoning(): OperationReasoningLevel {
  const settings = loadOperationSettings();
  return settings.reasoning && isValidOperationReasoning(settings.reasoning)
    ? settings.reasoning
    : "off";
}
