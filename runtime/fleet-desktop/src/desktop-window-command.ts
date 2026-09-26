import { DESKTOP_WINDOW_COMMAND_EVENT, DESKTOP_WINDOW_COMMAND_EVENTS_PATH, DESKTOP_WINDOW_COMMAND_PATH, isDesktopWindowCommandSnapshot, type DesktopWindowCommand, type DesktopWindowCommandSnapshot } from "@fleet-console/protocol/desktop";

import { normalizeConsoleOrigin as normalizeAnyConsoleOrigin } from "./console-links.js";
import { createDesktopEventStream, type DesktopEventStream } from "./desktop-event-stream.js";

const MAX_WINDOW_COMMAND_SSE_BUFFER_CHARS = 4 * 1024;

export interface DesktopWindowCommandSynchronizerDeps {
  /** 창이 시킨 창 조작. Console은 명령을 걸어 두지 않으므로 재연결이 같은 명령을 되풀이하지 않는다. */
  readonly perform: (command: DesktopWindowCommand) => void;
  readonly fetch?: typeof fetch;
}

/**
 * 창이 보고 있는 Console에서 창 조작 명령(지금은 네이티브 전체화면 진입·이탈)을 듣는다. 이 명령을
 * 모르는 옛 Console은 스냅샷 경로에 404로 답하므로 스트림을 열지 않는다.
 */
export function createDesktopWindowCommandSynchronizer(deps: DesktopWindowCommandSynchronizerDeps): DesktopEventStream {
  return createDesktopEventStream<DesktopWindowCommandSnapshot>({
    snapshotPath: DESKTOP_WINDOW_COMMAND_PATH,
    eventsPath: DESKTOP_WINDOW_COMMAND_EVENTS_PATH,
    eventName: DESKTOP_WINDOW_COMMAND_EVENT,
    parseSnapshot: (value) => isDesktopWindowCommandSnapshot(value) ? value : null,
    apply: (snapshot) => {
      if (snapshot.command !== null) deps.perform(snapshot.command);
    },
    maxFrameChars: MAX_WINDOW_COMMAND_SSE_BUFFER_CHARS,
    normalizeOrigin: (origin) => normalizeAnyConsoleOrigin(origin, "desktop_window_command_origin_invalid"),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}
