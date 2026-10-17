#!/usr/bin/env node
/**
 * Turn Fold turns on in the installed Fleet app on one simulator, without Simulator.app.
 *
 *   node fold-ios-turns.mjs <udid> <absolute-scratch-dir> <operation-title>
 *
 * <operation-title> is the conversation title. The info button is "{title} info"
 * (mobile.conv.infoAria). Writes a host app and UI test under <scratch-dir>/ios-fold-turns,
 * separate from accept-ios-open.mjs, and runs `xcodebuild test` against that UDID.
 * activate() does not relaunch: a screen a previous test left open stays open, and the test
 * taps Fold turns there. Otherwise it opens the conversation row, then "{title} info", then
 * Fold turns, then Back. Exit 0 is "** TEST SUCCEEDED **" with the group-composer labels.
 * This does not boot, install, or delete a simulator.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [udid, scratch, title] = process.argv.slice(2);
if (!udid || !scratch || !path.isAbsolute(scratch) || !title || /["\\\n]/.test(title)) {
  process.stderr.write('usage: node fold-ios-turns.mjs <udid> <absolute-scratch-dir> <operation-title>\n');
  process.exit(2);
}

const root = path.join(scratch, 'ios-fold-turns');
const host = path.join(root, 'FoldHost');
const tests = path.join(root, 'FoldTurnsTests');
mkdirSync(host, { recursive: true });
mkdirSync(tests, { recursive: true });
mkdirSync(path.join(root, 'FoldTurns.xcodeproj', 'xcshareddata', 'xcschemes'), { recursive: true });

writeFileSync(path.join(host, 'AppDelegate.swift'), `import UIKit
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    window?.rootViewController = UIViewController()
    window?.makeKeyAndVisible()
    return true
  }
}
`);
writeFileSync(path.join(host, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>
`);
writeFileSync(path.join(tests, 'FoldTurnsTests.swift'), `import XCTest
final class FoldTurnsTests: XCTestCase {
  func testFoldTurns() {
    let app = XCUIApplication(bundleIdentifier: "com.dotobokuri.fleet.mobile")
    // activate() does not relaunch. A previous test's screen stays where it was.
    app.activate()
    let fold = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Fold turns")).element(boundBy: 0)
    if !fold.waitForExistence(timeout: 2) {
      let info = app.buttons["${title} info"]
      if !info.waitForExistence(timeout: 2) {
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "${title}")).element(boundBy: 0)
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
      }
      XCTAssertTrue(info.waitForExistence(timeout: 10))
      info.tap()
    }
    XCTAssertTrue(fold.waitForExistence(timeout: 10))
    fold.tap()
    let back = app.buttons["Back"]
    XCTAssertTrue(back.waitForExistence(timeout: 5))
    back.tap()
    let field = app.textViews["Group conversation message"]
    XCTAssertTrue(field.waitForExistence(timeout: 15))
    XCTAssertEqual(field.placeholderValue, "Message the commander · @ to pick a member")
    XCTAssertTrue(app.switches["Plan"].exists)
    XCTAssertTrue(app.switches["Commence"].exists)
  }
}
`);
writeFileSync(path.join(tests, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>
`);

const pbx = `// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = {};
  objectVersion = 56;
  objects = {
    A10000000000000000000001 /* FoldTurns */ = { isa = PBXProject; attributes = { LastUpgradeCheck = 1600; }; buildConfigurationList = A10000000000000000000010; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = A10000000000000000000002; productRefGroup = A10000000000000000000003; projectDirPath = ""; projectRoot = ""; targets = (A10000000000000000000020, A10000000000000000000030); };
    A10000000000000000000002 /* main */ = { isa = PBXGroup; children = (A10000000000000000000004, A10000000000000000000005, A10000000000000000000003); sourceTree = "<group>"; };
    A10000000000000000000003 /* Products */ = { isa = PBXGroup; children = (A10000000000000000000021, A10000000000000000000031); name = Products; sourceTree = "<group>"; };
    A10000000000000000000004 /* FoldHost */ = { isa = PBXGroup; children = (A10000000000000000000022, A10000000000000000000023); path = FoldHost; sourceTree = "<group>"; };
    A10000000000000000000005 /* FoldTurnsTests */ = { isa = PBXGroup; children = (A10000000000000000000032, A10000000000000000000033); path = FoldTurnsTests; sourceTree = "<group>"; };
    A10000000000000000000021 /* FoldHost.app */ = { isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = FoldHost.app; sourceTree = BUILT_PRODUCTS_DIR; };
    A10000000000000000000022 /* AppDelegate.swift */ = { isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = "<group>"; };
    A10000000000000000000023 /* Info.plist */ = { isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
    A10000000000000000000031 /* FoldTurnsTests.xctest */ = { isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = FoldTurnsTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
    A10000000000000000000032 /* FoldTurnsTests.swift */ = { isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = FoldTurnsTests.swift; sourceTree = "<group>"; };
    A10000000000000000000033 /* Info.plist */ = { isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
    A10000000000000000000024 /* Sources */ = { isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A10000000000000000000025); runOnlyForDeploymentPostprocessing = 0; };
    A10000000000000000000025 /* AppDelegate.swift in Sources */ = { isa = PBXBuildFile; fileRef = A10000000000000000000022; };
    A10000000000000000000034 /* Sources */ = { isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A10000000000000000000035); runOnlyForDeploymentPostprocessing = 0; };
    A10000000000000000000035 /* FoldTurnsTests.swift in Sources */ = { isa = PBXBuildFile; fileRef = A10000000000000000000032; };
    A10000000000000000000026 /* Frameworks */ = { isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
    A10000000000000000000036 /* Frameworks */ = { isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
    A10000000000000000000020 /* FoldHost */ = { isa = PBXNativeTarget; buildConfigurationList = A10000000000000000000040; buildPhases = (A10000000000000000000024, A10000000000000000000026); buildRules = (); dependencies = (); name = FoldHost; productName = FoldHost; productReference = A10000000000000000000021; productType = "com.apple.product-type.application"; };
    A10000000000000000000030 /* FoldTurnsTests */ = { isa = PBXNativeTarget; buildConfigurationList = A10000000000000000000050; buildPhases = (A10000000000000000000034, A10000000000000000000036); buildRules = (); dependencies = (A10000000000000000000037); name = FoldTurnsTests; productName = FoldTurnsTests; productReference = A10000000000000000000031; productType = "com.apple.product-type.bundle.ui-testing"; };
    A10000000000000000000037 /* PBXTargetDependency */ = { isa = PBXTargetDependency; target = A10000000000000000000020; targetProxy = A10000000000000000000038; };
    A10000000000000000000038 /* PBXContainerItemProxy */ = { isa = PBXContainerItemProxy; containerPortal = A10000000000000000000001; proxyType = 1; remoteGlobalIDString = A10000000000000000000020; remoteInfo = FoldHost; };
    A10000000000000000000010 /* Build configuration list for PBXProject */ = { isa = XCConfigurationList; buildConfigurations = (A10000000000000000000011); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
    A10000000000000000000011 /* Debug */ = { isa = XCBuildConfiguration; buildSettings = { ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; CODE_SIGNING_ALLOWED = NO; SDKROOT = iphonesimulator; SWIFT_VERSION = 5.0; IPHONEOS_DEPLOYMENT_TARGET = 15.1; }; name = Debug; };
    A10000000000000000000040 /* Build configuration list for PBXNativeTarget "FoldHost" */ = { isa = XCConfigurationList; buildConfigurations = (A10000000000000000000041); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
    A10000000000000000000041 /* Debug */ = { isa = XCBuildConfiguration; buildSettings = { CODE_SIGNING_ALLOWED = NO; GENERATE_INFOPLIST_FILE = NO; INFOPLIST_FILE = FoldHost/Info.plist; IPHONEOS_DEPLOYMENT_TARGET = 15.1; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks"; PRODUCT_BUNDLE_IDENTIFIER = com.fleet.e2e.foldturns; PRODUCT_NAME = FoldHost; SDKROOT = iphonesimulator; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = 1; }; name = Debug; };
    A10000000000000000000050 /* Build configuration list for PBXNativeTarget "FoldTurnsTests" */ = { isa = XCConfigurationList; buildConfigurations = (A10000000000000000000051); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
    A10000000000000000000051 /* Debug */ = { isa = XCBuildConfiguration; buildSettings = { CODE_SIGNING_ALLOWED = NO; GENERATE_INFOPLIST_FILE = NO; INFOPLIST_FILE = FoldTurnsTests/Info.plist; IPHONEOS_DEPLOYMENT_TARGET = 15.1; PRODUCT_BUNDLE_IDENTIFIER = com.fleet.e2e.foldturns.tests; PRODUCT_NAME = FoldTurnsTests; SDKROOT = iphonesimulator; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = 1; TEST_TARGET_NAME = FoldHost; }; name = Debug; };
  };
  rootObject = A10000000000000000000001;
}
`;
writeFileSync(path.join(root, 'FoldTurns.xcodeproj', 'project.pbxproj'), pbx);
writeFileSync(path.join(root, 'FoldTurns.xcodeproj', 'xcshareddata', 'xcschemes', 'FoldHost.xcscheme'), `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000020" BuildableName="FoldHost.app" BlueprintName="FoldHost" ReferencedContainer="container:FoldTurns.xcodeproj"/>
      </BuildActionEntry>
      <BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000030" BuildableName="FoldTurnsTests.xctest" BlueprintName="FoldTurnsTests" ReferencedContainer="container:FoldTurns.xcodeproj"/>
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
    <Testables>
      <TestableReference skipped="NO">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000030" BuildableName="FoldTurnsTests.xctest" BlueprintName="FoldTurnsTests" ReferencedContainer="container:FoldTurns.xcodeproj"/>
      </TestableReference>
    </Testables>
  </TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
    <BuildableProductRunnable runnableDebuggingMode="0">
      <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000020" BuildableName="FoldHost.app" BlueprintName="FoldHost" ReferencedContainer="container:FoldTurns.xcodeproj"/>
    </BuildableProductRunnable>
  </LaunchAction>
  <ProfileAction buildConfiguration="Debug" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><MacroExpansion><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000020" BuildableName="FoldHost.app" BlueprintName="FoldHost" ReferencedContainer="container:FoldTurns.xcodeproj"/></MacroExpansion></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Debug" revealArchiveInOrganizer="YES"/>
</Scheme>
`);

const result = spawnSync('xcodebuild', [
  'test', '-project', path.join(root, 'FoldTurns.xcodeproj'), '-scheme', 'FoldHost',
  '-destination', `id=${udid}`, '-derivedDataPath', path.join(scratch, 'ios-open-dd'),
  'CODE_SIGNING_ALLOWED=NO',
], { stdio: 'inherit' });
process.exit(result.status ?? 1);
