import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeCliJsonMessage,
  claudeConnectorsFromConfig,
  claudeConnectorsFromStatuses,
  claudeExtensionPlugin,
  claudeExtensionSkills,
  claudeMarketplaceOwners,
  configuredClaudeConnectors,
  deniedMcpServerNames,
  parseClaudeUserSettings,
  setClaudeConnectorEnabled,
  setClaudeSkillEnabled,
  withMcpServerDenied,
  withSkillDisabled,
} from "./ClaudeExtensions.ts";
import { discoverClaudeSkills } from "./Drivers/ClaudeSkills.ts";

it("denies a server once and lifts only its own entry", () => {
  const settings = {
    model: "opus",
    deniedMcpServers: [{ serverUrl: "https://*.example.com/*" }, { serverName: "blender" }],
  };
  const denied = withMcpServerDenied(settings, "claude.ai Gmail", true);
  assert.deepEqual(denied, {
    model: "opus",
    deniedMcpServers: [
      { serverUrl: "https://*.example.com/*" },
      { serverName: "blender" },
      { serverName: "claude.ai Gmail" },
    ],
  });
  assert.deepEqual(withMcpServerDenied(denied!, "claude.ai Gmail", true), denied);
  assert.deepEqual(withMcpServerDenied(denied!, "blender", false), {
    model: "opus",
    deniedMcpServers: [{ serverUrl: "https://*.example.com/*" }, { serverName: "claude.ai Gmail" }],
  });
  assert.deepEqual(
    withMcpServerDenied({ deniedMcpServers: [{ serverName: "x" }] }, "x", false),
    {},
  );
  assert.deepEqual(deniedMcpServerNames(denied), new Set(["blender", "claude.ai Gmail"]));
  assert.isNull(withMcpServerDenied({ deniedMcpServers: "blender" }, "x", true));
});

it("turns a skill off with an override and back on by removing it", () => {
  const off = withSkillDisabled(
    { skillOverrides: { watch: "user-invocable-only" } },
    "shadcn",
    true,
  );
  assert.deepEqual(off, { skillOverrides: { watch: "user-invocable-only", shadcn: "off" } });
  assert.deepEqual(withSkillDisabled(off!, "shadcn", false), {
    skillOverrides: { watch: "user-invocable-only" },
  });
  assert.deepEqual(withSkillDisabled({ skillOverrides: { shadcn: "off" } }, "shadcn", false), {});
  assert.isNull(withSkillDisabled({ skillOverrides: [] }, "shadcn", true));
});

it("reads only strict JSON objects as settings", () => {
  assert.deepEqual(parseClaudeUserSettings(undefined), {});
  assert.deepEqual(parseClaudeUserSettings("  "), {});
  assert.deepEqual(parseClaudeUserSettings('{"a":1}'), { a: 1 });
  assert.isNull(parseClaudeUserSettings('{\n  // note\n  "a": 1\n}'));
  assert.isNull(parseClaudeUserSettings('{"a":1,}'));
  assert.isNull(parseClaudeUserSettings("[]"));
});

