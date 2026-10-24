/**
 * Claude Code's MCP servers, skills and plugins, the way `/mcp`, `/skills` and
 * `/plugin` see them. Switches write the user's own `settings.json` or run
 * `claude plugin`, so Claude Code outside T3 Code follows the same switches.
 *
 * @module provider/ClaudeExtensions
 */
import type {
  ClaudeSettings,
  ProviderConnector,
  ProviderConnectorSource,
  ProviderConnectorStatus,
  ProviderExtensionPlugin,
  ProviderExtensionSkill,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderExtensionsListing } from "@t3tools/provider-core/server/driver";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveClaudeSdkExecutablePath } from "./Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "./Drivers/ClaudeSkills.ts";

/** Where claude.ai connectors are added and removed. */
const CLAUDE_CONNECTORS_MANAGE_URL = "https://claude.ai/settings/connectors";
const CLAUDE_AI_CONNECTOR_PREFIX = "claude.ai ";
const PLUGIN_SERVER_PREFIX = "plugin:";
const SYNCED_PLUGIN_SCOPE = "synced";

// Starting every configured server takes a few seconds; one that is still
// connecting after this is reported as pending rather than holding the page.
const MCP_STATUS_SETTLE_MS = 15_000;
const MCP_STATUS_POLL_INTERVAL_MS = 500;
const MCP_STATUS_INIT_TIMEOUT_MS = 25_000;

export class ClaudeUserSettingsError extends Schema.TaggedError<ClaudeUserSettingsError>()(
  "ClaudeUserSettingsError",
  {
    path: Schema.String,
    reason: Schema.Literals(["unreadable", "not-strict-json", "unexpected-shape", "write-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unreadable":
        return `Could not read ${this.path}.`;
      case "not-strict-json":
        // Claude Code tolerates comments and trailing commas; rewriting the
        // file would silently drop them, so it is left for the user to edit.
        return `${this.path} has comments or trailing commas. Edit it by hand, or remove them so T3 Code can update it.`;
      case "unexpected-shape":
        return `${this.path} has a setting in a shape T3 Code does not recognise, so it was left unchanged.`;
      case "write-failed":
        return `Could not write ${this.path}.`;
    }
  }
}

type JsonObject = Record<string, unknown>;

const decodeStrictJsonObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** A missing or empty file is no settings; `null` means the text is not one strict JSON object. */
export function parseClaudeUserSettings(text: string | undefined): JsonObject | null {
  if (text === undefined || text.trim() === "") return {};
  return Option.getOrNull(decodeStrictJsonObject(text));
}

function formatClaudeUserSettings(settings: JsonObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Names the user denied with a plain `{ "serverName": … }` entry, the only kind T3 Code writes. */
export function deniedMcpServerNames(settings: JsonObject | null): ReadonlySet<string> {
  const entries = settings?.deniedMcpServers;
  if (!Array.isArray(entries)) return new Set();
  return new Set(
    entries.flatMap((entry) =>
      isJsonObject(entry) && typeof entry.serverName === "string" ? [entry.serverName] : [],
    ),
  );
}

/**
 * `deniedMcpServers` merges across every settings source and removes the
 * server everywhere, claude.ai connectors and plugin servers included, which
 * makes it the one switch that holds outside a single project.
 */
export function withMcpServerDenied(
  settings: JsonObject,
  name: string,
  denied: boolean,
): JsonObject | null {
  const current = settings.deniedMcpServers;
  if (current !== undefined && !Array.isArray(current)) return null;
  const others = (current ?? []).filter(
    (entry) => !(isJsonObject(entry) && entry.serverName === name),
  );
  const next = denied ? [...others, { serverName: name }] : others;
  const { deniedMcpServers: _previous, ...rest } = settings;
  return next.length > 0 ? { ...rest, deniedMcpServers: next } : rest;
}

/** Deleting the override rather than writing "on" leaves the skill's own default in charge. */
export function withSkillDisabled(
  settings: JsonObject,
  name: string,
  disabled: boolean,
): JsonObject | null {
  const current = settings.skillOverrides;
  if (current !== undefined && !isJsonObject(current)) return null;
  const { [name]: _previous, ...others } = current ?? {};
  const next = disabled ? { ...others, [name]: "off" } : others;
  const { skillOverrides: _overrides, ...rest } = settings;
  return Object.keys(next).length > 0 ? { ...rest, skillOverrides: next } : rest;
}

const readOptionalFile = Effect.fn("ClaudeExtensions.readOptionalFile")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(filePath).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
  );
  return Option.getOrUndefined(text);
});

