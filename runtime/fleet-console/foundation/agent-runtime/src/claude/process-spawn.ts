import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

import type { ClaudeProcessSpawner } from "./contracts.js";

/** SDK가 넘기는 spawn 인자. vendor 타입 이름 없이 같은 모양만 받는다. */
interface VendorSpawnOptions {
  readonly command: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly env: { readonly [name: string]: string | undefined };
  readonly signal?: AbortSignal;
}

/** stderr가 끝내 닫히지 않을 때(손자가 pipe를 물고 있음) exit을 그만큼만 미룬다. SDK 동봉 spawner와 같은 값이다. */
const STDERR_CLOSE_GRACE_MS = 200;

/**
 * 호스트 포트를 SDK의 `spawnClaudeCodeProcess`로 옮긴다.
 *
 * SDK 동봉 spawner가 하던 두 가지를 그대로 한다. stderr를 끝까지 읽어(호출자 콜백이 있으면 전달) 자식이
 * 꽉 찬 pipe에 막히지 않게 하고, exit은 stderr가 닫힌 뒤에(늦어도 200ms 뒤에) 전한다. SDK가 exit 오류에
 * 붙이던 stderr 꼬리는 SDK 내부 상태라 여기서 채울 수 없다 — 진단 꼬리는 포트를 준 호스트가 남긴다.
 */
export function toVendorProcessSpawner(spawn: ClaudeProcessSpawner, stderr?: (data: string) => void): (options: VendorSpawnOptions) => unknown {
  return (options) => {
    const child = spawn({
      command: options.command,
      args: [...options.args],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const events = new EventEmitter();
    const decoder = new StringDecoder("utf8");
    let exited = false;
    let stderrClosed = false;
    let delivered = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const deliver = (): void => {
      if (delivered) return;
      delivered = true;
      if (grace !== undefined) clearTimeout(grace);
      events.emit("exit", child.exitCode, child.signalCode);
      // 손자가 아직 stderr를 쥐고 있으면 읽기는 계속하되 이벤트 루프를 붙잡지 않는다.
      const stream = child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null;
      if (stream && typeof stream.unref === "function") stream.unref();
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = decoder.write(chunk);
      if (!delivered && text.length > 0) stderr?.(text);
    });
    child.stderr?.on("error", () => { /* 읽기 실패는 진단 손실일 뿐 실행을 막지 않는다. */ });
    child.stderr?.once("close", () => {
      stderrClosed = true;
      if (exited) deliver();
    });
    child.on("error", (error) => events.emit("error", error));
    child.once("exit", () => {
      exited = true;
      if (stderrClosed || !child.stderr) deliver();
      else grace = setTimeout(deliver, STDERR_CLOSE_GRACE_MS);
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      get signalCode() { return child.signalCode; },
      kill: (signal: NodeJS.Signals) => child.kill(signal),
      on: (event: string, listener: (...args: unknown[]) => void) => { events.on(event, listener); },
      once: (event: string, listener: (...args: unknown[]) => void) => { events.once(event, listener); },
      off: (event: string, listener: (...args: unknown[]) => void) => { events.off(event, listener); },
    };
  };
}
