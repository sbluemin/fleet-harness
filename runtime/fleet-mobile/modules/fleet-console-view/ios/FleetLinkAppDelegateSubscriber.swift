import ExpoModulesCore

// FleetLinkActivity.kt의 iOS 이식. fleet://join 크리덴셜 URL을 React Native/Expo Linking에
// 넘기기 전에 네이티브에서 소비해 인박스로만 전달한다 — 크리덴셜이 JS의 initialURL이나 Linking
// 이벤트에 절대 노출되지 않게. 콜드 스타트(launchOptions)와 실행 중(open URL) 양쪽을 처리한다.
public final class FleetLinkAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    let raw = url.absoluteString
    guard FleetLinkInbox.isCandidate(raw) else { return false }
    FleetLinkInbox.offer(raw)
    // true를 반환해 이 URL이 다른 구독자(RN Linking)로 전파되지 않게 소비한다.
    return true
  }

  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if let url = launchOptions?[.url] as? URL, FleetLinkInbox.isCandidate(url.absoluteString) {
      FleetLinkInbox.offer(url.absoluteString)
    }
    return true
  }
}
