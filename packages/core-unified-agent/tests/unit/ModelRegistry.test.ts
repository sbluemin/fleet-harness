import { describe, expect, it } from 'vitest';
import { getModelContextWindow, getProviderModels } from '../../src/models/registry.js';
import { ModelsRegistrySchema } from '../../src/models/registry.js';

describe('ModelRegistry', () => {
  it('Claude 정적 모델 목록에 Opus 1M 변형들을 포함한다', () => {
    const provider = getProviderModels('claude');
    const modelIds = provider.models.map((model) => model.modelId);

    expect(modelIds).toContain('opus[1m]');
    expect(modelIds).toContain('claude-opus-4-6[1m]');
    expect(modelIds).toContain('claude-opus-4-7[1m]');
    expect(modelIds).toContain('claude-opus-4-8[1m]');
    expect(modelIds).not.toContain('sonnet[1m]');
  });

  it('모델별 컨텍스트 윈도우 미설정은 null을 반환한다', () => {
    expect(getModelContextWindow('claude', 'opus')).toBeNull();
  });

  it('Codex 정적 모델 목록에 GPT-5.6과 GPT-5.5의 일반·Fast 자산을 포함한다', () => {
    const provider = getProviderModels('codex');
    const modelIds = provider.models.map((model) => model.modelId);

    expect(provider.defaultModel).toBe('gpt-5.6-sol');
    expect(modelIds).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-sol-fast',
      'gpt-5.6-terra',
      'gpt-5.6-terra-fast',
      'gpt-5.6-luna',
      'gpt-5.6-luna-fast',
      'gpt-5.5',
      'gpt-5.5-fast',
    ]);
    expect(modelIds).not.toContain('gpt-5.6-lunar');
    expect(modelIds.every((modelId) => !modelId.startsWith('gpt-5.4'))).toBe(true);
  });

  it('Codex Fast 자산은 원본 모델과 priority service tier를 선언한다', () => {
    const fastModels = getProviderModels('codex').models
      .filter((model) => model.modelId.endsWith('-fast'));

    expect(fastModels).toHaveLength(4);
    for (const model of fastModels) {
      expect(model.providerModelId).toBe(model.modelId.slice(0, -'-fast'.length));
      expect(model.serviceTier).toBe('priority');
    }
  });

  it('Codex GPT-5.6 모델별 effort contract를 정확히 노출한다', () => {
    const provider = getProviderModels('codex');
    const efforts = Object.fromEntries(
      provider.models.map((model) => [model.modelId, model.effort]),
    );

    expect(efforts['gpt-5.6-sol']).toEqual({
      supported: true,
      levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      default: 'low',
    });
    expect(efforts['gpt-5.6-terra']).toEqual({
      supported: true,
      levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      default: 'medium',
    });
    expect(efforts['gpt-5.6-luna']).toEqual({
      supported: true,
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      default: 'medium',
    });
  });

  it('serviceTier 모델은 providerModelId를 함께 선언해야 한다', () => {
    expect(() => ModelsRegistrySchema.parse({
      version: 1,
      updatedAt: '2026-07-25T00:00:00Z',
      providers: {
        codex: {
          name: 'Codex',
          defaultModel: 'fast-without-provider-model',
          models: [{
            modelId: 'fast-without-provider-model',
            name: 'Invalid Fast',
            serviceTier: 'priority',
            effort: { supported: false },
          }],
        },
      },
    })).toThrow('providerModelId');
  });

  it('public effort schema는 ultra를 허용한다', () => {
    expect(() => ModelsRegistrySchema.parse({
      version: 1,
      updatedAt: '2026-07-10T00:00:00Z',
      providers: {
        codex: {
          name: 'Codex',
          defaultModel: 'gpt-5.6-sol',
          models: [
            {
              modelId: 'gpt-5.6-sol',
              name: 'GPT-5.6-Sol',
              effort: {
                supported: true,
                levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
                default: 'ultra',
              },
            },
          ],
        },
      },
    })).not.toThrow();
  });

  it('정적 모델 effort levels는 raw none/minimal을 포함하지 않는다', () => {
    for (const providerId of ['claude', 'codex'] as const) {
      const provider = getProviderModels(providerId);
      for (const model of provider.models) {
        if (!model.effort.supported) continue;
        expect(model.effort.levels).not.toContain('none');
        expect(model.effort.levels).not.toContain('minimal');
      }
    }
  });
});
