import ExpoModulesCore

// FleetMobileModule.kt의 iOS 이식. JS가 requireNativeModule/requireNativeViewManager로 찾는
// 이름은 "FleetConsoleView"이고, 뷰는 onFleetEvent를 발생시키며 7개 명령을 노출한다 —
// JS 셸(FleetConsoleView.tsx)이 Android와 동일 계약으로 동작하도록.
public final class FleetMobileModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FleetConsoleView")

    View(FleetConsoleView.self) {
      Events("onFleetEvent")

      AsyncFunction("retry") { (view: FleetConsoleView) in view.retry() }
      AsyncFunction("resume") { (view: FleetConsoleView) in view.resume() }
      AsyncFunction("submitAccessLink") { (view: FleetConsoleView, link: String) in view.submitAccessLink(link) }
      AsyncFunction("connectTo") { (view: FleetConsoleView, origin: String) in view.connectTo(origin) }
      AsyncFunction("removeTarget") { (view: FleetConsoleView, origin: String) in view.removeTarget(origin) }
      AsyncFunction("listTargets") { (view: FleetConsoleView) -> [[String: Any]] in view.listTargets() }
      AsyncFunction("navigateBack") { (view: FleetConsoleView) -> Bool in view.navigateBack() }
    }
  }
}
