import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WatcherFactory } from "../server/watcher.js";
import { createWatcherRegistry } from "../server/watcher.js";

describe("createWatcherRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("첫 구독자가 watcher를 생성한다", () => {
    const mockClose = vi.fn();
    const mockFactory: WatcherFactory = vi.fn().mockReturnValue({ close: mockClose, on: vi.fn() });
    const registry = createWatcherRegistry(mockFactory);

    const unsub = registry.subscribe("t1", "/path", () => {}, () => {});
    expect(mockFactory).toHaveBeenCalledOnce();
    expect(mockFactory).toHaveBeenCalledWith("/path", { recursive: true }, expect.any(Function));
    unsub();
  });

  it("두 번째 구독자는 기존 watcher를 재사용한다", () => {
    const mockFactory: WatcherFactory = vi.fn().mockReturnValue({ close: vi.fn(), on: vi.fn() });
    const registry = createWatcherRegistry(mockFactory);

    const unsub1 = registry.subscribe("t1", "/path", () => {}, () => {});
    const unsub2 = registry.subscribe("t1", "/path", () => {}, () => {});

    expect(mockFactory).toHaveBeenCalledOnce();
    unsub1();
    unsub2();
  });

  it("마지막 구독자 해제 시 watcher.close()를 호출한다", () => {
    const mockClose = vi.fn();
    const mockFactory: WatcherFactory = vi.fn().mockReturnValue({ close: mockClose, on: vi.fn() });
    const registry = createWatcherRegistry(mockFactory);

    const unsub1 = registry.subscribe("t1", "/path", () => {}, () => {});
    const unsub2 = registry.subscribe("t1", "/path", () => {}, () => {});

    unsub1();
    expect(mockClose).not.toHaveBeenCalled();
    unsub2();
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("중간 구독자 해제 후 나머지 구독자가 이벤트를 수신한다", () => {
    let watchCb: ((event: string, filename: string | null) => void) | undefined;
    const mockFactory: WatcherFactory = vi.fn().mockImplementation((_, __, cb) => {
      watchCb = cb;
      return { close: vi.fn(), on: vi.fn() };
    });
    const registry = createWatcherRegistry(mockFactory, 50);

    const onChange1 = vi.fn();
    const onChange2 = vi.fn();
    const unsub1 = registry.subscribe("t1", "/path", onChange1, () => {});
    const unsub2 = registry.subscribe("t1", "/path", onChange2, () => {});

    unsub1();
    watchCb!("change", "src/file.ts");
    vi.advanceTimersByTime(100);

    expect(onChange1).not.toHaveBeenCalled();
    expect(onChange2).toHaveBeenCalledWith("src");

    unsub2();
  });

  it("같은 디렉토리 이벤트를 debounce로 합쳐 한 번만 발화한다", () => {
    let watchCb: ((event: string, filename: string | null) => void) | undefined;
    const mockFactory: WatcherFactory = vi.fn().mockImplementation((_, __, cb) => {
      watchCb = cb;
      return { close: vi.fn(), on: vi.fn() };
    });
    const registry = createWatcherRegistry(mockFactory, 100);

    const onChange = vi.fn();
    const unsub = registry.subscribe("t1", "/path", onChange, () => {});

    watchCb!("change", "src/file1.ts");
    watchCb!("change", "src/file2.ts");
    watchCb!("change", "src/file3.ts");

    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("src");

    unsub();
  });

  it("서로 다른 디렉토리 이벤트는 별도로 발화한다", () => {
    let watchCb: ((event: string, filename: string | null) => void) | undefined;
    const mockFactory: WatcherFactory = vi.fn().mockImplementation((_, __, cb) => {
      watchCb = cb;
      return { close: vi.fn(), on: vi.fn() };
    });
    const registry = createWatcherRegistry(mockFactory, 50);

    const onChange = vi.fn();
    const unsub = registry.subscribe("t1", "/path", onChange, () => {});

    watchCb!("change", "src/file.ts");
    watchCb!("change", "lib/other.ts");

    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledTimes(2);
    const dirs = onChange.mock.calls.map(([d]) => d).sort();
    expect(dirs).toEqual(["lib", "src"]);

    unsub();
  });

  it("fs.watch 실패 시 degraded 상태를 전달하고 no-op 해제 함수를 반환한다", () => {
    const mockFactory: WatcherFactory = vi.fn().mockImplementation(() => {
      throw new Error("ENOSYS: function not implemented");
    });
    const registry = createWatcherRegistry(mockFactory);

    const onState = vi.fn();
    const unsub = registry.subscribe("t1", "/path", () => {}, onState);

    expect(onState).toHaveBeenCalledWith("degraded");
    expect(() => unsub()).not.toThrow();
  });

  it("첫 구독자는 watching, 추가 구독자도 watching 상태를 받는다", () => {
    const mockFactory: WatcherFactory = vi.fn().mockReturnValue({ close: vi.fn(), on: vi.fn() });
    const registry = createWatcherRegistry(mockFactory);

    const onState1 = vi.fn();
    const onState2 = vi.fn();
    const unsub1 = registry.subscribe("t1", "/path", () => {}, onState1);
    const unsub2 = registry.subscribe("t1", "/path", () => {}, onState2);

    expect(onState1).toHaveBeenCalledWith("watching");
    expect(onState2).toHaveBeenCalledWith("watching");

    unsub1();
    unsub2();
  });

  it("filename이 null이면 루트('')로 발화한다", () => {
    let watchCb: ((event: string, filename: string | null) => void) | undefined;
    const mockFactory: WatcherFactory = vi.fn().mockImplementation((_, __, cb) => {
      watchCb = cb;
      return { close: vi.fn(), on: vi.fn() };
    });
    const registry = createWatcherRegistry(mockFactory, 50);

    const onChange = vi.fn();
    const unsub = registry.subscribe("t1", "/path", onChange, () => {});

    watchCb!("change", null);
    vi.advanceTimersByTime(100);

    expect(onChange).toHaveBeenCalledWith("");
    unsub();
  });

  it("루트 레벨 파일(서브디렉토리 없음)은 루트('')로 발화한다", () => {
    let watchCb: ((event: string, filename: string | null) => void) | undefined;
    const mockFactory: WatcherFactory = vi.fn().mockImplementation((_, __, cb) => {
      watchCb = cb;
      return { close: vi.fn(), on: vi.fn() };
    });
    const registry = createWatcherRegistry(mockFactory, 50);

    const onChange = vi.fn();
    const unsub = registry.subscribe("t1", "/path", onChange, () => {});

    watchCb!("change", "README.md");
    vi.advanceTimersByTime(100);

    expect(onChange).toHaveBeenCalledWith("");
    unsub();
  });

  it("unsub를 두 번 호출해도 watcher.close()는 한 번만 호출된다", () => {
    const mockClose = vi.fn();
    const mockFactory: WatcherFactory = vi.fn().mockReturnValue({ close: mockClose, on: vi.fn() });
    const registry = createWatcherRegistry(mockFactory);

    const unsub = registry.subscribe("t1", "/path", () => {}, () => {});
    unsub();
    unsub();

    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("Windows 백슬래시 경로도 list API와 동일한 OS-native 구분자로 발화한다", () => {
    let watchCb: ((event: string, filename: string | null) => void) | undefined;
    const mockFactory: WatcherFactory = vi.fn().mockImplementation((_, __, cb) => {
      watchCb = cb;
      return { close: vi.fn(), on: vi.fn() };
    });
    const registry = createWatcherRegistry(mockFactory, 50);

    const onChange = vi.fn();
    const unsub = registry.subscribe("t1", "/path", onChange, () => {});

    watchCb!("change", "src\\nested\\file.ts");
    vi.advanceTimersByTime(100);

    // path.relative가 만드는 클라이언트 저장값(src\nested)과 동일해야 한다
    expect(onChange).toHaveBeenCalledWith("src\\nested");
    unsub();
  });

  it("error 후 옛 구독 해제가 교체 watcher를 레지스트리에서 제거하지 않는다", () => {
    const errorCbs: Array<(error: Error) => void> = [];
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const mockFactory: WatcherFactory = vi.fn().mockImplementation(() => {
      const close = vi.fn();
      closes.push(close);
      return {
        close,
        on: vi.fn().mockImplementation((event: string, cb: (error: Error) => void) => {
          if (event === "error") errorCbs.push(cb);
        }),
      };
    });
    const registry = createWatcherRegistry(mockFactory);

    const unsubOld = registry.subscribe("t1", "/path", () => {}, vi.fn());
    errorCbs[0]!(new Error("EPERM"));

    // 교체 watcher 생성 (2번째 factory 호출)
    registry.subscribe("t1", "/path", () => {}, vi.fn());
    expect(mockFactory).toHaveBeenCalledTimes(2);

    // 옛 구독 해제 — 교체 entry를 지우면 안 된다
    unsubOld();

    // 교체 entry가 살아있으면 재구독은 watcher를 재사용한다 (3번째 factory 호출 없음)
    registry.subscribe("t1", "/path", () => {}, vi.fn());
    expect(mockFactory).toHaveBeenCalledTimes(2);
    expect(closes[1]).not.toHaveBeenCalled();
  });

  it("watcher 런타임 error 시 구독자 전원에게 degraded를 알리고 정리한다", () => {
    let errorCb: ((error: Error) => void) | undefined;
    const mockClose = vi.fn();
    const mockFactory: WatcherFactory = vi.fn().mockReturnValue({
      close: mockClose,
      on: vi.fn().mockImplementation((event: string, cb: (error: Error) => void) => {
        if (event === "error") errorCb = cb;
      }),
    });
    const registry = createWatcherRegistry(mockFactory);

    const onState1 = vi.fn();
    const onState2 = vi.fn();
    registry.subscribe("t1", "/path", () => {}, onState1);
    registry.subscribe("t1", "/path", () => {}, onState2);

    errorCb!(new Error("EPERM: watched directory removed"));

    expect(onState1).toHaveBeenCalledWith("degraded");
    expect(onState2).toHaveBeenCalledWith("degraded");
    expect(mockClose).toHaveBeenCalledOnce();

    // error 정리 이후의 재구독은 새 watcher를 생성한다
    registry.subscribe("t1", "/path", () => {}, vi.fn());
    expect(mockFactory).toHaveBeenCalledTimes(2);
  });

  it("서로 다른 theaterId는 독립적인 watcher를 가진다", () => {
    const mockClose1 = vi.fn();
    const mockClose2 = vi.fn();
    let callCount = 0;
    const mockFactory: WatcherFactory = vi.fn().mockImplementation(() => {
      callCount++;
      return { close: callCount === 1 ? mockClose1 : mockClose2, on: vi.fn() };
    });
    const registry = createWatcherRegistry(mockFactory);

    const unsub1 = registry.subscribe("t1", "/path1", () => {}, () => {});
    const unsub2 = registry.subscribe("t2", "/path2", () => {}, () => {});

    expect(mockFactory).toHaveBeenCalledTimes(2);

    unsub1();
    expect(mockClose1).toHaveBeenCalledOnce();
    expect(mockClose2).not.toHaveBeenCalled();

    unsub2();
    expect(mockClose2).toHaveBeenCalledOnce();
  });
});
