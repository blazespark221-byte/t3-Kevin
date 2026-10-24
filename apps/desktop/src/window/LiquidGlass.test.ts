import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  applyLiquidGlass,
  isLiquidGlassEnabled,
  resolveLiquidGlassWindowOptions,
} from "./LiquidGlass.ts";

function fakeWindow() {
  const calls: Array<{ vibrancy?: string | null; backgroundColor?: string }> = [];
  return {
    calls,
    window: {
      isDestroyed: () => false,
      setVibrancy: (vibrancy: string | null) => {
        calls.push({ vibrancy });
      },
      setBackgroundColor: (backgroundColor: string) => {
        calls.push({ backgroundColor });
      },
    },
  };
}

describe("LiquidGlass", () => {
  it("defaults on when no client settings were saved", () => {
    expect(isLiquidGlassEnabled(Option.none())).toBe(true);
    expect(
      isLiquidGlassEnabled(Option.some({ ...DEFAULT_CLIENT_SETTINGS, liquidGlassEnabled: false })),
    ).toBe(false);
  });

  it("opens a transparent vibrant window only on macOS with the setting on", () => {
    expect(
      resolveLiquidGlassWindowOptions({
        platform: "darwin",
        enabled: true,
        opaqueBackgroundColor: "#ffffff",
      }),
    ).toEqual({
      backgroundColor: "#00000000",
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
    });
    expect(
      resolveLiquidGlassWindowOptions({
        platform: "darwin",
        enabled: false,
        opaqueBackgroundColor: "#ffffff",
      }),
    ).toEqual({ backgroundColor: "#ffffff" });
    expect(
      resolveLiquidGlassWindowOptions({
        platform: "win32",
        enabled: true,
        opaqueBackgroundColor: "#0a0a0a",
      }),
    ).toEqual({ backgroundColor: "#0a0a0a" });
  });

  it("switches an open macOS window both ways and leaves other platforms alone", () => {
    const off = fakeWindow();
    applyLiquidGlass(off.window, {
      platform: "darwin",
      enabled: false,
      opaqueBackgroundColor: "#0a0a0a",
    });
    expect(off.calls).toEqual([{ vibrancy: null }, { backgroundColor: "#0a0a0a" }]);

    const on = fakeWindow();
    applyLiquidGlass(on.window, {
      platform: "darwin",
      enabled: true,
      opaqueBackgroundColor: "#0a0a0a",
    });
    expect(on.calls).toEqual([{ vibrancy: "sidebar" }, { backgroundColor: "#00000000" }]);

    const linux = fakeWindow();
    applyLiquidGlass(linux.window, {
      platform: "linux",
      enabled: true,
      opaqueBackgroundColor: "#0a0a0a",
    });
    expect(linux.calls).toEqual([]);
  });
});
