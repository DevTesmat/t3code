import type { DesktopAppBranding, DesktopAppStageLabel } from "@t3tools/contracts";

import { isNightlyDesktopVersion } from "./updateChannels.ts";

const APP_BASE_NAME = "T3 Code";
const DESKTOP_APP_VARIANT =
  process.env.T3CODE_DESKTOP_APP_VARIANT === "local" ? "local" : "official";

export function resolveDesktopAppStageLabel(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppStageLabel {
  if (input.isDevelopment) {
    return "Dev";
  }

  if (DESKTOP_APP_VARIANT === "local") {
    return "Local";
  }

  return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Alpha";
}

export function resolveDesktopAppBranding(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppBranding {
  const stageLabel = resolveDesktopAppStageLabel(input);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName: `${APP_BASE_NAME} (${stageLabel})`,
  };
}
