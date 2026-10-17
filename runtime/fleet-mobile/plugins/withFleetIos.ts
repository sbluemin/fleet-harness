import { ConfigPlugin, withAppDelegate, withInfoPlist } from "expo/config-plugins";

// withFleetAndroid.ts의 iOS 대응. Info.plist를 하드닝한다: fleet://join을 앱 URL 타입으로
// 등록(FleetLinkAppDelegateSubscriber가 RN Linking 이전에 소비), App Transport Security는
// 임의 로드 금지 + 로컬 루프백 게이트웨이(자체서명 HTTPS)만 예외로 허용.
// iOS 27은 UIScene 미채택을 시작 직후 EXC_BREAKPOINT로 죽인다. 매니페스트와 SceneDelegate를
// 여기서 넣는다. UIKit은 씬 델리게이트를 앱 델리게이트와 다른 인스턴스로 만들므로 팩토리와
// 소독된 launchOptions는 앱 델리게이트에 두고, 씬 쪽은 UIApplication.shared.delegate로 읽는다.
//
// withFleetAndroid와 같은 계약: 이 플러그인은 app.json plugins 배열의 마지막이어야 뒤의
// 플러그인이 하드닝을 되돌릴 수 없다(android-build-contract.test.ts가 검증).
const FLEET_SCHEME = "fleet";
const URL_NAME = "com.dotobokuri.fleet.mobile.join";
// 앱 타깃은 FleetLinkInbox를 import하지 못한다. 씬 URL은 이 이름으로 구독자에게 넘긴다.
const SCENE_URL_NOTIFICATION = "fleet.mobile.link-url";

