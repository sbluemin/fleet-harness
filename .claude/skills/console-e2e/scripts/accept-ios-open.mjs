#!/usr/bin/env node
/**
 * Tap the system "Open" button of an "Open in Fleet?" alert on one simulator, without Simulator.app.
 *
 *   node accept-ios-open.mjs <udid> <scratch-dir>
 *
 * Writes a tiny host app and UI test under <scratch-dir> (never the repository) and runs
 * `xcodebuild test` against that UDID. Exit 0 means the button named Open was tapped.
 * The alert must already be up. This does not boot, install, or delete a simulator.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [udid, scratch] = process.argv.slice(2);
if (!udid || !scratch || !path.isAbsolute(scratch)) {
  process.stderr.write('usage: node accept-ios-open.mjs <udid> <absolute-scratch-dir>\n');
  process.exit(2);
}

const root = path.join(scratch, 'ios-open-alert');
const host = path.join(root, 'OpenHost');
const tests = path.join(root, 'OpenAlertTests');
mkdirSync(host, { recursive: true });
mkdirSync(tests, { recursive: true });
mkdirSync(path.join(root, 'OpenAlert.xcodeproj', 'xcshareddata', 'xcschemes'), { recursive: true });

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
writeFileSync(path.join(tests, 'OpenAlertTests.swift'), `import XCTest
final class OpenAlertTests: XCTestCase {
  func testTapOpen() {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let open = springboard.buttons["Open"]
    XCTAssertTrue(open.waitForExistence(timeout: 20))
    open.tap()
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
    A10000000000000000000001 /* OpenAlert */ = { isa = PBXProject; attributes = { LastUpgradeCheck = 1600; }; buildConfigurationList = A10000000000000000000010; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = A10000000000000000000002; productRefGroup = A10000000000000000000003; projectDirPath = ""; projectRoot = ""; targets = (A10000000000000000000020, A10000000000000000000030); };
    A10000000000000000000002 /* main */ = { isa = PBXGroup; children = (A10000000000000000000004, A10000000000000000000005, A10000000000000000000003); sourceTree = "<group>"; };
    A10000000000000000000003 /* Products */ = { isa = PBXGroup; children = (A10000000000000000000021, A10000000000000000000031); name = Products; sourceTree = "<group>"; };
    A10000000000000000000004 /* OpenHost */ = { isa = PBXGroup; children = (A10000000000000000000022, A10000000000000000000023); path = OpenHost; sourceTree = "<group>"; };
    A10000000000000000000005 /* OpenAlertTests */ = { isa = PBXGroup; children = (A10000000000000000000032, A10000000000000000000033); path = OpenAlertTests; sourceTree = "<group>"; };
    A10000000000000000000021 /* OpenHost.app */ = { isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = OpenHost.app; sourceTree = BUILT_PRODUCTS_DIR; };
    A10000000000000000000022 /* AppDelegate.swift */ = { isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = "<group>"; };
    A10000000000000000000023 /* Info.plist */ = { isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
    A10000000000000000000031 /* OpenAlertTests.xctest */ = { isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = OpenAlertTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; };
    A10000000000000000000032 /* OpenAlertTests.swift */ = { isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = OpenAlertTests.swift; sourceTree = "<group>"; };
    A10000000000000000000033 /* Info.plist */ = { isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
    A10000000000000000000024 /* Sources */ = { isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A10000000000000000000025); runOnlyForDeploymentPostprocessing = 0; };
    A10000000000000000000025 /* AppDelegate.swift in Sources */ = { isa = PBXBuildFile; fileRef = A10000000000000000000022; };
    A10000000000000000000034 /* Sources */ = { isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A10000000000000000000035); runOnlyForDeploymentPostprocessing = 0; };
    A10000000000000000000035 /* OpenAlertTests.swift in Sources */ = { isa = PBXBuildFile; fileRef = A10000000000000000000032; };
    A10000000000000000000026 /* Frameworks */ = { isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
    A10000000000000000000036 /* Frameworks */ = { isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
    A10000000000000000000020 /* OpenHost */ = { isa = PBXNativeTarget; buildConfigurationList = A10000000000000000000040; buildPhases = (A10000000000000000000024, A10000000000000000000026); buildRules = (); dependencies = (); name = OpenHost; productName = OpenHost; productReference = A10000000000000000000021; productType = "com.apple.product-type.application"; };
    A10000000000000000000030 /* OpenAlertTests */ = { isa = PBXNativeTarget; buildConfigurationList = A10000000000000000000050; buildPhases = (A10000000000000000000034, A10000000000000000000036); buildRules = (); dependencies = (A10000000000000000000037); name = OpenAlertTests; productName = OpenAlertTests; productReference = A10000000000000000000031; productType = "com.apple.product-type.bundle.ui-testing"; };
    A10000000000000000000037 /* PBXTargetDependency */ = { isa = PBXTargetDependency; target = A10000000000000000000020; targetProxy = A10000000000000000000038; };
    A10000000000000000000038 /* PBXContainerItemProxy */ = { isa = PBXContainerItemProxy; containerPortal = A10000000000000000000001; proxyType = 1; remoteGlobalIDString = A10000000000000000000020; remoteInfo = OpenHost; };
    A10000000000000000000010 /* Build configuration list for PBXProject */ = { isa = XCConfigurationList; buildConfigurations = (A10000000000000000000011); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
    A10000000000000000000011 /* Debug */ = { isa = XCBuildConfiguration; buildSettings = { ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; CODE_SIGNING_ALLOWED = NO; SDKROOT = iphonesimulator; SWIFT_VERSION = 5.0; IPHONEOS_DEPLOYMENT_TARGET = 15.1; }; name = Debug; };
    A10000000000000000000040 /* Build configuration list for PBXNativeTarget "OpenHost" */ = { isa = XCConfigurationList; buildConfigurations = (A10000000000000000000041); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
    A10000000000000000000041 /* Debug */ = { isa = XCBuildConfiguration; buildSettings = { CODE_SIGNING_ALLOWED = NO; GENERATE_INFOPLIST_FILE = NO; INFOPLIST_FILE = OpenHost/Info.plist; IPHONEOS_DEPLOYMENT_TARGET = 15.1; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks"; PRODUCT_BUNDLE_IDENTIFIER = com.fleet.e2e.openhost; PRODUCT_NAME = OpenHost; SDKROOT = iphonesimulator; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = 1; }; name = Debug; };
    A10000000000000000000050 /* Build configuration list for PBXNativeTarget "OpenAlertTests" */ = { isa = XCConfigurationList; buildConfigurations = (A10000000000000000000051); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
    A10000000000000000000051 /* Debug */ = { isa = XCBuildConfiguration; buildSettings = { CODE_SIGNING_ALLOWED = NO; GENERATE_INFOPLIST_FILE = NO; INFOPLIST_FILE = OpenAlertTests/Info.plist; IPHONEOS_DEPLOYMENT_TARGET = 15.1; PRODUCT_BUNDLE_IDENTIFIER = com.fleet.e2e.openhost.tests; PRODUCT_NAME = OpenAlertTests; SDKROOT = iphonesimulator; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = 1; TEST_TARGET_NAME = OpenHost; }; name = Debug; };
  };
  rootObject = A10000000000000000000001;
}
`;
writeFileSync(path.join(root, 'OpenAlert.xcodeproj', 'project.pbxproj'), pbx);
writeFileSync(path.join(root, 'OpenAlert.xcodeproj', 'xcshareddata', 'xcschemes', 'OpenHost.xcscheme'), `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000020" BuildableName="OpenHost.app" BlueprintName="OpenHost" ReferencedContainer="container:OpenAlert.xcodeproj"/>
      </BuildActionEntry>
      <BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000030" BuildableName="OpenAlertTests.xctest" BlueprintName="OpenAlertTests" ReferencedContainer="container:OpenAlert.xcodeproj"/>
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
    <Testables>
      <TestableReference skipped="NO">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000030" BuildableName="OpenAlertTests.xctest" BlueprintName="OpenAlertTests" ReferencedContainer="container:OpenAlert.xcodeproj"/>
      </TestableReference>
    </Testables>
  </TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES">
    <BuildableProductRunnable runnableDebuggingMode="0">
      <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000020" BuildableName="OpenHost.app" BlueprintName="OpenHost" ReferencedContainer="container:OpenAlert.xcodeproj"/>
    </BuildableProductRunnable>
  </LaunchAction>
  <ProfileAction buildConfiguration="Debug" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><MacroExpansion><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="A10000000000000000000020" BuildableName="OpenHost.app" BlueprintName="OpenHost" ReferencedContainer="container:OpenAlert.xcodeproj"/></MacroExpansion></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Debug" revealArchiveInOrganizer="YES"/>
</Scheme>
`);

const result = spawnSync('xcodebuild', [
  'test', '-project', path.join(root, 'OpenAlert.xcodeproj'), '-scheme', 'OpenHost',
  '-destination', `id=${udid}`, '-derivedDataPath', path.join(scratch, 'ios-open-dd'),
  'CODE_SIGNING_ALLOWED=NO',
], { stdio: 'inherit' });
process.exit(result.status ?? 1);
