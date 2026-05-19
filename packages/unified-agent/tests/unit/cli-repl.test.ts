import { describe, expect, it, vi } from 'vitest';
import picocolors from 'picocolors';

import { handleEffortSlashCommand } from '../../src/cli-repl.js';

const ce = picocolors.createColors(false);

describe('cli-repl /effort', () => {
  it('gemini는 unsupported provider이므로 /effort high를 안내 후 무시한다', async () => {
    const setConfigOption = vi.fn<(...args: [string, string]) => Promise<void>>().mockResolvedValue(undefined);
    const setEffort = vi.fn();
    const writes: string[] = [];

    await handleEffortSlashCommand({
      cli: 'gemini',
      arg: 'high',
      ce,
      currentModel: 'gemini-3.1-flash-lite-preview',
      setEffort,
      setConfigOption,
      writeLine: (text) => { writes.push(text); },
    });

    expect(setConfigOption).not.toHaveBeenCalled();
    expect(setEffort).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('gemini/gemini-3.1-flash-lite-preview 모델은 reasoning effort를 지원하지 않아 /effort high 를 무시합니다');
  });

  it('claude는 supported provider이므로 /effort max에서 다음 세션 적용 안내를 출력한다', async () => {
    const setConfigOption = vi.fn<(...args: [string, string]) => Promise<void>>().mockResolvedValue(undefined);
    const setEffort = vi.fn();
    const writes: string[] = [];

    await handleEffortSlashCommand({
      cli: 'claude',
      arg: 'max',
      ce,
      currentModel: 'sonnet',
      setEffort,
      setConfigOption,
      writeLine: (text) => { writes.push(text); },
    });

    expect(setConfigOption).not.toHaveBeenCalled();
    expect(setEffort).toHaveBeenCalledWith('max');
    expect(writes.join('')).toContain('Claude의 effort max는 다음 새 세션부터 적용됩니다');
  });

  it('codex는 supported provider이므로 /effort high에서 effort를 설정한다', async () => {
    const setConfigOption = vi.fn<(...args: [string, string]) => Promise<void>>().mockResolvedValue(undefined);
    const setEffort = vi.fn();
    const writes: string[] = [];

    await handleEffortSlashCommand({
      cli: 'codex',
      arg: 'high',
      ce,
      currentModel: 'gpt-5.4',
      setEffort,
      setConfigOption,
      writeLine: (text) => { writes.push(text); },
    });

    expect(setConfigOption).toHaveBeenCalledWith('effort', 'high');
    expect(setEffort).toHaveBeenCalledWith('high');
    expect(writes.join('')).toContain('reasoning effort 변경: high');
  });

  it('codex 모델이 지원하지 않는 /effort max는 설정하지 않는다', async () => {
    const setConfigOption = vi.fn<(...args: [string, string]) => Promise<void>>().mockResolvedValue(undefined);
    const setEffort = vi.fn();
    const writes: string[] = [];

    await handleEffortSlashCommand({
      cli: 'codex',
      arg: 'max',
      ce,
      currentModel: 'gpt-5.4',
      setEffort,
      setConfigOption,
      writeLine: (text) => { writes.push(text); },
    });

    expect(setConfigOption).not.toHaveBeenCalled();
    expect(setEffort).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('codex/gpt-5.4 모델은 /effort max 를 지원하지 않습니다');
  });
});
