import { describe, expect, it } from "vite-plus/test";

import { resolveLiquidGlassMode } from "./liquidGlass";

describe("resolveLiquidGlassMode", () => {
  it("uses the native material only inside the macOS desktop app", () => {
    expect(
      resolveLiquidGlassMode({
        enabled: true,
        reducedTransparency: false,
        desktopPlatform: "darwin",
      }),
    ).toBe("native");
    expect(
      resolveLiquidGlassMode({
        enabled: true,
        reducedTransparency: false,
        desktopPlatform: "win32",
      }),
    ).toBe("tinted");
    expect(
      resolveLiquidGlassMode({ enabled: true, reducedTransparency: false, desktopPlatform: null }),
    ).toBe("tinted");
  });

  it("turns off when the setting is off or the system asks for less transparency", () => {
    expect(
      resolveLiquidGlassMode({
        enabled: false,
        reducedTransparency: false,
        desktopPlatform: "darwin",
      }),
    ).toBeNull();
    expect(
      resolveLiquidGlassMode({
        enabled: true,
        reducedTransparency: true,
        desktopPlatform: "darwin",
      }),
    ).toBeNull();
  });
});
