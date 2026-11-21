// 진입점. 기본은 stdio JSON Lines 헬퍼(설계 계약 §2). `--cursor-demo`는 AI 커서 단독 시험(설계 계약 §5).
import AppKit

let arguments = Array(CommandLine.arguments.dropFirst())
let application = NSApplication.shared
application.setActivationPolicy(.accessory)

MainActor.assumeIsolated {
  if arguments.first == "--cursor-demo" {
    CursorDemo.run(arguments: Array(arguments.dropFirst()))
  } else {
    HelperMain.run(arguments: arguments)
  }
}
application.run()
