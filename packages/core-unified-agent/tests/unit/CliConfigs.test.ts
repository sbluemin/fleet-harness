import { describe, expect, it } from 'vitest';
import { createSpawnConfig, getYoloModeId } from '../../src/config/CliConfigs.js';

describe('CliConfigs', () => {
  describe('createSpawnConfig', () => {
    it('Claude는 1M 지원이 포함된 최신 ACP 브리지를 사용한다', () => {
      const config = createSpawnConfig('claude', {
        cwd: '/tmp/workspace',
      });

      expect(config.command).toContain('npx');
      expect(config.args).not.toContain('--prefer-offline');
      expect(config.args).toContain('--package=@agentclientprotocol/claude-agent-acp@0.33.1');
      expect(config.args).toContain('claude-agent-acp');
      expect(config.useNpx).toBe(true);
    });

    it('Codex는 ACP 브리지를 npx로 spawn한다', () => {
      const config = createSpawnConfig('codex', {
        cwd: '/tmp/workspace',
      });

      expect(config.command).toContain('npx');
      expect(config.args).toEqual([
        '--yes',
        '--package=@zed-industries/codex-acp@0.14.0',
        'codex-acp',
      ]);
      expect(config.useNpx).toBe(true);
    });

    it('Codex configOverrides가 있어도 기본 ACP spawn 인자는 유지한다', () => {
      const config = createSpawnConfig('codex', {
        cwd: '/tmp/workspace',
        configOverrides: ['mcp_servers.fleet-tools.tool_timeout_sec=1800'],
      });

      expect(config.command).toContain('npx');
      expect(config.args).toEqual([
        '--yes',
        '--package=@zed-industries/codex-acp@0.14.0',
        'codex-acp',
      ]);
    });

    it('Cursor 모델은 acp subcommand 앞의 global --model 인자로 전달한다', () => {
      const config = createSpawnConfig('cursor', {
        cwd: '/tmp/workspace',
        model: 'kimi-k2.7-code',
      });

      expect(config.command).toBe('cursor-agent');
      expect(config.args).toEqual(['--model', 'kimi-k2.7-code', 'acp']);
      expect(config.useNpx).toBe(false);
    });

    it('Cursor Composer 2.5 Fast 모델은 modelId 그대로 spawn한다', () => {
      const config = createSpawnConfig('cursor', {
        cwd: '/tmp/workspace',
        model: 'composer-2.5-fast',
      });

      expect(config.command).toBe('cursor-agent');
      expect(config.args).toEqual(['--model', 'composer-2.5-fast', 'acp']);
      expect(config.useNpx).toBe(false);
    });

    it('Cursor GLM 5.2 모델은 effort를 반영한 CLI 모델 ID로 spawn한다', () => {
      const config = createSpawnConfig('cursor', {
        cwd: '/tmp/workspace',
        model: 'glm-5.2',
        effort: 'high',
      });

      expect(config.command).toBe('cursor-agent');
      expect(config.args).toEqual(['--model', 'glm-5.2-high', 'acp']);
      expect(config.useNpx).toBe(false);
    });

    it('Cursor Opus 4.8 thinking 모델은 effort를 반영한 CLI 모델 ID로 spawn한다', () => {
      const config = createSpawnConfig('cursor', {
        cwd: '/tmp/workspace',
        model: 'claude-opus-4-8-thinking',
        effort: 'high',
      });

      expect(config.command).toBe('cursor-agent');
      expect(config.args).toEqual(['--model', 'claude-opus-4-8-thinking-high', 'acp']);
      expect(config.useNpx).toBe(false);
    });
  });

  describe('getYoloModeId', () => {
    it('CLI별 ACP YOLO 모드 ID를 반환한다', () => {
      expect(getYoloModeId('claude')).toBe('bypassPermissions');
      expect(getYoloModeId('codex')).toBe('yolo');
    });
  });
});