const readClaudeUserSettings = Effect.fn("ClaudeExtensions.readUserSettings")(function* (
  settingsPath: string,
) {
  const text = yield* readOptionalFile(settingsPath).pipe(Effect.orElseSucceed(() => undefined));
  return parseClaudeUserSettings(text);
});

/**
 * Changes one key and writes the file back whole. Strict JSON only: Claude
 * Code's comments and trailing commas would not survive the rewrite.
 */
const updateClaudeUserSettings = Effect.fn("ClaudeExtensions.updateUserSettings")(function* (
  settingsPath: string,
  update: (settings: JsonObject) => JsonObject | null,
) {
  const text = yield* readOptionalFile(settingsPath).pipe(
    Effect.mapError(
      (cause) => new ClaudeUserSettingsError({ path: settingsPath, reason: "unreadable", cause }),
    ),
  );
  const current = parseClaudeUserSettings(text);
  if (current === null) {
    return yield* new ClaudeUserSettingsError({ path: settingsPath, reason: "not-strict-json" });
  }
  const next = update(current);
  if (next === null) {
    return yield* new ClaudeUserSettingsError({
      path: settingsPath,
      reason: "unexpected-shape",
    });
  }
  const contents = formatClaudeUserSettings(next);
  if (text !== undefined && contents === formatClaudeUserSettings(current)) return;
  yield* writeFileStringAtomically({ filePath: settingsPath, contents }).pipe(
    Effect.mapError(
      (cause) => new ClaudeUserSettingsError({ path: settingsPath, reason: "write-failed", cause }),
    ),
  );
});

// The CLI reports more than the SDK declares (server titles, icons, websites);
// only the fields read here are decoded, and a malformed entry is skipped.
const McpServerStatusEntry = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  scope: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  config: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
    }),
  ),
  serverInfo: Schema.optional(
    Schema.Struct({
      websiteUrl: Schema.optional(Schema.String),
      icons: Schema.optional(Schema.Array(Schema.Struct({ src: Schema.String }))),
    }),
  ),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
});
type McpServerStatusEntry = typeof McpServerStatusEntry.Type;
const decodeMcpServerStatusEntry = Schema.decodeUnknownOption(McpServerStatusEntry);

const CONNECTOR_STATUSES = new Set<ProviderConnectorStatus>([
  "connected",
  "needs-auth",
  "failed",
  "pending",
  "disabled",
]);

function urlHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.hostname || undefined
      : undefined;
  } catch {
    return undefined;
  }
}

function httpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function pluginNameOfServer(name: string): string | undefined {
  if (!name.startsWith(PLUGIN_SERVER_PREFIX)) return undefined;
  const plugin = name.slice(PLUGIN_SERVER_PREFIX.length).split(":")[0]?.trim();
  return plugin || undefined;
}

function connectorDisplayName(name: string): string {
  if (name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX)) {
    return name.slice(CLAUDE_AI_CONNECTOR_PREFIX.length).trim() || name;
  }
  if (name.startsWith(PLUGIN_SERVER_PREFIX)) {
    const parts = name.slice(PLUGIN_SERVER_PREFIX.length).split(":");
    return parts.slice(1).join(":").trim() || name;
  }
  return name;
}

