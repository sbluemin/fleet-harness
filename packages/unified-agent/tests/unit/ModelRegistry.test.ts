import { describe, expect, it } from 'vitest';
import { getProviderModels, resolveCursorSpawnModel } from '../../src/models/ModelRegistry.js';
import { ModelsRegistrySchema } from '../../src/models/schemas.js';

describe('ModelRegistry', () => {
  it('Claude 정적 모델 목록에 Opus 1M 변형들을 포함한다', () => {
    const provider = getProviderModels('claude');
    const modelIds = provider.models.map((model) => model.modelId);

    expect(modelIds).toContain('opus[1m]');
    expect(modelIds).toContain('claude-opus-4-6[1m]');
    expect(modelIds).not.toContain('sonnet[1m]');
  });

  it('Codex 정적 모델 목록에 GPT-5.5를 포함한다', () => {
    const provider = getProviderModels('codex');
    const modelIds = provider.models.map((model) => model.modelId);

    expect(modelIds).toContain('gpt-5.5');
  });

  it('Cursor 정적 모델 목록은 cursor-agent CLI 모델 ID를 그대로 노출한다', () => {
    const provider = getProviderModels('cursor');
    const modelIds = provider.models.map((model) => model.modelId);

    expect(provider.defaultModel).toBe('auto');
    expect(modelIds).toEqual([
      'auto',
      'composer-2.5-fast',
      'composer-2.5',
      'gemini-3.1-pro',
      'gemini-3-flash',
      'gemini-3.5-flash',
      'claude-opus-4-7-thinking',
      'claude-opus-4-8-thinking',
      'claude-4.6-sonnet-medium-thinking',
    ]);
  });

  it('Cursor Opus thinking 모델은 effort로 실제 cursor-agent CLI 모델 ID를 조립한다', () => {
    expect(resolveCursorSpawnModel('claude-opus-4-7-thinking')).toBe('claude-opus-4-7-thinking-xhigh');
    expect(resolveCursorSpawnModel('claude-opus-4-7-thinking', 'high')).toBe('claude-opus-4-7-thinking-high');
    expect(resolveCursorSpawnModel('claude-opus-4-7-thinking', 'invalid')).toBe('claude-opus-4-7-thinking-xhigh');
  });

  it('effort 지원 spawnModelTemplate은 {effort} 플레이스홀더를 포함해야 한다', () => {
    expect(() => ModelsRegistrySchema.parse({
      version: 1,
      updatedAt: '2026-05-17T00:00:00Z',
      providers: {
        cursor: {
          name: 'Cursor Agent',
          defaultModel: 'bad-template',
          models: [
            {
              modelId: 'bad-template',
              name: 'Bad Template',
              spawnModelTemplate: 'claude-opus-4-7-thinking',
              effort: { supported: true, levels: ['low', 'high'], default: 'high' },
            },
          ],
        },
      },
    })).toThrow('{effort}');
  });

  it('정적 모델 effort levels는 raw none/minimal을 포함하지 않는다', () => {
    for (const providerId of ['claude', 'codex', 'cursor'] as const) {
      const provider = getProviderModels(providerId);
      for (const model of provider.models) {
        if (!model.effort.supported) continue;
        expect(model.effort.levels).not.toContain('none');
        expect(model.effort.levels).not.toContain('minimal');
      }
    }
  });
});
