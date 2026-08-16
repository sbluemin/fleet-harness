import ExpoModulesCore

// iOS 이식의 스캐폴드. JS가 해석하는 모듈 이름(FleetConsoleView)의 자리만 잡는다 —
// 뷰·이벤트·핸들 함수는 콘솔 뷰 이식 태스크가 채우며, 이 스텁 상태로는 머지하지 않는다.
public final class FleetMobileModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FleetConsoleView")
  }
}