function connectorSource(input: {
  readonly name: string;
  readonly scope?: string | undefined;
  readonly source?: string | undefined;
}): ProviderConnectorSource {
  if (input.name.startsWith(PLUGIN_SERVER_PREFIX) || input.source === "plugin") return "plugin";
  switch (input.source ?? input.scope) {
    case "claudeai":
      return "claudeai";
    case "user":
      return "user";
    case "project":
      return "project";
    case "local":
      return "local";
    case "managed":
    case "enterprise":
      return "managed";
  }
  return input.name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX) ? "claudeai" : "other";
}

function connectorFromStatus(entry: McpServerStatusEntry): ProviderConnector {
  const status = CONNECTOR_STATUSES.has(entry.status as ProviderConnectorStatus)
    ? (entry.status as ProviderConnectorStatus)
    : "unknown";
  const transport = entry.config?.type?.trim();
  const host = urlHost(entry.config?.url);
  const websiteHost = urlHost(entry.serverInfo?.websiteUrl);
  const iconUrl = entry.serverInfo?.icons
    ?.map((icon) => httpsUrl(icon.src))
    .find((src) => src !== undefined);
  const pluginName = pluginNameOfServer(entry.name);
  const error = entry.error?.trim().slice(0, 300);
  return {
    name: entry.name,
    displayName: connectorDisplayName(entry.name),
    source: connectorSource(entry),
    status,
    enabled: status !== "disabled",
    ...(transport ? { transport } : {}),
    ...(host ? { host } : {}),
    ...(websiteHost ? { websiteHost } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(pluginName ? { pluginName } : {}),
    ...(error ? { error } : {}),
    ...(entry.tools && status === "connected" ? { toolCount: entry.tools.length } : {}),
  };
}

function deniedConnector(
  name: string,
  configured: ReadonlyMap<string, ProviderConnector>,
): ProviderConnector {
  const known = configured.get(name);
  return {
    ...(known ?? {
      name,
      displayName: connectorDisplayName(name),
      source: connectorSource({ name }),
    }),
    status: "disabled",
    enabled: false,
  };
}

function sortConnectors(connectors: Iterable<ProviderConnector>): ProviderConnector[] {
  return [...connectors].toSorted((left, right) =>
    left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }),
  );
}

/**
 * A denied server is gone from the CLI's own list, so it is added back from
 * the denylist; otherwise switching one off would be a one-way door.
 */
export function claudeConnectorsFromStatuses(
  statuses: ReadonlyArray<unknown>,
  denied: ReadonlySet<string>,
  configured: ReadonlyMap<string, ProviderConnector> = new Map(),
): ProviderConnector[] {
  const connectors = new Map<string, ProviderConnector>();
  for (const raw of statuses) {
    const entry = Option.getOrUndefined(decodeMcpServerStatusEntry(raw));
    if (entry === undefined || connectors.has(entry.name)) continue;
    connectors.set(
      entry.name,
      denied.has(entry.name) ? deniedConnector(entry.name, configured) : connectorFromStatus(entry),
    );
  }
  for (const name of denied) {
    if (!connectors.has(name)) connectors.set(name, deniedConnector(name, configured));
  }
  return sortConnectors(connectors.values());
}

const ConfiguredServer = Schema.Struct({
  type: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
});
const decodeConfiguredServer = Schema.decodeUnknownOption(ConfiguredServer);
const ClaudeGlobalConfig = Schema.Struct({
  claudeAiMcpEverConnected: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  mcpServers: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});
const decodeClaudeGlobalConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeGlobalConfig),
);

/**
 * What Claude Code's global config names without starting anything: user MCP
 * servers and the claude.ai connectors this account has ever connected.
 */
