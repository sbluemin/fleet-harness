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

    it('Codex는 native App Server를 spawn한다', () => {
      const config = createSpawnConfig('codex', {
        cwd: '/tmp/workspace',
      });

      expect(config.command).toBe('codex');
      expect(config.args).toEqual([
        'app-server',
        '--listen',
        'stdio://',
      ]);
      expect(config.useNpx).toBe(false);
    });

    it('Codex cliPath를 App Server command로 사용한다', () => {
      const config = createSpawnConfig('codex', {
        cwd: '/tmp/workspace',
        cliPath: '/opt/codex',
      });

      expect(config.command).toBe('/opt/codex');
      expect(config.args).toEqual([
        'app-server',
        '--listen',
        'stdio://',
      ]);
    });

  });

  describe('getYoloModeId', () => {
    it('CLI별 ACP YOLO 모드 ID를 반환한다', () => {
      expect(getYoloModeId('claude')).toBe('bypassPermissions');
      expect(getYoloModeId('codex')).toBe('yolo');
    });
  });
});