it.layer(NodeServices.layer)("Claude settings switches", (it) => {
  it.effect("rewrites settings.json with only the switched key changed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-extensions-" });
      const settingsPath = path.join(configDir, "settings.json");
      yield* fs.writeFileString(
        settingsPath,
        '{"model":"opus","enabledPlugins":{"codex@openai-codex":true}}',
      );

      yield* setClaudeConnectorEnabled({ configDir, name: "claude.ai Gmail", enabled: false });

      assert.equal(
        yield* fs.readFileString(settingsPath),
        `${JSON.stringify(
          {
            model: "opus",
            enabledPlugins: { "codex@openai-codex": true },
            deniedMcpServers: [{ serverName: "claude.ai Gmail" }],
          },
          null,
          2,
        )}\n`,
      );

      yield* setClaudeConnectorEnabled({ configDir, name: "claude.ai Gmail", enabled: true });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(settingsPath)), {
        model: "opus",
        enabledPlugins: { "codex@openai-codex": true },
      });
    }),
  );

  it.effect("creates settings.json when Claude has none yet", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-extensions-" });

      yield* setClaudeSkillEnabled({ configDir, name: "watch", enabled: false });

      assert.deepEqual(
        JSON.parse(yield* fs.readFileString(path.join(configDir, "settings.json"))),
        {
          skillOverrides: { watch: "off" },
        },
      );
    }),
  );

  it.effect("leaves a settings file with comments untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-extensions-" });
      const settingsPath = path.join(configDir, "settings.json");
      const original = '{\n  // keep me\n  "model": "opus",\n}\n';
      yield* fs.writeFileString(settingsPath, original);

      const error = yield* setClaudeSkillEnabled({ configDir, name: "watch", enabled: false }).pipe(
        Effect.flip,
      );

      assert.equal(error.reason, "not-strict-json");
      assert.equal(yield* fs.readFileString(settingsPath), original);
    }),
  );

  it.effect("a switched-off skill reads back disabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-extensions-" });
      const skillDir = path.join(configDir, "skills", "watch");
      yield* fs.makeDirectory(skillDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(skillDir, "SKILL.md"),
        "---\nname: watch\ndescription: Watch a video.\n---\n",
      );

      yield* setClaudeSkillEnabled({ configDir, name: "watch", enabled: false });
      const skills = claudeExtensionSkills(yield* discoverClaudeSkills({ homePath: configDir }));

      assert.deepEqual(skills, [
        {
          name: "watch",
          source: "personal",
          enabled: false,
          togglable: true,
          description: "Watch a video.",
        },
      ]);
    }),
  );
});

it("maps the CLI's MCP status and brings back denied servers as switched off", () => {
  const connectors = claudeConnectorsFromStatuses(
    [
      {
        name: "claude.ai Notion",
        status: "connected",
        scope: "claudeai",
        source: "claudeai",
        config: { type: "claudeai-proxy", url: "https://mcp.notion.com/mcp?token=secret", id: "x" },
        serverInfo: {
          name: "Notion MCP",
          websiteUrl: "https://developers.notion.com/docs/mcp",
          icons: [
            { src: "http://insecure.example/logo.svg" },
            { src: "https://mcp.notion.com/n.svg" },
          ],
        },
        tools: [{ name: "search" }, { name: "fetch" }],
      },
      {
        name: "plugin:cloudflare:cloudflare-api",
        status: "needs-auth",
        scope: "dynamic",
        source: "plugin",
        config: { type: "http", url: "https://mcp.cloudflare.com/mcp" },
        tools: [],
      },
      {
        name: "rea",
        status: "failed",
        scope: "user",
        source: "user",
        error: "  spawn ENOENT  ",
        config: { type: "stdio", command: "rea" },
      },
      { name: 42 },
    ],
    new Set(["claude.ai Gmail"]),
    configuredClaudeConnectors(
      JSON.stringify({ claudeAiMcpEverConnected: ["claude.ai Gmail", "claude.ai Notion"] }),
    ),
  );

  assert.deepEqual(connectors, [
    {
      name: "plugin:cloudflare:cloudflare-api",
      displayName: "cloudflare-api",
      source: "plugin",
      status: "needs-auth",
      enabled: true,
      transport: "http",
      host: "mcp.cloudflare.com",
      pluginName: "cloudflare",
    },
    {
      name: "claude.ai Gmail",
      displayName: "Gmail",
      source: "claudeai",
      transport: "claudeai-proxy",
      status: "disabled",
      enabled: false,
    },
    {
      name: "claude.ai Notion",
      displayName: "Notion",
      source: "claudeai",
      status: "connected",
      enabled: true,
      transport: "claudeai-proxy",
      host: "mcp.notion.com",
      websiteHost: "developers.notion.com",
      iconUrl: "https://mcp.notion.com/n.svg",
      toolCount: 2,
    },
    {
      name: "rea",
      displayName: "rea",
      source: "user",
      status: "failed",
      enabled: true,
      transport: "stdio",
      error: "spawn ENOENT",
    },
  ]);
});