export function configuredClaudeConnectors(
  configText: string | undefined,
): Map<string, ProviderConnector> {
  const connectors = new Map<string, ProviderConnector>();
  const config = configText === undefined ? undefined : decodeClaudeGlobalConfig(configText);
  if (config === undefined || Option.isNone(config)) return connectors;
  for (const name of config.value.claudeAiMcpEverConnected ?? []) {
    if (!name.trim()) continue;
    connectors.set(name, {
      name,
      displayName: connectorDisplayName(name),
      source: "claudeai",
      transport: "claudeai-proxy",
      status: "unknown",
      enabled: true,
    });
  }
  for (const [name, raw] of Object.entries(config.value.mcpServers ?? {})) {
    if (!name.trim()) continue;
    const server = Option.getOrUndefined(decodeConfiguredServer(raw));
    const transport = server?.type?.trim() || (server?.command ? "stdio" : undefined);
    const host = urlHost(server?.url);
    connectors.set(name, {
      name,
      displayName: name,
      source: "user",
      status: "unknown",
      enabled: true,
      ...(transport ? { transport } : {}),
      ...(host ? { host } : {}),
    });
  }
  return connectors;
}

export function claudeConnectorsFromConfig(
  configured: ReadonlyMap<string, ProviderConnector>,
  denied: ReadonlySet<string>,
): ProviderConnector[] {
  const connectors = new Map(configured);
  for (const name of denied) connectors.set(name, deniedConnector(name, configured));
  return sortConnectors(connectors.values());
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function buildClaudeMcpStatusProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: ["user", "project", "local"],
    // Every server the user configured starts here, exactly as in a session,
    // but SessionStart hooks must not fire each time the settings page loads.
    settings: { disableAllHooks: true },
    allowedTools: [],
    env: {
      ...input.environment,
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    cwd: input.cwd,
    stderr: () => {},
  };
}

/**
 * Starts Claude Code without a prompt (nothing reaches the API), waits for
 * its MCP servers to finish connecting, and reads their status.
 */
const probeClaudeMcpStatuses = (input: {
  readonly settings: Pick<ClaudeSettings, "binaryPath" | "homePath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const environment = yield* makeClaudeEnvironment(input.settings, input.environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      input.settings.binaryPath,
      environment,
    );
    const q = claudeQuery({
      // oxlint-disable-next-line require-yield -- it only waits, so no prompt reaches the API
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await waitForAbortSignal(abort.signal);
      })(),
      options: buildClaudeMcpStatusProbeQueryOptions({
        executablePath,
        abortController: abort,
        environment,
        cwd: input.cwd,
      }),
    });
    yield* Effect.tryPromise(() => q.initializationResult()).pipe(
      Effect.timeout(MCP_STATUS_INIT_TIMEOUT_MS),
    );
    const readStatuses = Effect.tryPromise(() => q.mcpServerStatus());
    // The SDK announces no "servers settled" moment, so this polls the CLI's
    // own status until nothing is connecting, bounded by the settle window.
    let statuses = yield* readStatuses;
    for (
      let waited = 0;
      waited < MCP_STATUS_SETTLE_MS && statuses.some((status) => status.status === "pending");
      waited += MCP_STATUS_POLL_INTERVAL_MS
    ) {
      yield* Effect.sleep(MCP_STATUS_POLL_INTERVAL_MS);
      statuses = yield* readStatuses;
    }
    return statuses as ReadonlyArray<unknown>;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.tapError((error) =>
      Effect.logWarning("Claude MCP status probe failed.", { errorTag: error._tag }),
    ),
  );
};

export function claudeExtensionSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
): ProviderExtensionSkill[] {
  return skills.map((skill) => {
    const separator = skill.name.indexOf(":");
    const pluginName = separator > 0 ? skill.name.slice(0, separator) : undefined;
    const description = skill.shortDescription ?? skill.description;
    return {
      name: skill.name,
      source: pluginName ? "plugin" : skill.scope === "project" ? "project" : "personal",
      enabled: skill.enabled,
      togglable: pluginName === undefined,
      ...(pluginName ? { pluginName } : {}),
      ...(description ? { description } : {}),
    } satisfies ProviderExtensionSkill;
  });
}

export class ClaudePluginCommandError extends Schema.TaggedError<ClaudePluginCommandError>()(
  "ClaudePluginCommandError",
  {
    operation: Schema.Literals(["list", "uninstall", "enable", "disable"]),
    exitCode: Schema.Number,
    /** Claude Code's own one-line explanation from `--json` output, when it gave one. */
    reason: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason ?? `\`claude plugin ${this.operation}\` exited with code ${this.exitCode}.`;
  }
}

