# Fleet Computer Use — Windows helper

`fleet-computer-use.exe` speaks the same wire contract as the macOS Swift helper (`../computer-use`): the persistent NDJSON
helper (`args: []`), the one-shot `--platform` frames and `--paste-lease`. The Console talks to it exactly as it does on macOS.

## Principle

The helper never injects hardware-level input and never raises a window. `SendInput`, `SetCursorPos`, `keybd_event`,
`SetWindowPos`/`ShowWindow` on foreign windows and screen-DC `BitBlt` are not declared anywhere (see `Native.cs`).

| Action | Route | `via` |
|---|---|---|
| click / right_click / double_click | `PostMessage` mouse messages to the deepest child window (Chromium: the top-level `Chrome_WidgetWin_*`) | `message` |
| scroll | `WM_MOUSEWHEEL` / `WM_MOUSEHWHEEL`; Chromium only at points the target owns | `message` |
| type | `WM_CHAR` (UTF-16) to the control/focus window; readback verifies | `message` |
| key | `WM_KEYDOWN/UP`; modifiers via `AttachThreadInput` + `SetKeyboardState`, always restored | `message` / `message+keystate` |
| click/scroll with no message path (WinUI, UWP), set_value, select, ax_action | UI Automation patterns (**B route**) | `uia` |
| drag | message-capable non-Chromium Win32 only, else `drag_unsupported` | `message` |

B route: the person's foreground window is recorded, the pattern call runs, and the foreground is handed back at once
(from the foreground-event thread while the call is still blocking, and again right after it returns). `notes` carries
`foreground_borrowed:<ms>ms restored|not_restored`, where `<ms>` is how long the target held the foreground (first
foreground-change event to confirmed restore). A failed restore is reported, never retried.

## Layout

- `Program.cs` — mode dispatch (`--platform`, `--paste-lease`, `--cursor-demo [hwnd]`, default persistent).
- `Wire.cs` — NDJSON host: 1 MiB line limit, 128-deep queue, 15 s watchdog, EOF/shutdown semantics.
- `HelperService.cs`, `Act.cs` — methods, validation, observation (`changes`, `windowsChanged`, `verified`).
- `WindowCatalog.cs` — EnumWindows, process identity (`GetProcessTimes`), engine detection, virtual desktops, installed apps.
- `Uia.cs` — COM `IUIAutomation` tree (control view, cached, MTA, depth < 64, 4000 nodes, time budget), AX-vocabulary roles.
- `Capture.cs` — Windows.Graphics.Capture, then `PrintWindow(PW_RENDERFULLCONTENT)`; cropped to the DWM frame.
- `Input.cs` — message input, key parsing, foreground guard.
- `SelfCheck.cs` — interactive desktop, UIA, posted click on a 24x24 no-activate probe window (foreground/pointer compared).
- `Platform.cs`, `AppLauncher.cs`, `PasteLease.cs` — one-shot commands and clipboard lease.
- The AI cursor comes from `../Cursor` (`IAICursor`); the helper tracks/moves it before delivery and hides it on EOF/shutdown/watchdog.

## Build

```
dotnet publish Helper -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
```

The project is `SelfContained` and compresses the single file (about 44 MB; startup +0.4 s).
UI Automation and shell COM bindings come from `Microsoft.Windows.CsWin32` (build-time only).
On a Windows ARM64 machine the x64 helper runs under emulation; `dotnet test` needs an x64 SDK there.

## Environment

- `FLEET_COMPUTER_USE_FAULT=self_check|symbols` — inject a failed self-check (same as macOS).
- `FLEET_COMPUTER_USE_FAULT=hang|hang_after_send` — test-only: block the next request to exercise the 15 s watchdog.
- `FLEET_COMPUTER_USE_TRACE=1` — stderr trace of UIA reads, cursor and foreground-restore timing (the Console discards stderr).

## Known limits

- A Chromium process that has never been queried builds its web accessibility tree only while a page is rendered. If the very
  first helper query hits a fully covered window, `snapshot` returns the browser chrome without the page (`complete:false`);
  once the tree exists the window may be covered again. Minimized WinUI windows can expose an empty tree.
- UWP/WinUI text boxes without a window handle can only be set with `set_value`; `type` there needs a focused editable element.
- Chromium window capture of a fully covered window may be stale (`imageNote: occluded_chromium_may_be_stale`).

## Tests

`Tests/Helper.Tests` (xunit): units plus the real exe over its stdio protocols, including the 15 s watchdog.
`Tests/Smoke` (node + `SmokeTool`): real-window scenarios where a separate process plays the user (see `smoke-all.mjs`).
