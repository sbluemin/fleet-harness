import { afterEach, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ getSources: vi.fn(async () => []), status: "not-determined" }));
vi.mock("electron", () => ({
  desktopCapturer: { getSources: electron.getSources },
  systemPreferences: { getMediaAccessStatus: () => electron.status, isTrustedAccessibilityClient: () => false },
  shell: { openExternal: async () => undefined },
}));

const { requestScreenRecordingPermission } = await import("../src/computer-capture.js");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const onPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platform, value });

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  electron.getSources.mockClear();
  electron.status = "not-determined";
});

// 시각은 모듈의 간격 기록을 공유하므로 시험마다 충분히 떨어뜨린다.
it("reads the screen list once from the main process so macOS can list and ask for the app", async () => {
  onPlatform("darwin");
  const log = vi.fn();
  await requestScreenRecordingPermission(log, 1_000_000);
  expect(electron.getSources).toHaveBeenCalledExactlyOnceWith({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
  expect(log).toHaveBeenLastCalledWith("computer capture screen recording requested status=not-determined");
  await requestScreenRecordingPermission(log, 1_002_000);
  expect(electron.getSources).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenLastCalledWith("computer capture screen recording request ignored: repeated");
});

it("does not read the screen list when Screen Recording is already granted or off macOS", async () => {
  onPlatform("darwin");
  electron.status = "granted";
  const log = vi.fn();
  await requestScreenRecordingPermission(log, 2_000_000);
  expect(log).toHaveBeenLastCalledWith("computer capture screen recording request skipped: granted");
  onPlatform("linux");
  await requestScreenRecordingPermission(log, 3_000_000);
  expect(log).toHaveBeenLastCalledWith("computer capture screen recording request ignored: platform");
  expect(electron.getSources).not.toHaveBeenCalled();
});

it("logs a refused screen list without throwing", async () => {
  onPlatform("darwin");
  electron.getSources.mockRejectedValueOnce("Failed to get sources.");
  const log = vi.fn();
  await requestScreenRecordingPermission(log, 4_000_000);
  expect(log).toHaveBeenLastCalledWith("computer capture screen recording request failed: Failed to get sources., screen permission=not-determined");
});
