import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { api } from "./api";

const OAUTH_RETURN = "heyflare://oauth-complete";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export function oauthReturnUrl() {
  return OAUTH_RETURN;
}

export function defaultServerUrl(): string | null {
  const extra = Constants.expoConfig?.extra as { defaultServer?: string } | undefined;
  const v = extra?.defaultServer?.trim();
  return v || null;
}

/** Request permission, get Expo push token, register with Worker. No-op in Expo Go / simulators without push. */
export async function registerForPush(): Promise<{ ok: boolean; reason?: string }> {
  if (!Device.isDevice) return { ok: false, reason: "simulator" };

  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    status = req.status;
  }
  if (status !== "granted") return { ok: false, reason: "denied" };

  const projectId =
    Constants.easConfig?.projectId ??
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  if (!projectId || projectId.startsWith("REPLACE_")) {
    return { ok: false, reason: "missing_eas_project" };
  }

  try {
    const token = (
      await Notifications.getExpoPushTokenAsync({
        projectId,
      })
    ).data;
    await api.post("/api/push/devices", {
      token,
      platform: Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "unknown",
      device_name: Device.deviceName ?? null,
    });
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("mail", {
        name: "Mail",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function unregisterPush(): Promise<void> {
  try {
    const projectId =
      Constants.easConfig?.projectId ??
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId || projectId.startsWith("REPLACE_")) return;
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api.delete("/api/push/devices", { token });
  } catch {
    /* ignore */
  }
}

export function notificationPath(data: Record<string, unknown> | undefined): string | null {
  const url = data?.url;
  return typeof url === "string" && url.startsWith("/") ? url : null;
}
