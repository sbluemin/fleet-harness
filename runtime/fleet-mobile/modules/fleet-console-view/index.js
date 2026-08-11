const { createRunOncePlugin, withAndroidManifest, withAppBuildGradle } = require("expo/config-plugins");

const packageJson = require("./package.json");

function withFleetConsoleView(config) {
  // FleetLinkActivity owns fleet://join. Removing Expo's broad scheme keeps the credential away from MainActivity.
  delete config.scheme;
  config = withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    const application = manifest.application?.[0];
    if (application) {
      application.$["android:usesCleartextTraffic"] = "false";
      application.$["tools:replace"] = "android:usesCleartextTraffic";
      const mainActivity = application.activity?.find((activity) =>
        activity.$?.["android:name"] === ".MainActivity" || activity.$?.["android:name"]?.endsWith(".MainActivity"),
      );
      if (mainActivity) {
        mainActivity["intent-filter"] = (mainActivity["intent-filter"] ?? []).filter((filter) =>
          !(filter.action ?? []).some((action) => action.$?.["android:name"] === "android.intent.action.VIEW"),
        );
      }
    }
    return result;
  });
  return withAppBuildGradle(config, (result) => {
    if (!result.modResults.contents.includes("fleet_mobile_release_requires_signing")) {
      result.modResults.contents += `

// Fleet Mobile currently supports debug signing only. Never let a release APK inherit it.
afterEvaluate {
    def forbidUnsignedFleetRelease = tasks.register("forbidUnsignedFleetRelease") {
        doLast { throw new GradleException("fleet_mobile_release_requires_signing") }
    }
    tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" }.configureEach {
        dependsOn(forbidUnsignedFleetRelease)
    }
}
`;
    }
    return result;
  });
}

module.exports = createRunOncePlugin(withFleetConsoleView, packageJson.name, packageJson.version);
