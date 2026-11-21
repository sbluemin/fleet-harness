// AI 전용 커서 인터페이스. 설계 계약 §5 그대로이며 mac-helper가 이 프로토콜만 호출한다. 원래 문구: 인터페이스는 설계 계약 §5 그대로이며 mac-helper가 이 프로토콜만 호출한다.
import AppKit

public enum AICursorPulse {
  case click, doubleClick, rightClick, typing(Bool), scroll(Direction), dragBegin, dragEnd
  public enum Direction { case up, down, left, right }
}

@MainActor public protocol AICursorControlling: AnyObject {
  /// 전역 CG 좌표(좌상단 원점). 대상 창 바로 위(일반 레벨)에 정렬해 보인다.
  func show(at point: CGPoint, above window: CGWindowID)
  /// 현재 위치에서 point로 애니메이션 이동(거리 비례 180~520ms). 완료 시 반환. 이동 중 새 호출은 이어받는다.
  func move(to point: CGPoint, above window: CGWindowID) async
  /// 동작 피드백
  func pulse(_ kind: AICursorPulse) async
  /// 대상 창 z순서가 바뀌었을 때 다시 바로 위로
  func reorder(above window: CGWindowID)
  /// 숨김(대상 창 숨김·최소화·다른 Space·세션 종료·유휴)
  func hide(animated: Bool)
  var isVisible: Bool { get }
}

// 구현은 같은 폴더의 CursorOverlay.swift(FleetAICursor·makeAICursor), CursorArt.swift(모습), CursorTokens.swift(토큰), CursorDemo.swift(--cursor-demo).
