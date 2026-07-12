import { describe, expect, it } from 'vitest';

import { buildCodexConfigEnv } from '../../src/config/CliConfigs.js';

function parse(json: string | undefined): Record<string, unknown> {
  return JSON.parse(json ?? '{}') as Record<string, unknown>;
}

describe('buildCodexConfigEnv', () => {
  it('dotted key는 중첩 객체로 확장한다', () => {
    const json = buildCodexConfigEnv(['mcp_servers.fleet.url="http://127.0.0.1:1234"']);
    expect(parse(json)).toEqual({
      mcp_servers: { fleet: { url: 'http://127.0.0.1:1234' } },
    });
  });

  it('같은 상위 경로를 공유하는 override는 기존 중첩 객체에 병합한다', () => {
    const base = JSON.stringify({ mcp_servers: { fleet: { url: 'http://a' } } });
    const json = buildCodexConfigEnv(['mcp_servers.fleet.tool_timeout_sec=180'], base);
    expect(parse(json)).toEqual({
      mcp_servers: { fleet: { url: 'http://a', tool_timeout_sec: 180 } },
    });
  });

  it('JSON 값은 파싱해 number/boolean/string 타입을 보존한다', () => {
    const json = buildCodexConfigEnv([
      'tool_timeout_sec=180',
      'enabled=true',
      'model="gpt-5.4"',
    ]);
    expect(parse(json)).toEqual({
      tool_timeout_sec: 180,
      enabled: true,
      model: 'gpt-5.4',
    });
  });

  it('JSON.parse 실패 시 감싼 큰따옴표 한 쌍을 제거한 원시 문자열로 강등한다', () => {
    // `"a"b"`는 유효한 JSON이 아니므로 큰따옴표를 벗겨 `a"b`로 처리된다.
    const json = buildCodexConfigEnv(['label="a"b"']);
    expect(parse(json)).toEqual({ label: 'a"b' });
  });

  it('명시적 developer_instructions override는 base 설정을 갱신한다', () => {
    const base = JSON.stringify({ developer_instructions: 'base 지침', model: 'gpt-5.4' });
    const json = buildCodexConfigEnv(['developer_instructions="override 지침"'], base);
    expect(parse(json)).toEqual({
      developer_instructions: 'override 지침',
      model: 'gpt-5.4',
    });
  });

  it('유효하지 않은 baseConfigJson은 무시하고 빈 맵에서 시작한다', () => {
    const json = buildCodexConfigEnv(undefined, 'not-json');
    expect(parse(json)).toEqual({});
  });

  it('배열/스칼라 baseConfigJson도 객체가 아니므로 무시한다', () => {
    const json = buildCodexConfigEnv(undefined, '[1,2,3]');
    expect(parse(json)).toEqual({});
  });

  it('입력이 비면 undefined를 반환한다', () => {
    expect(buildCodexConfigEnv()).toBeUndefined();
    expect(buildCodexConfigEnv([], undefined)).toBeUndefined();
  });

  it('`=`가 없는 override 항목은 건너뛴다', () => {
    expect(buildCodexConfigEnv(['no-equals-here'])).toBeUndefined();
  });
});
