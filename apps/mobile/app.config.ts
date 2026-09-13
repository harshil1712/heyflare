import type { ConfigContext, ExpoConfig } from "expo/config";

const DEFAULT_SERVER = process.env.EXPO_PUBLIC_DEFAULT_SERVER?.replace(/\/$/, "") || "";
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID || "";
const projectIdReady = Boolean(EAS_PROJECT_ID) && !EAS_PROJECT_ID.startsWith("REPLACE_");

export default ({ config }: ConfigContext): ExpoConfig => {
  const cfg: ExpoConfig = {
    ...config,
    name: "heyflare",
    slug: "heyflare",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "heyflare",
    userInterfaceStyle: "automatic",
    ios: {
      supportsTablet: true,
      bundleIdentifier: "app.heyflare.mobile",
      buildNumber: "1",
      icon: "./assets/expo.icon",
      infoPlist: {
        CFBundleDisplayName: "heyflare",
        ITSAppUsesNonExemptEncryption: false,
        NSFaceIDUsageDescription: "heyflare can use Face ID to unlock your saved session on this device.",
        UIBackgroundModes: ["remote-notification"],
      },
    },
    android: {
      package: "app.heyflare.mobile",
      versionCode: 1,
      adaptiveIcon: {
        backgroundColor: "#111111",
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundImage: "./assets/images/android-icon-background.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
      permissions: ["RECEIVE_BOOT_COMPLETED", "VIBRATE", "POST_NOTIFICATIONS"],
      intentFilters: [
        {
          action: "VIEW",
          autoVerify: true,
          data: [{ scheme: "heyflare", host: "oauth-complete" }],
          category: ["BROWSABLE", "DEFAULT"],
        },
      ],
    },
    web: {
      output: "static",
      favicon: "./assets/images/favicon.png",
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      [
        "expo-splash-screen",
        {
          backgroundColor: "#111111",
          image: "./assets/images/splash-icon.png",
          imageWidth: 76,
        },
      ],
      [
        "expo-notifications",
        {
          color: "#111111",
          defaultChannel: "mail",
        },
      ],
      "expo-font",
    ],
    experiments: {
      typedRoutes: false,
      reactCompiler: true,
    },
    runtimeVersion: {
      policy: "appVersion",
    },
    extra: {
      defaultServer: DEFAULT_SERVER,
      eas: {
        projectId: projectIdReady ? EAS_PROJECT_ID : undefined,
      },
      router: {},
    },
    owner: process.env.EAS_OWNER || undefined,
  };

  if (DEFAULT_SERVER) {
    const host = DEFAULT_SERVER.replace(/^https?:\/\//, "").split("/")[0];
    cfg.ios = { ...cfg.ios, associatedDomains: [`applinks:${host}`] };
  }

  if (projectIdReady) {
    cfg.updates = {
      url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
      fallbackToCacheTimeout: 0,
    };
    cfg.extra = {
      ...cfg.extra,
      eas: { projectId: EAS_PROJECT_ID },
    };
  }

  return cfg;
};
