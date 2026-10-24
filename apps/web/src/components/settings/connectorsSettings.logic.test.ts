import type { ProviderConnector, ProviderExtensionPlugin } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  brandDomainForName,
  connectorLogo,
  groupConnectors,
  matchesExtensionQuery,
  pluginLogo,
  registrableHost,
  skillLogo,
} from "./connectorsSettings.logic";

const favicon = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

describe("brandDomainForName", () => {
  it("prefers the whole name, then word pairs, then single words", () => {
    expect(brandDomainForName("Google Drive")).toBe("drive.google.com");
    expect(brandDomainForName("google calendar")).toBe("calendar.google.com");
    expect(brandDomainForName("cloudflare-api")).toBe("cloudflare.com");
    expect(brandDomainForName("ElevenLabs (2)")).toBe("elevenlabs.io");
    expect(brandDomainForName("Fal ai")).toBe("fal.ai");
    expect(brandDomainForName("HyperFrames by HeyGen")).toBe("heygen.com");
    expect(brandDomainForName("Roblox_Studio")).toBe("roblox.com");
    expect(brandDomainForName("davinci-resolve")).toBe("blackmagicdesign.com");
    expect(brandDomainForName("vercel-react-best-practices")).toBe("vercel.com");
  });

  it("never lends a brand to a generic word", () => {
    expect(brandDomainForName("design")).toBeUndefined();
    expect(brandDomainForName("ai-web-media")).toBeUndefined();
    expect(brandDomainForName("watch")).toBeUndefined();
    expect(brandDomainForName(undefined)).toBeUndefined();
  });
});

it("reduces server hosts to the domain that owns the logo", () => {
  expect(registrableHost("mcp.notion.com")).toBe("notion.com");
  expect(registrableHost("api.example.co.uk")).toBe("example.co.uk");
  expect(registrableHost("fal.ai")).toBe("fal.ai");
});

describe("connectorLogo", () => {
  it("tries the server's own icon, then its brand, then its hosts", () => {
    expect(
      connectorLogo({
        displayName: "Notion",
        iconUrl: "https://mcp.notion.com/logo.svg",
        websiteHost: "developers.notion.com",
        host: "mcp.notion.com",
      }).sources,
    ).toEqual(["https://mcp.notion.com/logo.svg", favicon("notion.so"), favicon("notion.com")]);
  });

  it("skips proxy hosts that would show the proxy's logo", () => {
    const logo = connectorLogo({ displayName: "Seqta", host: "github.com" });
    expect(logo.sources).toEqual([]);
    expect(logo.monogram).toBe("S");
    expect(connectorLogo({ displayName: "Seqta" }).hue).toBe(logo.hue);
    expect(
      connectorLogo({ displayName: "Microsoft 365", host: "microsoft365.mcp.claude.com" }).sources,
    ).toEqual([favicon("microsoft.com")]);
  });
});

describe("plugin and skill logos", () => {
  const cloudflare: ProviderExtensionPlugin = {
    id: "cloudflare@cloudflare",
    name: "cloudflare",
    enabled: true,
    togglable: true,
    removable: true,
    githubOwner: "cloudflare",
  };
  const designer: ProviderExtensionPlugin = {
    id: "designer-skills@designer-skills",
    name: "designer-skills",
    enabled: true,
    togglable: true,
    removable: true,
    githubOwner: "julianoczkowski",
  };

  it("uses a brand, then the marketplace owner's avatar, then the author", () => {
    expect(pluginLogo(cloudflare).sources).toEqual([
      favicon("cloudflare.com"),
      "https://github.com/cloudflare.png?size=64",
    ]);
    expect(pluginLogo(designer).sources).toEqual([
      "https://github.com/julianoczkowski.png?size=64",
    ]);
    expect(
      pluginLogo({ name: "productivity", author: "Anthropic", homepageHost: "example.com" })
        .sources,
    ).toEqual([favicon("example.com"), favicon("anthropic.com")]);
  });

  it("gives a plugin's skills the plugin's logo", () => {
    const plugins = new Map([[designer.name, designer]]);
    const logo = skillLogo(
      { name: "designer-skills:grill-me", pluginName: "designer-skills" },
      plugins,
    );
    expect(logo.sources).toEqual(["https://github.com/julianoczkowski.png?size=64"]);
    expect(logo.monogram).toBe("G");
    expect(skillLogo({ name: "elevenlabs-tts" }, plugins).sources).toEqual([
      favicon("elevenlabs.io"),
    ]);
  });
});

it("groups claude.ai connectors, configured servers, then plugin servers", () => {
  const connector = (name: string, source: ProviderConnector["source"]): ProviderConnector => ({
    name,
    displayName: name,
    source,
    status: "connected",
    enabled: true,
  });
  expect(
    groupConnectors([
      connector("slack", "plugin"),
      connector("Notion", "claudeai"),
      connector("rea", "user"),
      connector("team", "project"),
    ]).map((group) => [group.id, group.connectors.map((entry) => entry.name)]),
  ).toEqual([
    ["claudeai", ["Notion"]],
    ["configured", ["rea", "team"]],
    ["plugin", ["slack"]],
  ]);
});

it("matches every search word across a row's fields", () => {
  expect(matchesExtensionQuery("", "anything")).toBe(true);
  expect(matchesExtensionQuery("drive google", "Google Drive", "claude.ai")).toBe(true);
  expect(matchesExtensionQuery("gmail", "Google Drive")).toBe(false);
});