// withFleetAndroid가 FleetLinkActivity로 얻는 보장을 iOS에서 만든다: fleet:// 페어링
// 크리덴셜이 JS Linking(getInitialURL, url 이벤트)에 절대 보이지 않게 한다.
//
// 콜드 스타트. ExpoAppDelegateSubscriberManager는 didFinishLaunching을 forEach로 돌려
// 같은 launchOptions를 모든 구독자에게 넘기고 반환값을 버린다. RCTLinkingManager.getInitialURL은
// UIApplicationLaunchOptionsURLKey만 읽는다. 그래서 소독 사본을 만들어 super와
// startReactNative 양쪽에 그 사본만 넘긴다. willFinish 구독자는 그 소독보다 먼저 원본을 받아
// 인박스에 넣는다. UIScene을 채택하면 콜드 URL이 connectionOptions.urlContexts로만 올 수 있어,
// 씬 willConnect도 같은 인박스 통지로 넣고 launchOptions에는 다시 넣지 않는다.
//
// 웜 스타트. 템플릿은 `super.application(open:) || RCTLinkingManager.application`이다.
// ExpoAppDelegate.application(open:)은 SubscriberManager 결과를 그대로 반환하고, 후보 URL에서
// 구독자가 true면 `||`의 오른쪽은 평가되지 않는다. 그 단락에 기대지 않는다. scheme==fleet이면
// application:openURL과 scene:openURLContexts 모두 RCTLinkingManager를 호출하지 않는다.
// 구독자가 없는 fleet URL, isCandidate가 아닌 fleet 스킴도 이 가드가 막는다.
const SANITIZED_VAR = "fleetSanitizedLaunchOptions";
const LAUNCH_OPTIONS_MARKER = `var ${SANITIZED_VAR} = launchOptions`;
// 계약의 본체. 이름과 순서만 보면 원본을 그대로 별칭한 사본도 통과하므로, 실제로 지우는
// 이 줄까지 요구해야 "크리덴셜이 지워졌다"는 단언이 된다(CI 단언도 같은 줄을 본다).
const STRIP_LAUNCH_URL = `${SANITIZED_VAR}?.removeValue(forKey: .url)`;
const START_REACT_NATIVE = /^([ \t]*)factory\.startReactNative\s*\(/m;
const SUPER_DID_FINISH_LAUNCHING =
  /^([ \t]*)((?:return\s+)?)super\.application\(\s*([A-Za-z_]\w*)\s*,\s*didFinishLaunchingWithOptions:\s*(launchOptions|fleetSanitizedLaunchOptions)\s*\)/m;
const PREVIOUS_SANITIZER =
  /[ \t]*\/\/ fleet-mobile: keep the fleet:\/\/ pairing credential out of Linking\.getInitialURL\(\)\.\n[ \t]*var fleetSanitizedLaunchOptions = launchOptions\n[ \t]*if let fleetLink = launchOptions\?\[\.url\] as\? URL, fleetLink\.scheme == "fleet" \{\n[ \t]*fleetSanitizedLaunchOptions\?\.removeValue\(forKey: \.url\)\n[ \t]*\}\n?/;
const OPEN_FORWARD =
  "return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)";
const STORE_SANITIZED = "self.fleetSanitizedLaunchOptions = fleetSanitizedLaunchOptions";
const SCENE_START_OPTIONS = "launchOptions: appDelegate.fleetSanitizedLaunchOptions";

const launchOptionsSanitizer = (indent: string) =>
  [
    `// fleet-mobile: keep the fleet:// pairing credential out of Linking.getInitialURL().`,
    LAUNCH_OPTIONS_MARKER,
    `if let fleetLink = launchOptions?[.url] as? URL, fleetLink.scheme == "${FLEET_SCHEME}" {`,
    `  ${STRIP_LAUNCH_URL}`,
    `}`,
  ]
    .map((line) => `${indent}${line}`)
    .join("\n");

function matchingParenEnd(source: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function findStartReactNative(contents: string): { index: number; indent: string; end: number } | null {
  const match = contents.match(START_REACT_NATIVE);
  if (match?.index == null || match[1] == null) return null;
  const open = contents.indexOf("(", match.index);
  const end = matchingParenEnd(contents, open);
  if (open < 0 || end < 0) return null;
  return { index: match.index, indent: match[1], end };
}

function fleetSchemeBlocksSkipLinking(contents: string): boolean {
  // continue userActivity도 RCTLinkingManager.application이다. fleet URL이 아닌 그 호출은 남긴다.
  const openCalls = contents.match(/RCTLinkingManager\.application\([^)]*open:/g);
  if (openCalls?.length !== 2) return false;
  const blocks = [...contents.matchAll(/if url\.scheme == "fleet" \{([\s\S]*?)\n\s*\}/g)];
  if (blocks.length !== 2) return false;
  return blocks.every((block) => !block[1]?.includes("RCTLinkingManager"));
}

function sceneContractHolds(contents: string): boolean {
  const markerAt = contents.indexOf(LAUNCH_OPTIONS_MARKER);
  const stripAt = contents.indexOf(STRIP_LAUNCH_URL);
  const storeAt = contents.indexOf(STORE_SANITIZED);
  const superMatch = contents.match(SUPER_DID_FINISH_LAUNCHING);
  if (markerAt < 0 || stripAt < markerAt || storeAt < stripAt) return false;
  if (superMatch?.index == null || superMatch.index < storeAt) return false;
  if (!/didFinishLaunchingWithOptions:\s*fleetSanitizedLaunchOptions/.test(superMatch[0])) return false;
  if (contents.includes("UIWindow(frame:")) return false;
  const start = findStartReactNative(contents);
  if (!start || start.index < superMatch.index) return false;
  const call = contents.slice(start.index, start.end);
  if (!call.includes(SCENE_START_OPTIONS)) return false;
  if (/launchOptions:\s*launchOptions/.test(call)) return false;
  const startedAt = contents.indexOf("appDelegate.fleetReactNativeStarted = true");
  const contextsAt = contents.indexOf("connectionOptions.urlContexts");
  const reattachAt = contents.indexOf("window.windowScene = windowScene");
  const keyAt = contents.indexOf("window.makeKeyAndVisible()");
  const alreadyStarted = contents.indexOf("if appDelegate.fleetReactNativeStarted");
  if (startedAt < 0 || contextsAt < 0 || contextsAt > alreadyStarted || alreadyStarted < 0) return false;
  if (reattachAt < alreadyStarted || keyAt < reattachAt || startedAt < keyAt || startedAt > start.index) return false;
  const reconnectBranch = contents.slice(alreadyStarted, startedAt);
  if (!reconnectBranch.includes("return")) return false;
  if (reconnectBranch.includes("startReactNative")) return false;
  if (!contents.includes("class SceneDelegate: UIResponder, UIWindowSceneDelegate")) return false;
  if (!contents.includes("UIWindow(windowScene:")) return false;
  if (!contents.includes(`Notification.Name("${SCENE_URL_NOTIFICATION}")`)) return false;
  if (!contents.includes('if url.scheme == "fleet"')) return false;
  return fleetSchemeBlocksSkipLinking(contents);
}

function stripPreviousSanitizer(contents: string): string {
  return contents
    .replace(PREVIOUS_SANITIZER, "")
    // 블록이 통째로 남아 있지 않은(= 위 정규식이 못 지운) 잔재까지 걷어낸다. 이걸 남기면
    // 아래 주입이 marker를 한 번 더 선언해 Swift가 중복 선언으로 죽는다.
    .replace(/[ \t]*var fleetSanitizedLaunchOptions = launchOptions\n/, "")
    .replace(/launchOptions:\s*fleetSanitizedLaunchOptions/g, "launchOptions: launchOptions")
    .replace(
      /didFinishLaunchingWithOptions:\s*fleetSanitizedLaunchOptions/g,
      "didFinishLaunchingWithOptions: launchOptions",
    );
}

function failClosed(reason: string, contents: string): never {
  throw new Error(
    `withFleetIos ${reason} in AppDelegate.swift, ` +
      "so the fleet:// pairing credential would still reach JS Linking.getInitialURL(). " +
      `Generated AppDelegate follows:\n${contents}`,
  );
}

function injectLaunchSanitizer(contents: string): string {
  const start = findStartReactNative(contents);
  const superMatch = contents.match(SUPER_DID_FINISH_LAUNCHING);
  if (!start) failClosed("could not find factory.startReactNative", contents);
  if (superMatch?.index == null || superMatch[2] == null || superMatch[3] == null) {
    failClosed("could not find the didFinishLaunchingWithOptions super call", contents);
  }
  if (start.index > superMatch.index) {
    failClosed("could not keep factory.startReactNative before super.didFinishLaunchingWithOptions", contents);
  }

  const originalCall = contents.slice(start.index, start.end);
  if (!/launchOptions:\s*launchOptions/.test(originalCall)) {
    failClosed("could not find startReactNative launchOptions: launchOptions", contents);
  }
  const sanitizedCall = originalCall.replace(/launchOptions:\s*launchOptions/g, `launchOptions: ${SANITIZED_VAR}`);
  const withStart = contents.slice(0, start.index) + sanitizedCall + contents.slice(start.end);

  const nextSuper = withStart.match(SUPER_DID_FINISH_LAUNCHING);
  if (nextSuper?.index == null || nextSuper[1] == null || nextSuper[2] == null || nextSuper[3] == null) {
    failClosed("could not find the didFinishLaunchingWithOptions super call", withStart);
  }
  const replacedSuper = withStart.replace(
    SUPER_DID_FINISH_LAUNCHING,
    `${nextSuper[1]}${nextSuper[2]}super.application(${nextSuper[3]}, didFinishLaunchingWithOptions: ${SANITIZED_VAR})`,
  );

  const injected = replacedSuper.replace(START_REACT_NATIVE, `${launchOptionsSanitizer(start.indent)}\n$&`);
  if (injected.indexOf(LAUNCH_OPTIONS_MARKER) > injected.indexOf("factory.startReactNative")) {
    failClosed("could not inject sanitized launchOptions before factory.startReactNative", injected);
  }
  return injected;
}

function sceneDelegateSource(startCall: string): string {
  return `class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    // UIKit instantiates the scene delegate separately from the app delegate.
    for context in connectionOptions.urlContexts {
      deliverFleetURLToInbox(context.url)
    }
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    // The process can outlive a scene. Reattach the existing window; do not start React Native again.
    if appDelegate.fleetReactNativeStarted {
      guard let window = appDelegate.window else { return }
      window.windowScene = windowScene
      window.makeKeyAndVisible()
      return
    }
    guard let factory = appDelegate.reactNativeFactory else { return }
    let window = UIWindow(windowScene: windowScene)
    appDelegate.window = window
    appDelegate.fleetReactNativeStarted = true
${startCall}
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      let url = context.url
      if url.scheme == "fleet" {
        deliverFleetURLToInbox(url)
      } else {
        _ = RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
      }
    }
  }
}

private func deliverFleetURLToInbox(_ url: URL) {
  guard url.scheme == "fleet" else { return }
  NotificationCenter.default.post(name: Notification.Name("${SCENE_URL_NOTIFICATION}"), object: url.absoluteString)
}
`;
}

function adoptSceneLifecycle(contents: string): string {
  const factoryDecl = "var reactNativeFactory: RCTReactNativeFactory?";
  if (contents.split(factoryDecl).length !== 2) {
    failClosed("could not find reactNativeFactory storage", contents);
  }
  let next = contents.replace(
    factoryDecl,
    `${factoryDecl}\n  var fleetSanitizedLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?\n  var fleetReactNativeStarted = false`,
  );

  const windowLine = "window = UIWindow(frame: UIScreen.main.bounds)\n";
  if (next.split(windowLine).length !== 2) {
    failClosed("could not find UIWindow(frame:) before scene adoption", next);
  }
  next = next.replace(windowLine, "");

  const start = findStartReactNative(next);
  if (!start) failClosed("could not find factory.startReactNative", next);
  const call = next.slice(start.index, start.end);
  if (!/launchOptions:\s*fleetSanitizedLaunchOptions/.test(call)) {
    failClosed("could not find startReactNative launchOptions: fleetSanitizedLaunchOptions", next);
  }
  const sceneCall = call.replace(
    /launchOptions:\s*fleetSanitizedLaunchOptions/,
    SCENE_START_OPTIONS,
  );
  next = `${next.slice(0, start.index)}${start.indent}${STORE_SANITIZED}${next.slice(start.end)}`;

  if (next.split(OPEN_FORWARD).length !== 2) {
    failClosed("could not find the openURL forward to RCTLinkingManager", next);
  }
  const guarded = [
    'if url.scheme == "fleet" {',
    "      return super.application(app, open: url, options: options)",
    "    }",
    `    ${OPEN_FORWARD}`,
  ].join("\n");
  next = next.replace(OPEN_FORWARD, guarded);

  const delegateAnchor = "class ReactNativeDelegate:";
  if (next.split(delegateAnchor).length !== 2) {
    failClosed("could not find ReactNativeDelegate anchor for SceneDelegate", next);
  }
  return next.replace(delegateAnchor, `${sceneDelegateSource(sceneCall)}\n${delegateAnchor}`);
}

// 테스트가 플러그인 소스만이 아니라 실제 주입 결과의 순서를 검사하도록 순수 변환을 노출한다.
export function sanitizeAppDelegateContents(contents: string): string {
  if (sceneContractHolds(contents)) return contents;
  const withScene = adoptSceneLifecycle(injectLaunchSanitizer(stripPreviousSanitizer(contents)));
  if (!sceneContractHolds(withScene)) {
    failClosed("could not adopt UIScene without exposing the fleet:// credential", withScene);
  }
  return withScene;
}

export const withFleetIos: ConfigPlugin = (config) => {
  config = withInfoPlist(config, (mod) => {
    const plist = mod.modResults as Record<string, unknown>;

    // fleet:// 딥링크 URL 타입만 남긴다. Expo는 번들 id(및 exp+slug) 스킴을 스스로 주입하는데,
    // 그것들은 이 앱이 쓰지 않는 추가 진입점이고 릴리스 검사기도 정확히 ["fleet"]만 허용한다.
    // 걸러서 덧붙이는 대신 통째로 교체해야 그 주입분이 남지 않는다.
    plist.CFBundleURLTypes = [{ CFBundleURLName: URL_NAME, CFBundleURLSchemes: [FLEET_SCHEME] }];

    // ATS: 임의 로드 금지. WKWebView는 로컬 게이트웨이의 자체서명 인증서를 ServerTrust 챌린지
    // (LocalCertificatePolicy)로만 신뢰하고, RemoteConnection은 NWConnection verify 블록으로
    // 핀한다 — ATS 예외로 원격 신뢰를 약화하지 않는다. NSAllowsLocalNetworking은 127/8 로컬
    // 게이트웨이 로드를 위한 것.
    plist.NSAppTransportSecurity = {
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
    };

    // 콘솔은 보통 같은 LAN의 다른 기기(192.168.x.x 등)에서 돌아간다. iOS 14+는 로컬 네트워크
    // 접근에 사용자 동의를 요구하고, 이 문자열이 없으면 시스템이 프롬프트를 띄우지 못해 연결이
    // 조용히 막힌다. 시뮬레이터는 이 정책을 강제하지 않으므로 누락이 시뮬레이터 테스트에서는
    // 드러나지 않는다 — 실기기 페어링에서만 터진다.
    plist.NSLocalNetworkUsageDescription =
      "Fleet connects to the Console running on your local network.";

    // The shell's own screens ship a Korean edition. iOS gives an app the device language only
    // when the bundle declares it; without this a Korean device still resolves to English.
    plist.CFBundleLocalizations = ["en", "ko"];

    // 수출 규정 준수 선언. Fleet의 암호화는 전부 OS가 제공하는 표준 TLS다 — 원격은
    // Network.framework, 로컬 게이트웨이는 Security.framework의 P-256 키와 자체서명 인증서,
    // WebView는 WKWebView. 독자 암호화 알고리즘은 없으므로 5D992 면제에 해당한다.
    // 이 키가 없으면 업로드된 빌드가 App Store Connect에서 Missing Compliance로 멈춰
    // 매 빌드마다 사람이 같은 질문에 답해야 하고, 그때까지 테스터에게 배포되지 않는다.
    plist.ITSAppUsesNonExemptEncryption = false;

    // 단일 윈도. 스토리보드 씬은 RN 루트와 윈도가 둘로 갈라지므로 넣지 않는다.
    // 클래스명은 앱 모듈의 SceneDelegate다(AppDelegate.swift에 같이 둔다). 앱 델리게이트
    // 클래스를 그대로 씬 델리게이트로 쓰면 UIKit이 두 번째 인스턴스를 만들고
    // ExpoAppDelegate.init의 구독자 훅이 다시 돈다.
    plist.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };

    return mod;
  });

  config = withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== "swift") {
      throw new Error(
        `withFleetIos needs a Swift AppDelegate to keep the pairing credential out of JS; found ${mod.modResults.language}.`,
      );
    }
    // 이미 올바른 순서면 재주입하지 않는다. 앵커/순서를 못 지키면 아래가 세운다.
    mod.modResults.contents = sanitizeAppDelegateContents(mod.modResults.contents);
    return mod;
  });

  return config;
};

export default withFleetIos;
