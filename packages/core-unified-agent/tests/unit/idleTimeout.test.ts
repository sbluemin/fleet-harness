import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIdleTimeoutRace } from '../../src/connection/AcpConnection.js';

describe('createIdleTimeoutRace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('활동이 없으면 idleMs 후에 타임아웃 에러 발생', async () => {
    // 영원히 resolve되지 않는 Promise
    const neverResolve = new Promise<string>(() => {});

    const [wrapped] = createIdleTimeoutRace(neverResolve, 100, 'test');

    vi.advanceTimersByTime(100);

    await expect(wrapped).rejects.toThrow(
      'test 요청이 100ms 동안 스트리밍 활동 없이 유휴 상태입니다',
    );
  });

  it('keepAlive 호출 시 타이머가 리셋된다', async () => {
    let resolveFn!: (value: string) => void;
    const deferred = new Promise<string>((resolve) => { resolveFn = resolve; });

    const [wrapped, keepAlive] = createIdleTimeoutRace(deferred, 200, 'test');

    // 80ms 경과 → keepAlive
    vi.advanceTimersByTime(80);
    keepAlive();

    // 또 80ms 경과 (총 160ms) → keepAlive → 아직 타임아웃 안 됨
    vi.advanceTimersByTime(80);
    keepAlive();

    // 100ms 더 경과 (총 260ms) 후 resolve
    vi.advanceTimersByTime(100);
    resolveFn('done');

    await expect(wrapped).resolves.toBe('done');
  });

  it('Promise가 먼저 resolve되면 타이머가 정리된다', async () => {
    let resolveFn!: (value: string) => void;
    const deferred = new Promise<string>((resolve) => { resolveFn = resolve; });

    const [wrapped] = createIdleTimeoutRace(deferred, 200, 'test');

    // 50ms 후 resolve
    vi.advanceTimersByTime(50);
    resolveFn('early');

    const result = await wrapped;
    expect(result).toBe('early');

    // 200ms 더 지나도 에러 없음 (타이머가 정리되었으므로)
    vi.advanceTimersByTime(200);
  });

  it('Promise가 reject되면 idle 타이머가 정리되고 원본 에러가 전파된다', async () => {
    let rejectFn!: (reason: Error) => void;
    const deferred = new Promise<string>((_, reject) => { rejectFn = reject; });

    const [wrapped] = createIdleTimeoutRace(deferred, 200, 'test');

    vi.advanceTimersByTime(50);
    rejectFn(new Error('original error'));

    await expect(wrapped).rejects.toThrow('original error');
  });

  it('idleMs <= 0이면 idle timeout 비활성화', async () => {
    let resolveFn!: (value: string) => void;
    const deferred = new Promise<string>((resolve) => { resolveFn = resolve; });

    const [wrapped, keepAlive] = createIdleTimeoutRace(deferred, 0, 'test');

    // keepAlive는 no-op
    keepAlive();

    // 시간이 많이 지나도 타임아웃 없음
    vi.advanceTimersByTime(999_999);

    resolveFn('ok');
    await expect(wrapped).resolves.toBe('ok');
  });

  it('음수 idleMs도 idle timeout 비활성화', async () => {
    let resolveFn!: (value: string) => void;
    const deferred = new Promise<string>((resolve) => { resolveFn = resolve; });

    const [wrapped] = createIdleTimeoutRace(deferred, -1, 'test');

    vi.advanceTimersByTime(999_999);

    resolveFn('ok');
    await expect(wrapped).resolves.toBe('ok');
  });

  it('settled 후 keepAlive 호출은 안전하게 무시된다', async () => {
    let resolveFn!: (value: string) => void;
    const deferred = new Promise<string>((resolve) => { resolveFn = resolve; });

    const [wrapped, keepAlive] = createIdleTimeoutRace(deferred, 100, 'test');

    resolveFn('done');
    await wrapped;

    // settled 후 keepAlive 호출 — 에러 없이 무시
    expect(() => keepAlive()).not.toThrow();
  });

  it('여러 번 keepAlive 호출해도 마지막 호출 기준으로 타이머가 동작한다', async () => {
    const neverResolve = new Promise<string>(() => {});

    const [wrapped, keepAlive] = createIdleTimeoutRace(neverResolve, 100, 'test');

    // 50ms 간격으로 5번 keepAlive (총 250ms)
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(50);
      keepAlive();
    }

    // 마지막 keepAlive 이후 99ms — 아직 타임아웃 안 됨
    vi.advanceTimersByTime(99);

    // 1ms 더 → 총 idle 100ms → 타임아웃
    vi.advanceTimersByTime(1);

    await expect(wrapped).rejects.toThrow('유휴 상태');
  });
});
