import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * What a provider's own harness can reach beyond T3 Code: MCP servers
 * (claude.ai connectors and configured servers), skills, and plugins. T3 Code
 * stores none of it; listing reads the provider's config and toggles write it
 * back, so a change here is the change the provider's CLI would make.
 */
export const ProviderConnectorSource = Schema.Literals([
  "claudeai",
  "user",
  "project",
  "local",
  "plugin",
  "managed",
  "other",
]);
export type ProviderConnectorSource = typeof ProviderConnectorSource.Type;

/**
 * `disabled` is a server the user switched off. `unknown` is one that is on
 * but has not been connected since, either because only its config could be
 * read or because it was just switched back on.
 */
export const ProviderConnectorStatus = Schema.Literals([
  "connected",
  "needs-auth",
  "failed",
  "pending",
  "disabled",
  "unknown",
]);
export type ProviderConnectorStatus = typeof ProviderConnectorStatus.Type;

export const ProviderConnector = Schema.Struct({
  /** The provider's exact server name; toggles address it by this. */
  name: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  source: ProviderConnectorSource,
  /** `stdio`, `http`, `sse`, or `claudeai-proxy`. */
  transport: Schema.optional(TrimmedNonEmptyString),
  /** Host of a remote server's URL. The full URL can carry credentials, so it stays on the server. */
  host: Schema.optional(TrimmedNonEmptyString),
  /** Host of the website the server reports for itself. */
  websiteHost: Schema.optional(TrimmedNonEmptyString),
  /** An `https:` icon the server reports for itself. */
  iconUrl: Schema.optional(TrimmedNonEmptyString),
  /** The plugin that ships this server. */
  pluginName: Schema.optional(TrimmedNonEmptyString),
  status: ProviderConnectorStatus,
  error: Schema.optional(TrimmedNonEmptyString),
  toolCount: Schema.optional(NonNegativeInt),
  enabled: Schema.Boolean,
});
export type ProviderConnector = typeof ProviderConnector.Type;

export const ProviderExtensionSkillSource = Schema.Literals(["personal", "project", "plugin"]);
export type ProviderExtensionSkillSource = typeof ProviderExtensionSkillSource.Type;

export const ProviderExtensionSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  source: ProviderExtensionSkillSource,
  pluginName: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  /** Plugin skills follow their plugin and cannot be switched one by one. */
  togglable: Schema.Boolean,
});
export type ProviderExtensionSkill = typeof ProviderExtensionSkill.Type;

export const ProviderExtensionPlugin = Schema.Struct({
  /** Provider-native id, `name@marketplace`. */
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  marketplace: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
  /** Install scope (`user`, `project`, `local`, or `synced` from the account); toggles write back to it. */
  scope: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  /** False for plugins the provider account manages. */
  removable: Schema.Boolean,
  togglable: Schema.Boolean,
  /** GitHub owner of the plugin's marketplace or repository, for its avatar. */
  githubOwner: Schema.optional(TrimmedNonEmptyString),
  homepageHost: Schema.optional(TrimmedNonEmptyString),
  author: Schema.optional(TrimmedNonEmptyString),
  mcpServerCount: Schema.optional(NonNegativeInt),
});
export type ProviderExtensionPlugin = typeof ProviderExtensionPlugin.Type;

export const ProviderExtensionsSnapshot = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  connectors: Schema.Array(ProviderConnector),
  /** False when the servers could not be started and only their config was read. */
  connectorsLive: Schema.Boolean,
  connectorsError: Schema.optional(TrimmedNonEmptyString),
  /** Where the provider account's own connectors are added and removed. */
  manageConnectorsUrl: Schema.optional(TrimmedNonEmptyString),
  skills: Schema.Array(ProviderExtensionSkill),
  plugins: Schema.Array(ProviderExtensionPlugin),
  pluginsError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderExtensionsSnapshot = typeof ProviderExtensionsSnapshot.Type;

export const ProviderExtensionsListInput = Schema.Struct({
  /** Bypass the server's cached listing and start every server again. */
  refresh: Schema.optional(Schema.Boolean),
});
export type ProviderExtensionsListInput = typeof ProviderExtensionsListInput.Type;

export const ProviderExtensionsListResult = Schema.Struct({
  instances: Schema.Array(ProviderExtensionsSnapshot),
});
export type ProviderExtensionsListResult = typeof ProviderExtensionsListResult.Type;

export const ProviderConnectorSetEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type ProviderConnectorSetEnabledInput = typeof ProviderConnectorSetEnabledInput.Type;

export const ProviderSkillSetEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type ProviderSkillSetEnabledInput = typeof ProviderSkillSetEnabledInput.Type;

export const ProviderPluginSetEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  pluginId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  scope: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderPluginSetEnabledInput = typeof ProviderPluginSetEnabledInput.Type;

export const ProviderPluginUninstallInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  pluginId: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderPluginUninstallInput = typeof ProviderPluginUninstallInput.Type;

export class ProviderExtensionsError extends Schema.TaggedError<ProviderExtensionsError>()(
  "ProviderExtensionsError",
  {
    instanceId: ProviderInstanceId,
    operation: Schema.Literals([
      "set-connector-enabled",
      "set-skill-enabled",
      "set-plugin-enabled",
      "uninstall-plugin",
    ]),
    reason: Schema.Literals(["instance-not-found", "unsupported", "provider-failed"]),
    /** The provider's own one-line explanation, or why its settings file could not be changed. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "provider-failed" && this.detail) return this.detail;
    switch (this.reason) {
      case "instance-not-found":
        return "Provider instance not found.";
      case "unsupported":
        return "This provider has no connectors, skills or plugins to manage.";
      case "provider-failed":
        return "The provider could not apply the change.";
    }
  }
}
