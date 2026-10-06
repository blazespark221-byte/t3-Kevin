import {
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_CLIENT_SETTINGS,
  FILL_PREVIEW_VIEWPORT,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";

import { addBrowserSurface } from "./addBrowserSurface";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: `2026-06-18T19:00:0${tabId.at(-1) ?? "0"}.000Z`,
});

beforeEach(() => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
});

describe("addBrowserSurface", () => {
  it("opens under the requested profile", async () => {
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-1")),
    );

    await addBrowserSurface({
      threadRef,
      openPreview: ({ input }) => openPreview(input),
      profileId: "profile-work",
    });

    expect(openPreview).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: "profile-work",
    });
  });

  it("creates another preview session when a browser tab is already active", async () => {
    const first = snapshot("tab-1");
    const second = snapshot("tab-2");
    applyPreviewServerSnapshot(threadRef, first);
    useRightPanelStore.getState().openBrowser(threadRef, first.tabId);
    const openPreview = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(second));

    await addBrowserSurface({ threadRef, openPreview: ({ input }) => openPreview(input) });

    expect(openPreview).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
    expect(Object.keys(readThreadPreviewState(threadRef).sessions)).toEqual(["tab-1", "tab-2"]);
    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      ).surfaces.map((surface) => surface.id),
    ).toEqual(["browser:tab-1", "browser:tab-2"]);
  });

  it("opens dots in its own tab without navigating an existing browser tab", async () => {
    const first = snapshot("tab-1");
    applyPreviewServerSnapshot(threadRef, first);
    useRightPanelStore.getState().openBrowser(threadRef, first.tabId);
    const openPreview = vi.fn(async (_input: PreviewOpenInput) =>
      AsyncResult.success(snapshot("tab-2")),
    );

    await addBrowserSurface({
      threadRef,
      openPreview: ({ input }) => openPreview(input),
      url: "https://chatgpt.com/dots",
    });

    expect(openPreview).toHaveBeenCalledExactlyOnceWith({
      threadId: "thread-1",
      url: "https://chatgpt.com/dots",
      viewport: FILL_PREVIEW_VIEWPORT,
      profileId: DEFAULT_BROWSER_PROFILE_ID,
    });
    expect(readThreadPreviewState(threadRef).sessions["tab-1"]).toEqual(first);
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(panel.surfaces.map((surface) => surface.id)).toEqual(["browser:tab-1", "browser:tab-2"]);
    expect(panel.activeSurfaceId).toBe("browser:tab-2");
  });

  it("leaves the active panel unchanged when opening dots fails", async () => {
    const first = snapshot("tab-1");
    applyPreviewServerSnapshot(threadRef, first);
    useRightPanelStore.getState().openBrowser(threadRef, first.tabId);
    const before = useRightPanelStore.getState();
    const failure = new Error("Browser unavailable");

    const result = await addBrowserSurface({
      threadRef,
      openPreview: async () => AsyncResult.failure(Cause.fail(failure)),
      url: "https://chatgpt.com/dots",
    });

    expect(result._tag).toBe("Failure");
    expect(useRightPanelStore.getState()).toBe(before);
    expect(Object.keys(readThreadPreviewState(threadRef).sessions)).toEqual(["tab-1"]);
  });
});
