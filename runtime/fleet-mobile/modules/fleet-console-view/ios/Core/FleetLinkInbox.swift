import Foundation

// FleetLinkInbox.kt의 이식. 프로세스 전용 원샷 핸드오프 — 크리덴셜을 든 access URI를
// 익스포트된 링크 핸들러와 네이티브 콘솔 뷰 사이에서 딱 한 번 넘긴다. 프로세스가 죽으면
// 소비되지 않은 크리덴셜은 의도적으로 사라진다(어디에도 영속하지 않는다).
//
// Kotlin의 detach(next)는 클로저의 identity로 비교하지만 Swift 클로저에는 identity가 없다.
// 따라서 수신자를 참조 타입으로 감싸 === 로 비교한다 — attach/detach가 같은 인스턴스를
// 넘길 때만 해제되는 원본 동작을 보존한다.
public final class FleetLinkReceiver {
  let handle: (String) -> Void
  public init(_ handle: @escaping (String) -> Void) { self.handle = handle }
}

public enum FleetLinkInbox {
  public static let maxInputLength = 4096
  private static let prefix = "fleet://join?code="

  private static let lock = NSLock()
  private static var pending: String?
  private static var receiver: FleetLinkReceiver?

  // isCandidate는 대소문자·경계까지 정확하다(파서의 대소문자 무시와 달리). 원본과 동일하게
  // 접두사는 정확히 "fleet://join?code=" 이고 길이는 1..MAX.
  public static func isCandidate(_ value: String?) -> Bool {
    guard let value else { return false }
    // 길이는 Kotlin String.length(UTF-16 코드 유닛) 기준.
    let length = value.utf16.count
    return length >= 1 && length <= maxInputLength && value.hasPrefix(prefix)
  }

  public static func offer(_ value: String) {
    guard isCandidate(value) else { return }
    lock.lock()
    pending = value
    lock.unlock()
    drain()
  }

  // true면 대기 링크를 이 호출에서 동기 전달했다. 뷰는 이 값으로 영속 activeTarget 재연결을
  // 건너뛴다 — 콜드 스타트 fleet:// 가 저장된 타깃보다 앞선다.
  @discardableResult
  public static func attach(_ next: FleetLinkReceiver) -> Bool {
    lock.lock()
    receiver = next
    lock.unlock()
    return drain()
  }

  public static func detach(_ next: FleetLinkReceiver) {
    lock.lock()
    if receiver === next { receiver = nil }
    lock.unlock()
  }

  @discardableResult
  static func consume() -> String? {
    lock.lock()
    defer { lock.unlock() }
    let value = pending
    pending = nil
    return value
  }

  @discardableResult
  private static func drain() -> Bool {
    lock.lock()
    let active = receiver
    lock.unlock()
    guard let active else { return false }
    guard let value = consume() else { return false }
    active.handle(value)
    return true
  }

  // 테스트 격리를 위한 리셋(프로덕션 경로에서는 호출하지 않는다).
  static func resetForTesting() {
    lock.lock()
    pending = nil
    receiver = nil
    lock.unlock()
  }
}