it("falls back to Claude's global config when no server could start", () => {
  const configured = configuredClaudeConnectors(
    JSON.stringify({
      claudeAiMcpEverConnected: ["claude.ai Canva"],
      mcpServers: {
        fal: { type: "http", url: "https://mcp.fal.ai/mcp-relay" },
        blender: { command: "uvx", args: ["blender-mcp"] },
      },
    }),
  );

  assert.deepEqual(
    claudeConnectorsFromConfig(configured, new Set(["blender"])).map((connector) => [
      connector.name,
      connector.status,
      connector.transport,
      connector.host,
    ]),
    [
      ["blender", "disabled", "stdio", undefined],
      ["claude.ai Canva", "unknown", "claudeai-proxy", undefined],
      ["fal", "unknown", "http", "mcp.fal.ai"],
    ],
  );
  assert.deepEqual(configuredClaudeConnectors("not json").size, 0);
});

it("finds each plugin's logo owner from its marketplace or homepage", () => {
  const owners = claudeMarketplaceOwners(
    JSON.stringify({
      cloudflare: { source: { source: "github", repo: "cloudflare/skills" } },
      mirror: { source: { source: "git", url: "https://github.com/acme/plugins.git" } },
    }),
  );
  assert.equal(owners.get("cloudflare"), "cloudflare");
  assert.equal(owners.get("mirror"), "acme");
  assert.equal(owners.get("claude-plugins-official"), "anthropics");

  assert.deepEqual(
    claudeExtensionPlugin({
      entry: {
        id: "cloudflare@cloudflare",
        version: "1.0.0",
        scope: "user",
        enabled: true,
        installPath: "/plugins/cloudflare",
        mcpServers: ["cloudflare-api", "cloudflare-docs"],
      },
      manifestText: '{"name":"cloudflare","author":{"name":"Cloudflare"}}',
      marketplaceOwners: owners,
    }),
    {
      id: "cloudflare@cloudflare",
      name: "cloudflare",
      enabled: true,
      togglable: true,
      removable: true,
      marketplace: "cloudflare",
      version: "1.0.0",
      scope: "user",
      githubOwner: "cloudflare",
      author: "Cloudflare",
      mcpServerCount: 2,
    },
  );

  const synced = claudeExtensionPlugin({
    entry: { id: "design@synced", version: "unknown", scope: "synced", enabled: true },
    manifestText: '{"name":"design","homepage":"https://example.com/design","author":"Anthropic"}',
    marketplaceOwners: owners,
  });
  assert.deepEqual(synced, {
    id: "design@synced",
    name: "design",
    enabled: true,
    togglable: false,
    removable: false,
    scope: "synced",
    homepageHost: "example.com",
    author: "Anthropic",
  });

  assert.equal(
    claudeExtensionPlugin({
      entry: { id: "slides@unlisted", enabled: false, mcpServers: { a: {}, b: {} } },
      manifestText: '{"repository":{"url":"https://github.com/zara/slides"}}',
      marketplaceOwners: owners,
    }).githubOwner,
    "zara",
  );
});

it("labels plugin skills by their plugin and keeps them out of per-skill switches", () => {
  assert.deepEqual(
    claudeExtensionSkills([
      { name: "cloudflare:wrangler", path: "/p/SKILL.md", scope: "user", enabled: true },
      { name: "repo-skill", path: "/r/SKILL.md", scope: "project", enabled: true },
    ]),
    [
      {
        name: "cloudflare:wrangler",
        source: "plugin",
        enabled: true,
        togglable: false,
        pluginName: "cloudflare",
      },
      { name: "repo-skill", source: "project", enabled: true, togglable: true },
    ],
  );
});

it("reads Claude Code's own reason from --json output", () => {
  assert.equal(
    claudeCliJsonMessage('{"outcome":"failed","message":" not found in marketplace "}\nhint'),
    "not found in marketplace",
  );
  assert.isUndefined(claudeCliJsonMessage("plain text"));
});
