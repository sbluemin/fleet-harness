import ExpoModulesCore

// FleetLinkActivity.kt의 iOS 이식. fleet://join 크리덴셜 URL을 네이티브 인박스로만 전달하고
// JS에는 절대 보이지 않게 한다.
//
// Android는 이걸 별도 Activity로 푼다: FleetLinkActivity가 인텐트를 받아 데이터를 읽고
// `source.data = null`로 지운 뒤 MainActivity를 띄우므로, JS는 URI를 볼 기회 자체가 없다.
//
// iOS 콜드 스타트에서 launchOptions의 URL은 willFinishLaunching이 본다. 이 콜백은
// AppDelegate가 launchOptions를 소독하기 전이고, ExpoAppDelegate가 구독자에게 원본을 넘긴다.
// didFinishLaunching 소독은 구독자가 돌려준 값으로 dictionary를 고치지 않는다
// (SubscriberManager가 반환값을 버린다). 그래서 인박스 적재는 여기서 하고, JS로 가는 사본을
// 지우는 일은 AppDelegate 플러그인이 한다.
//
// iOS 웜 스타트에서 application:openURL은 이 구독자까지 도달한다. ExpoAppDelegate는
// SubscriberManager의 Bool을 그대로 반환하고, 템플릿의 `super || RCTLinkingManager`는 super가
// true면 RCTLinkingManager를 호출하지 않는다. 그 단락 평가에 기대지 않는다. 플러그인이
// scheme==fleet이면 RCTLinkingManager를 건너뛰는 가드를 따로 넣는다. 이 메서드가 true를
// 반환해도 SubscriberManager는 다른 구독자를 계속 호출한다.
//
// UIScene을 채택하면 같은 URL이 connectionOptions.urlContexts / scene:openURLContexts로만
// 올 수 있다. 앱 타깃은 이 모듈을 import하지 못하므로 SceneDelegate가
// fleet.mobile.link-url 통지를 보내고, 여기서 인박스로 넣는다. UIKit이 애플리케이션 경로와
// 씬 경로에 같은 크리덴셜을 둘 다 주면 1회용 토큰이 두 번 join된다. 같은 문자열의 재전달은
// 짧게 접는다.
public final class FleetLinkAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  private static let sceneURLNotification = Notification.Name("fleet.mobile.link-url")
  private static let duplicateWindow: CFAbsoluteTime = 2
  private var lastDeliveredRaw: String?
  private var lastDeliveredAt: CFAbsoluteTime = 0

  public func subscriberDidRegister() {
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(receiveSceneLink(_:)),
      name: Self.sceneURLNotification,
      object: nil
    )
  }

  @objc private func receiveSceneLink(_ notification: Notification) {
    guard let raw = notification.object as? String else { return }
    deliver(raw)
  }

  // 콜드 스타트. AppDelegate가 launchOptions를 소독하기 전에 도는 단계라 원본이 들어온다.
  public func application(
    _ application: UIApplication,
    willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if let url = launchOptions?[.url] as? URL {
      deliver(url.absoluteString)
    }
    return false
  }

  // 실행 중 열림. super는 항상 호출되고, fleet 스킴을 RCTLinkingManager로 넘기지 않는 가드는
  // AppDelegate에 있다. true는 "이 앱이 처리했다"는 뜻일 뿐 다른 구독자를 멈추지 않는다.
  public func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    guard url.scheme == "fleet" else { return false }
    deliver(url.absoluteString)
    return true
  }

  private func deliver(_ raw: String) {
    let now = CFAbsoluteTimeGetCurrent()
    if lastDeliveredRaw == raw, now - lastDeliveredAt < Self.duplicateWindow {
      return
    }
    lastDeliveredRaw = raw
    lastDeliveredAt = now
    FleetLinkInbox.offer(raw)
  }
}
