import AppKit

/// 헬퍼는 사람의 전면 앱을 가져가지 않는다. 명시적인 활성화 호출이 없어도 전면 앱 아래에서 자식으로 뜬 헬퍼가 실행 직후 활성 앱이
/// 되는 경우가 있었다(dbdbe742 실측: 20회 중 3~5회, 일부는 300ms 넘게 유지되어 사람의 키 입력이 보이지 않는 헬퍼로 갔다).
/// 헬퍼가 활성화되면 직전의 전면 앱에 활성화를 곧바로 돌려준다. 헬퍼에는 사람이 눌러 활성화할 창이 없으므로 되돌리는 것이 늘 맞다.
@MainActor final class ActivationGuard {
  private var previous: NSRunningApplication?
  private var observer: NSObjectProtocol?
  private(set) var yields = 0

  func start() {
    let own = getpid()
    if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != own { previous = front }
    observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                                 object: nil, queue: .main) { [weak self] note in
      guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
      MainActor.assumeIsolated {
        if app.processIdentifier == own { self?.yieldActivation() } else { self?.previous = app }
      }
    }
  }

  private func yieldActivation() {
    yields += 1
    guard let previous, !previous.isTerminated else { NSApp.deactivate(); return }
    if #available(macOS 14.0, *) {
      NSApp.yieldActivation(to: previous)
      _ = previous.activate()
    } else {
      _ = previous.activate(options: [])
    }
  }
}
