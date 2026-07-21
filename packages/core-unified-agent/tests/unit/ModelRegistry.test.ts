import { describe, expect, it } from 'vitest';
import { getModelContextWindow, getProviderModels, resolveCursorSpawnModel } from '../../src/models/ModelRegistry.js';
import { ModelsRegistrySchema } from '../../src/models/schemas.js';

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

  it('Kimi via Claude Code는 전 요금제 기본 모델과 상위 요금제 모델을 노출한다', () => {
    const provider = getProviderModels('claude-kimi');
    const modelIds = provider.models.map((model) => model.modelId);
    const efforts = Object.fromEntries(
      provider.models.map((model) => [model.modelId, model.effort]),
    );

    expect(provider.defaultModel).toBe('kimi-for-coding');
    expect(modelIds).toEqual([
      'kimi-for-coding',
      'k3',
      'k3[1m]',
      'kimi-for-coding-highspeed',
    ]);
    expect(efforts['kimi-for-coding']).toEqual({ supported: false });
    expect(efforts['kimi-for-coding-highspeed']).toEqual({ supported: false });
    expect(efforts.k3).toEqual({ supported: true, levels: ['low', 'high', 'max'], default: 'high' });
    expect(efforts['k3[1m]']).toEqual({ supported: true, levels: ['low', 'high', 'max'], default: 'high' });
  });

  it('Kimi via Claude Code 모델들은 컨텍스트 윈도우 크기를 노출한다', () => {
    expect(getModelContextWindow('claude-kimi', 'kimi-for-coding')).toBe(262144);
    expect(getModelContextWindow('claude-kimi', 'k3')).toBe(262144);
    expect(getModelContextWindow('claude-kimi', 'k3[1m]')).toBe(1048576);
    expect(getModelContextWindow('claude-kimi', 'kimi-for-coding-highspeed')).toBe(262144);
    expect(getModelContextWindow('claude', 'opus')).toBeNull();
  });

  it('Codex 정적 모델 목록에 GPT-5.6 모델들과 기존 모델들을 포함한다', () => {
    const provider = getProviderModels('codex');
    const modelIds = provider.models.map((model) => model.modelId);

    expect(provider.defaultModel).toBe('gpt-5.6-sol');
    expect(modelIds.slice(0, 3)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    expect(modelIds).toContain('gpt-5.5');
    expect(modelIds).not.toContain('gpt-5.6-lunar');
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

  it('OpenCode Go 정적 모델 목록에 GLM-5.2와 Kimi K2.7 Code를 포함한다', () => {
    const provider = getProviderModels('opencode-go');
    const modelIds = provider.models.map((model) => model.modelId);

    expect(modelIds).toContain('opencode-go/glm-5.2');
    expect(modelIds).toContain('opencode-go/kimi-k2.7-code');
  });

  it('Cursor 정적 모델 목록은 cursor-agent CLI 모델 ID를 그대로 노출한다', () => {
    const provider = getProviderModels('cursor');
    const modelIds = provider.models.map((model) => model.modelId);

    expect(provider.defaultModel).toBe('auto');
    expect(modelIds).toEqual([
      'auto',
      'composer-2.5',
      'composer-2.5-fast',
      'gpt-5.6-sol',
      'gpt-5.6-sol-fast',
      'gpt-5.6-sol-none',
      'gpt-5.6-sol-none-fast',
      'gpt-5.6-luna',
      'gpt-5.6-luna-fast',
      'gpt-5.6-luna-none',
      'gpt-5.6-luna-none-fast',
      'gpt-5.6-terra',
      'gpt-5.6-terra-fast',
      'gpt-5.6-terra-none',
      'gpt-5.6-terra-none-fast',
      'cursor-grok-4.5',
      'cursor-grok-4.5-fast',
      'claude-opus-4-8',
      'claude-opus-4-8-fast',
      'claude-opus-4-8-thinking',
      'claude-opus-4-8-thinking-fast',
      'claude-sonnet-5',
      'claude-sonnet-5-thinking',
      'claude-fable-5',
      'claude-fable-5-thinking',
      'gemini-3.1-pro',
      'gemini-3.5-flash',
      'kimi-k2.7-code',
      'glm-5.2',
    ]);
  });

  it('Cursor GLM 5.2 모델은 effort로 실제 cursor-agent CLI 모델 ID를 조립한다', () => {
    expect(resolveCursorSpawnModel('glm-5.2')).toBe('glm-5.2-max');
    expect(resolveCursorSpawnModel('glm-5.2', 'high')).toBe('glm-5.2-high');
    expect(resolveCursorSpawnModel('glm-5.2', 'invalid')).toBe('glm-5.2-max');
  });

  it('Cursor spawnModelTemplate은 effort로 실제 cursor-agent CLI 모델 ID를 조립한다', () => {
    expect(resolveCursorSpawnModel('gpt-5.6-sol')).toBe('gpt-5.6-sol-medium');
    expect(resolveCursorSpawnModel('gpt-5.6-sol', 'max')).toBe('gpt-5.6-sol-max');
    expect(resolveCursorSpawnModel('claude-opus-4-8-thinking-fast', 'low')).toBe('claude-opus-4-8-thinking-low-fast');
    expect(resolveCursorSpawnModel('cursor-grok-4.5-fast')).toBe('cursor-grok-4.5-high-fast');
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
              spawnModelTemplate: 'glm-5.2',
              effort: { supported: true, levels: ['low', 'high'], default: 'high' },
            },
          ],
        },
      },
    })).toThrow('{effort}');
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