const ClaudePluginListEntry = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.NullOr(Schema.String)),
  scope: Schema.optional(Schema.NullOr(Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  installPath: Schema.optional(Schema.NullOr(Schema.String)),
  // Older CLIs printed a map of servers, newer ones their names.
  mcpServers: Schema.optional(
    Schema.NullOr(
      Schema.Union([Schema.Array(Schema.String), Schema.Record(Schema.String, Schema.Unknown)]),
    ),
  ),
});
const decodeClaudePluginList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ClaudePluginListEntry)),
);

const PluginPerson = Schema.Union([
  Schema.String,
  Schema.Struct({ name: Schema.optional(Schema.String) }),
]);
const PluginLink = Schema.Union([
  Schema.String,
  Schema.Struct({ url: Schema.optional(Schema.String) }),
]);
const ClaudePluginManifest = Schema.Struct({
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  homepage: Schema.optional(Schema.NullOr(PluginLink)),
  repository: Schema.optional(Schema.NullOr(PluginLink)),
  author: Schema.optional(Schema.NullOr(PluginPerson)),
});
type ClaudePluginManifest = typeof ClaudePluginManifest.Type;
const decodeClaudePluginManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudePluginManifest),
);

const KnownMarketplaces = Schema.Record(
  Schema.String,
  Schema.Struct({
    source: Schema.optional(
      Schema.Struct({
        source: Schema.optional(Schema.String),
        repo: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const decodeKnownMarketplaces = Schema.decodeUnknownOption(
  Schema.fromJsonString(KnownMarketplaces),
);

/** The official marketplace lives in the anthropics organisation. */
const MARKETPLACE_OWNER_FALLBACKS: Readonly<Record<string, string>> = {
  "claude-plugins-official": "anthropics",
};

function githubOwnerOfUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.replace(/^git@github\.com:/, "https://github.com/"));
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
    return url.pathname.split("/").find(Boolean);
  } catch {
    return undefined;
  }
}

/** GitHub owner of each marketplace the user added, by marketplace name. */
export function claudeMarketplaceOwners(
  knownMarketplacesText: string | undefined,
): ReadonlyMap<string, string> {
  const owners = new Map(Object.entries(MARKETPLACE_OWNER_FALLBACKS));
  const parsed =
    knownMarketplacesText === undefined
      ? undefined
      : decodeKnownMarketplaces(knownMarketplacesText);
  if (parsed === undefined || Option.isNone(parsed)) return owners;
  for (const [name, marketplace] of Object.entries(parsed.value)) {
    const source = marketplace.source;
    const owner =
      source?.source === "github" && source.repo
        ? source.repo.split("/")[0]?.trim()
        : githubOwnerOfUrl(source?.url);
    if (owner) owners.set(name, owner);
  }
  return owners;
}

function linkUrl(link: ClaudePluginManifest["homepage"]): string | undefined {
  if (!link) return undefined;
  return typeof link === "string" ? link : link.url;
}

function splitPluginId(id: string): { name: string; marketplace?: string } {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id };
}

export function claudeExtensionPlugin(input: {
  readonly entry: typeof ClaudePluginListEntry.Type;
  readonly manifestText: string | undefined;
  readonly marketplaceOwners: ReadonlyMap<string, string>;
}): ProviderExtensionPlugin {
  const { entry } = input;
  const { name, marketplace } = splitPluginId(entry.id);
  const manifest =
    input.manifestText === undefined
      ? undefined
      : Option.getOrUndefined(decodeClaudePluginManifest(input.manifestText));
  const displayName = manifest?.displayName?.trim();
  const description = manifest?.description?.trim();
  const homepage = linkUrl(manifest?.homepage) ?? linkUrl(manifest?.repository);
  const author =
    typeof manifest?.author === "string" ? manifest.author.trim() : manifest?.author?.name?.trim();
  const githubOwner =
    (marketplace ? input.marketplaceOwners.get(marketplace) : undefined) ??
    githubOwnerOfUrl(homepage);
  const homepageHost = githubOwnerOfUrl(homepage) ? undefined : urlHost(homepage);
  const servers = entry.mcpServers;
  const mcpServerCount = Array.isArray(servers)
    ? servers.length
    : servers
      ? Object.keys(servers).length
      : 0;
  const version = entry.version?.trim();
  const scope = entry.scope?.trim();
  const synced = scope === SYNCED_PLUGIN_SCOPE;
  return {
    id: entry.id,
    name,
    enabled: entry.enabled ?? false,
    // Plugins synced from the Claude account are switched and removed there.
    togglable: !synced,
    removable: !synced,
    ...(marketplace && !synced ? { marketplace } : {}),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(version && version !== "unknown" ? { version } : {}),
    ...(scope ? { scope } : {}),
    ...(githubOwner ? { githubOwner } : {}),
    ...(homepageHost ? { homepageHost } : {}),
    ...(author ? { author } : {}),
    ...(mcpServerCount > 0 ? { mcpServerCount } : {}),
  };
}

interface ClaudeCliInput {
  readonly settings: Pick<ClaudeSettings, "binaryPath" | "homePath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

const runClaudeCli = Effect.fn("ClaudeExtensions.runCli")(function* (
  input: ClaudeCliInput & { readonly args: ReadonlyArray<string> },
) {
  const env = yield* makeClaudeEnvironment(input.settings, input.environment);
  const spawnCommand = yield* resolveSpawnCommand(input.settings.binaryPath, input.args, { env });
  return yield* spawnAndCollect(
    input.settings.binaryPath,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd: input.cwd,
      env,
      shell: spawnCommand.shell,
    }),
  );
});

const decodeJsonObjectLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** The message of the first JSON object `claude … --json` printed; human-readable lines follow it. */
export function claudeCliJsonMessage(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const parsed = decodeJsonObjectLine(trimmed);
    if (Option.isNone(parsed)) continue;
    const message = parsed.value.message;
    return typeof message === "string" && message.trim() ? message.trim().slice(0, 500) : undefined;
  }
  return undefined;
}

