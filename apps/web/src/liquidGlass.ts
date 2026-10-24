/**
 * "native": the macOS desktop window paints its sidebar vibrancy behind the
 * page (apps/desktop/src/window/LiquidGlass.ts), so the page clears its
 * backgrounds there. "tinted": no native material, so the sidebar fakes the
 * glass with a translucent tint over a soft ambient gradient.
 */
export type LiquidGlassMode = "native" | "tinted";

export function resolveLiquidGlassMode(input: {
  readonly enabled: boolean;
  readonly reducedTransparency: boolean;
  readonly desktopPlatform: string | null;
}): LiquidGlassMode | null {
  if (!input.enabled || input.reducedTransparency) return null;
  return input.desktopPlatform === "darwin" ? "native" : "tinted";
}

export function applyLiquidGlassMode(root: HTMLElement, mode: LiquidGlassMode | null): void {
  if (mode === null) {
    delete root.dataset.liquidGlass;
  } else {
    root.dataset.liquidGlass = mode;
  }
}

const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

export function subscribeToReducedTransparency(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(REDUCED_TRANSPARENCY_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function readReducedTransparency(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches;
}
