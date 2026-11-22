// 진입점. 기본은 stdio JSON Lines 헬퍼(설계 계약 §2). `--cursor-demo`는 AI 커서 단독 시험(설계 계약 §5)이며
// 디버그 빌드(`swift build`)에만 들어간다. 릴리스 헬퍼는 시험 앱을 띄우는 이 진입점을 싣지 않는다.
import AppKit
import Darwin

let arguments = Array(CommandLine.arguments.dropFirst())
// These modes must not initialize the input helper or its self-check window.
switch arguments.first {
case "--platform":
  guard arguments.count == 1 else { exit(EX_USAGE) }
  exit(MainActor.assumeIsolated { PlatformCommands.run() })
case "--paste-lease":
  guard arguments.count == 1 else { exit(EX_USAGE) }
  exit(MainActor.assumeIsolated { PasteboardLeaseCommand.run() })
default:
  break
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)

MainActor.assumeIsolated {
  #if DEBUG
  if arguments.first == "--cursor-demo" {
    CursorDemo.run(arguments: Array(arguments.dropFirst()))
    return
  }
  #endif
  HelperMain.run(arguments: arguments)
}
application.run()
