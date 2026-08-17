import ExpoModulesCore

// FleetLinkActivity.kt의 iOS 이식. fleet://join 크리덴셜 URL을 네이티브 인박스로만 전달하고
// JS에는 절대 보이지 않게 한다.
//
// Android는 이걸 별도 Activity로 푼다: FleetLinkActivity가 인텐트를 받아 데이터를 읽고
// `source.data = null`로 지운 뒤 MainActivity를 띄우므로, JS는 URI를 볼 기회 자체가 없다.
//
// iOS에서 구독자만으로는 같은 보장을 만들 수 없다. ExpoAppDelegateSubscriberManager는
//   - open:url을 `reduce(false) { s.application?(...) ?? false || result }`로 돌려 **모든**
//     구독자를 호출한다 — true를 반환해도 전파가 멈추지 않는다.
//   - didFinishLaunching은 `forEach`로 **같은** launchOptions를 모든 구독자에게 넘기고
//     반환값을 버린다.
// 즉 여기서 무엇을 반환하든 RN Linking은 URL을 그대로 받는다.
//
// 그래서 실제 차단은 AppDelegate에서 한다(plugins/withFleetIos.ts가 주입): super로 넘기기
// 전에 launchOptions에서 fleet:// URL을 제거하므로 React 호스트와 이후 구독자는 소독된
// 사본만 본다. 이 구독자는 그 소독보다 **먼저** 도는 willFinishLaunching에서 원본을 받아
// 인박스에 넣는다 — 콜드 스타트에서 우리가 URL을 보는 유일한 지점이다.
public final class FleetLinkAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  // 콜드 스타트. AppDelegate가 launchOptions를 소독하기 전에 도는 단계라 원본이 들어온다.
  public func application(
    _ application: UIApplication,
    willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if let url = launchOptions?[.url] as? URL, FleetLinkInbox.isCandidate(url.absoluteString) {
      FleetLinkInbox.offer(url.absoluteString)
    }
    return false
  }

  // 실행 중 열림. AppDelegate가 fleet:// URL을 super로 넘기지 않으므로 RN Linking에는
  // 도달하지 않는다. 여기 반환값은 전파를 막지 못하며(위 참조), 이 앱이 그 URL을 처리했다는
  // 사실만 iOS에 알린다.
  public func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    let raw = url.absoluteString
    guard FleetLinkInbox.isCandidate(raw) else { return false }
    FleetLinkInbox.offer(raw)
    return true
  }
}
