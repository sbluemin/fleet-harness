import Foundation
import os

// 연결 파이프라인의 진단 로그. 사용자에게 보이는 에러 코드는 Android와 동일하게 유지해야
// 하는데, 그 코드 하나로는 어느 단계에서 깨졌는지 구분되지 않는다(특히 generic catch가
// 게이트웨이·키체인 실패까지 remote_link_unreachable로 뭉갠다). 단계와 실패 원인을 os_log로
// 남겨 `xcrun simctl spawn booted log stream --predicate 'process == "Fleet"'` 로 읽을 수 있게 한다.
//
// 크리덴셜은 절대 남기지 않는다: 토큰·쿠키·링크 원문은 로그에 넣지 않으며, 단계 이름과
// 에러 코드/설명만 남긴다.
enum FleetLog {
  private static let logger = Logger(subsystem: "com.dotobokuri.fleet.mobile", category: "console")

  static func stage(_ name: String) {
    logger.notice("stage: \(name, privacy: .public)")
  }

  static func failed(_ stage: String, _ reason: String) {
    logger.error("failed at \(stage, privacy: .public): \(reason, privacy: .public)")
  }

  static func note(_ message: String) {
    logger.notice("\(message, privacy: .public)")
  }
}
