/**
 * This fork installs beside upstream T3 Code instead of replacing it: its own
 * name, bundle id, data directory, and Chromium profile, so both apps can run
 * at once without sharing a database, a login profile, or an update feed.
 * The packaging script reads the same values (scripts/build-desktop-artifact.ts).
 */
export const FORK_STAGE_LABEL = "Kevin";
export const FORK_APP_ID = "com.kevin.t3code";
export const FORK_PRODUCT_NAME = `T3 Code (${FORK_STAGE_LABEL})`;
/** Server state (projects, threads, settings), under the home directory. */
export const FORK_HOME_DIR_NAME = ".t3-kevin";
/** Electron profile (cookies, local storage), under Application Support. */
export const FORK_USER_DATA_DIR_NAME = "t3code-kevin";
