const { createRunOncePlugin, withAndroidManifest } = require("expo/config-plugins");

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
  // Release signing policy belongs to the app-level plugin (plugins/withFleetAndroid.ts), which owns
  // signingConfigs and refuses a release without the keystore environment. This module stays a
  // native-module plugin.
  return config;
}

module.exports = createRunOncePlugin(withFleetConsoleView, packageJson.name, packageJson.version);
