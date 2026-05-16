import { describe, expect, it } from 'vitest';
import { createSpawnConfig, getYoloModeId } from '../../src/config/CliConfigs.js';

describe('CliConfigs', () => {
  describe('createSpawnConfig', () => {
    it('Gemini ACP는 --acp로 spawn한다', () => {
      const config = createSpawnConfig('gemini', {
        cwd: '/tmp/workspace',
      });

      expect(config.command).toBe('gemini');
      expect(config.args).toEqual(['--acp']);
      expect(config.useNpx).toBe(false);
    });

    it('Gemini YOLO는 spawn 시 --approval-mode=yolo를 포함한다', () => {
      const config = createSpawnConfig('gemini', {
        cwd: '/tmp/workspace',
        yoloMode: true,
        model: 'gemini-2.5-pro',
      });

      expect(config.args).toEqual([
        '--acp',
        '--approval-mode=yolo',
        '--model',
        'gemini-2.5-pro',
      ]);
    });

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

    it('Codex는 native app-server를 직접 spawn한다', () => {
      const config = createSpawnConfig('codex', {
        cwd: '/tmp/workspace',
      });

      expect(config.command).toBe('codex');
      expect(config.args).toEqual(['app-server', '--listen', 'stdio://']);
      expect(config.useNpx).toBe(false);
    });

    it('Codex configOverrides가 있어도 spawn 인자는 native app-server를 유지한다', () => {
      const config = createSpawnConfig('codex', {
        cwd: '/tmp/workspace',
        configOverrides: ['mcp_servers.fleet-tools.tool_timeout_sec=1800'],
      });

      expect(config.command).toBe('codex');
      expect(config.args).toEqual(['app-server', '--listen', 'stdio://']);
    });
  });

  describe('getYoloModeId', () => {
    it('CLI별 ACP YOLO 모드 ID를 반환한다', () => {
      expect(getYoloModeId('gemini')).toBe('yolo');
      expect(getYoloModeId('claude')).toBe('bypassPermissions');
      expect(getYoloModeId('codex')).toBe('yolo');
    });
  });
});