const runClaudePluginCommand = Effect.fn("ClaudeExtensions.runPluginCommand")(function* (
  input: ClaudeCliInput & {
    readonly operation: ClaudePluginCommandError["operation"];
    readonly args: ReadonlyArray<string>;
  },
) {
  const result = yield* runClaudeCli(input);
  if (result.code !== 0) {
    const reason = claudeCliJsonMessage(result.stdout);
    return yield* new ClaudePluginCommandError({
      operation: input.operation,
      exitCode: result.code,
      ...(reason ? { reason } : {}),
    });
  }
  return result.stdout;
});

const scopeArgs = (scope: string | undefined) =>
  scope && scope !== SYNCED_PLUGIN_SCOPE ? ["--scope", scope] : [];

const listClaudePlugins = Effect.fn("ClaudeExtensions.listPlugins")(function* (
  input: ClaudeCliInput & { readonly configDir: string },
) {
  const path = yield* Path.Path;
  const stdout = yield* runClaudePluginCommand({
    ...input,
    operation: "list",
    args: ["plugin", "list", "--json"],
  });
  const entries = yield* decodeClaudePluginList(stdout);
  const marketplaceOwners = claudeMarketplaceOwners(
    yield* readOptionalFile(path.join(input.configDir, "plugins", "known_marketplaces.json")).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  );
  // A plugin the CLI reports with no install path is one another copy shadows.
  const installed = entries.filter((entry) => entry.installPath?.trim());
  const plugins = yield* Effect.forEach(
    installed,
    (entry) =>
      readOptionalFile(path.join(entry.installPath!, ".claude-plugin", "plugin.json")).pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.map((manifestText) =>
          claudeExtensionPlugin({ entry, manifestText, marketplaceOwners }),
        ),
      ),
    { concurrency: 8 },
  );
  return plugins.toSorted((left, right) =>
    (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name),
  );
});

