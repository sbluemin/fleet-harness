import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeAppDelegateContents } from "../plugins/withFleetIos.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

// Expo 57 템플릿 AppDelegate에서 이 플러그인이 앵커로 삼는 부분만 남긴 입력.
const templateAppDelegate = `class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let factory = ExpoReactNativeFactory(delegate: delegate)
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
}
`;

describe("Fleet Mobile iOS build contract", () => {

  it("withFleetIos disables arbitrary ATS loads and owns the fleet URL scheme", () => {
    const plugin = read("runtime/fleet-mobile/plugins/withFleetIos.ts");
    expect(plugin).toContain("NSAllowsArbitraryLoads: false");
    expect(plugin).toContain("CFBundleURLSchemes");
    expect(plugin).toContain('"fleet"');
    // LAN 콘솔 페어링은 이 키 없이는 실기기에서 프롬프트도 뜨지 않고 막힌다.
    expect(plugin).toContain("NSLocalNetworkUsageDescription");
    // 이 선언이 없으면 업로드된 빌드가 Missing Compliance로 멈춰 테스터에게 가지 않는다.
    expect(plugin).toContain("ITSAppUsesNonExemptEncryption = false");
  });

  // Android는 FleetLinkActivity가 URI를 지우고 MainActivity를 띄워 크리덴셜을 JS에서 막는다.
  // iOS는 구독자로 그 보장을 만들 수 없어(Expo가 launchOptions를 모든 구독자에게 그대로 넘김)
  // AppDelegate에서 지운다. 이 주입이 사라지면 Linking.getInitialURL()이 페어링 토큰을 준다.
  // UIScene 경로는 launchOptions에 URL이 없을 수 있으므로, willConnect의 urlContexts와
  // scene:openURLContexts도 fleet 스킴이면 RCTLinkingManager로 넘기지 않아야 한다.
  it("strips the fleet:// credential from launchOptions before React sees it", () => {
    const plugin = read("runtime/fleet-mobile/plugins/withFleetIos.ts");
    const subscriber = read("runtime/fleet-mobile/modules/fleet-console-view/ios/FleetLinkAppDelegateSubscriber.swift");
    expect(plugin).toContain("withAppDelegate");
    expect(plugin).toContain("didFinishLaunchingWithOptions");
    expect(plugin).toContain("removeValue(forKey: .url)");
    expect(plugin).toContain("factory.startReactNative");
    expect(plugin).toContain("var fleetSanitizedLaunchOptions = launchOptions");
    expect(plugin).toContain("UIApplicationSceneManifest");
    expect(plugin).toContain("$(PRODUCT_MODULE_NAME).SceneDelegate");
    // 앵커를 못 찾았을 때 조용히 넘어가면 크리덴셜이 노출된 채로 빌드된다 — 반드시 세워야 한다.
    expect(plugin).toContain("could not find factory.startReactNative");
    expect(plugin).toContain("could not find the didFinishLaunchingWithOptions super call");
    expect(plugin).toContain("could not find the openURL forward to RCTLinkingManager");
    expect(plugin).toContain("fleet.mobile.link-url");
    expect(subscriber).toContain('Notification.Name("fleet.mobile.link-url")');

    const out = sanitizeAppDelegateContents(templateAppDelegate);
    expect(out).toBe(sanitizeAppDelegateContents(out));
    const marker = out.indexOf("var fleetSanitizedLaunchOptions = launchOptions");
    const strip = out.indexOf("fleetSanitizedLaunchOptions?.removeValue(forKey: .url)");
    const store = out.indexOf("self.fleetSanitizedLaunchOptions = fleetSanitizedLaunchOptions");
    const superAt = out.indexOf("didFinishLaunchingWithOptions: fleetSanitizedLaunchOptions");
    const start = out.indexOf("factory.startReactNative");
    const startOptions = out.indexOf("launchOptions: appDelegate.fleetSanitizedLaunchOptions", start);
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(strip).toBeGreaterThan(marker);
    expect(store).toBeGreaterThan(strip);
    expect(superAt).toBeGreaterThan(store);
    expect(start).toBeGreaterThan(superAt);
    expect(startOptions).toBeGreaterThan(start);
    expect(out).not.toContain("UIWindow(frame:");
    expect(out).toContain("UIWindow(windowScene:");
    expect(out).toContain('Notification.Name("fleet.mobile.link-url")');
    expect(out).toContain("connectionOptions.urlContexts");
    const reconnect = out.indexOf("if appDelegate.fleetReactNativeStarted");
    const reattach = out.indexOf("window.windowScene = windowScene");
    const key = out.indexOf("window.makeKeyAndVisible()");
    const started = out.indexOf("appDelegate.fleetReactNativeStarted = true");
    expect(out.indexOf("connectionOptions.urlContexts")).toBeLessThan(reconnect);
    expect(reattach).toBeGreaterThan(reconnect);
    expect(key).toBeGreaterThan(reattach);
    expect(started).toBeGreaterThan(key);
    expect(start).toBeGreaterThan(started);
    expect(out.slice(reconnect, started)).not.toContain("startReactNative");
    const fleetBranches = [...out.matchAll(/if url\.scheme == "fleet" \{([\s\S]*?)\n\s*\}/g)];
    expect(fleetBranches).toHaveLength(2);
    for (const branch of fleetBranches) expect(branch[1]).not.toContain("RCTLinkingManager");
    expect(out.match(/RCTLinkingManager\.application\([^)]*open:/g)).toHaveLength(2);
  });

  it("fails closed when the startReactNative or super.didFinish anchors are missing", () => {
    expect(() =>
      sanitizeAppDelegateContents("return super.application(application, didFinishLaunchingWithOptions: launchOptions)"),
    ).toThrow(/could not find factory\.startReactNative/);
    expect(() =>
      sanitizeAppDelegateContents(`
        factory.startReactNative(
          withModuleName: "main",
          in: window,
          launchOptions: launchOptions)
      `),
    ).toThrow(/could not find the didFinishLaunchingWithOptions super call/);
    expect(() =>
      sanitizeAppDelegateContents(templateAppDelegate.replace(/public override func application\(\s*\n\s*_ app: UIApplication,[\s\S]*?\n  \}\n/, "")),
    ).toThrow(/could not find the openURL forward to RCTLinkingManager/);
  });

  it("recovers a terminated committed WKWebView without leaving a connected black screen", () => {
    const view = read("runtime/fleet-mobile/modules/fleet-console-view/ios/FleetConsoleView.swift");
    expect(view).toContain("webViewWebContentProcessDidTerminate");
    expect(view).toContain("recoverTerminatedActiveLoad");
    expect(view).toMatch(/guard let activeLoad, activeLoad\.view === webView else \{ return \}/);
    expect(view).toContain("activeView = nil");
    expect(view).toContain("activeLoad = nil");
    expect(view).toContain('emit("error", code: "remote_host_unavailable")');
    expect(view).toContain("beginAttempt(target, token: nil)");
    expect(view).toContain('private static let readinessObject = "fleetReadiness"');
    expect(view).toContain("config.websiteDataStore = .nonPersistent()");
    expect(view).toContain("activeLoad = staged");
  });

  it("keeps AccessLink source free of literal C0 bytes", () => {
    const bytes = readFileSync(
      path.join(repoRoot, "runtime/fleet-mobile/modules/fleet-console-view/ios/Core/AccessLink.swift"),
    );
    const illegal = [...bytes].filter((b) => (b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127);
    expect(illegal).toEqual([]);
  });

  it("release signing is env-only and fails closed without the certificate", () => {
    const tools = read("runtime/fleet-mobile/scripts/lib/ios-tools.mjs");
    expect(tools).toContain("FLEET_IOS_CERTIFICATE_BASE64");
    expect(tools).toContain("must be signed with an Apple Distribution identity");
    expect(tools).toContain("must not carry get-task-allow");
  });
});
