import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type * as Electron from "electron";

// The web layer makes everything behind the sidebar transparent while this
// material is on (apps/web/src/liquidGlass.ts decides "native" from the same
// platform check), so keep the two in step.
const LIQUID_GLASS_VIBRANCY = "sidebar";
// Vibrancy only shows through a fully transparent window background.
const TRANSPARENT_BACKGROUND = "#00000000";

type LiquidGlassWindowOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "backgroundColor" | "vibrancy" | "visualEffectState"
>;

export function opaqueWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

export function isLiquidGlassEnabled(settings: Option.Option<ClientSettings>): boolean {
  return Option.match(settings, {
    onNone: () => DEFAULT_CLIENT_SETTINGS.liquidGlassEnabled,
    onSome: (value) => value.liquidGlassEnabled,
  });
}

function usesNativeLiquidGlass(platform: NodeJS.Platform, enabled: boolean): boolean {
  return enabled && platform === "darwin";
}

export function resolveLiquidGlassWindowOptions(input: {
  readonly platform: NodeJS.Platform;
  readonly enabled: boolean;
  readonly opaqueBackgroundColor: string;
}): LiquidGlassWindowOptions {
  if (!usesNativeLiquidGlass(input.platform, input.enabled)) {
    return { backgroundColor: input.opaqueBackgroundColor };
  }
  return {
    backgroundColor: TRANSPARENT_BACKGROUND,
    vibrancy: LIQUID_GLASS_VIBRANCY,
    // Inactive windows fall back to the flat material, like native sidebars.
    visualEffectState: "followWindow",
  };
}

export function resolveLiquidGlassBackgroundColor(input: {
  readonly platform: NodeJS.Platform;
  readonly enabled: boolean;
  readonly opaqueBackgroundColor: string;
}): string {
  return usesNativeLiquidGlass(input.platform, input.enabled)
    ? TRANSPARENT_BACKGROUND
    : input.opaqueBackgroundColor;
}

/** Switches the material on an open window, so the setting applies without a relaunch. */
export function applyLiquidGlass(
  window: Pick<Electron.BrowserWindow, "isDestroyed" | "setBackgroundColor" | "setVibrancy">,
  input: {
    readonly platform: NodeJS.Platform;
    readonly enabled: boolean;
    readonly opaqueBackgroundColor: string;
  },
): void {
  if (window.isDestroyed() || input.platform !== "darwin") return;
  window.setVibrancy(input.enabled ? LIQUID_GLASS_VIBRANCY : null);
  window.setBackgroundColor(resolveLiquidGlassBackgroundColor(input));
}