export const setClaudePluginEnabled = Effect.fn("ClaudeExtensions.setPluginEnabled")(function* (
  input: ClaudeCliInput & {
    readonly pluginId: string;
    readonly enabled: boolean;
    readonly scope?: string | undefined;
  },
) {
  const operation = input.enabled ? "enable" : "disable";
  yield* runClaudePluginCommand({
    ...input,
    operation,
    args: ["plugin", operation, input.pluginId, ...scopeArgs(input.scope)],
  });
});

export const uninstallClaudePlugin = Effect.fn("ClaudeExtensions.uninstallPlugin")(function* (
  input: ClaudeCliInput & { readonly pluginId: string; readonly scope?: string | undefined },
) {
  yield* runClaudePluginCommand({
    ...input,
    operation: "uninstall",
    args: ["plugin", "uninstall", input.pluginId, "--json", ...scopeArgs(input.scope)],
  });
});

export const listClaudeExtensions = Effect.fn("ClaudeExtensions.list")(function* (
  input: ClaudeCliInput & {
    readonly configDir: string;
    readonly globalConfigPath: string;
  },
) {
  const path = yield* Path.Path;
  const settingsPath = path.join(input.configDir, "settings.json");
  const [statuses, plugins, skills, userSettings, globalConfigText] = yield* Effect.all(
    [
      probeClaudeMcpStatuses(input).pipe(Effect.result),
      listClaudePlugins(input).pipe(Effect.result),
      // No cwd: this lists what applies everywhere, not inside one project.
      discoverClaudeSkills(input.settings, undefined, input.environment),
      readClaudeUserSettings(settingsPath),
      readOptionalFile(input.globalConfigPath).pipe(Effect.orElseSucceed(() => undefined)),
    ],
    { concurrency: "unbounded" },
  );
  const denied = deniedMcpServerNames(userSettings);
  const configured = configuredClaudeConnectors(globalConfigText);
  const connectorsLive = statuses._tag === "Success";
  return {
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    connectors: connectorsLive
      ? claudeConnectorsFromStatuses(statuses.success, denied, configured)
      : claudeConnectorsFromConfig(configured, denied),
    connectorsLive,
    ...(connectorsLive
      ? {}
      : {
          connectorsError:
            "Claude Code could not start its MCP servers, so this list comes from its config and shows no status.",
        }),
    manageConnectorsUrl: CLAUDE_CONNECTORS_MANAGE_URL,
    skills: claudeExtensionSkills(skills),
    plugins: plugins._tag === "Success" ? plugins.success : [],
    ...(plugins._tag === "Success" ? {} : { pluginsError: pluginErrorMessage(plugins.failure) }),
  } satisfies ProviderExtensionsListing;
});

function pluginErrorMessage(error: { readonly _tag: string; readonly message?: string }): string {
  return error._tag === "ClaudePluginCommandError" && error.message
    ? error.message
    : "Claude Code could not list its plugins.";
}

interface ClaudeSwitchInput {
  readonly configDir: string;
  readonly name: string;
  readonly enabled: boolean;
}

export const setClaudeConnectorEnabled = Effect.fn("ClaudeExtensions.setConnectorEnabled")(
  function* (input: ClaudeSwitchInput) {
    const path = yield* Path.Path;
    yield* updateClaudeUserSettings(path.join(input.configDir, "settings.json"), (settings) =>
      withMcpServerDenied(settings, input.name, !input.enabled),
    );
  },
);

export const setClaudeSkillEnabled = Effect.fn("ClaudeExtensions.setSkillEnabled")(function* (
  input: ClaudeSwitchInput,
) {
  const path = yield* Path.Path;
  yield* updateClaudeUserSettings(path.join(input.configDir, "settings.json"), (settings) =>
    withSkillDisabled(settings, input.name, !input.enabled),
  );
});
