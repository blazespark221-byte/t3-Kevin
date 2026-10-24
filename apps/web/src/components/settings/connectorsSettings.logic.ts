import type {
  ProviderConnector,
  ProviderConnectorSource,
  ProviderExtensionPlugin,
  ProviderExtensionSkill,
} from "@t3tools/contracts";

import { faviconUrlForOrigin } from "~/lib/favicon";

/**
 * Domains whose favicon is the brand's logo, keyed by the brand's name with
 * everything but letters and digits removed. Generic words ("docs", "design",
 * "data") are deliberately absent so they never borrow a brand.
 */
const BRAND_DOMAINS: Readonly<Record<string, string>> = {
  gmail: "mail.google.com",
  googlemail: "mail.google.com",
  googledrive: "drive.google.com",
  googledocs: "docs.google.com",
  googlesheets: "sheets.google.com",
  googleslides: "slides.google.com",
  googlecalendar: "calendar.google.com",
  gcal: "calendar.google.com",
  google: "google.com",
  gemini: "gemini.google.com",
  notebooklm: "notebooklm.google.com",
  youtube: "youtube.com",
  notion: "notion.so",
  canva: "canva.com",
  stripe: "stripe.com",
  cloudflare: "cloudflare.com",
  elevenlabs: "elevenlabs.io",
  resend: "resend.com",
  clerk: "clerk.com",
  fal: "fal.ai",
  falai: "fal.ai",
  heygen: "heygen.com",
  hyperframes: "heygen.com",
  claude: "claude.ai",
  claudeai: "claude.ai",
  claudedocs: "claude.ai",
  anthropic: "anthropic.com",
  outlook: "outlook.com",
  microsoft: "microsoft.com",
  microsoft365: "microsoft.com",
  office365: "microsoft.com",
  m365: "microsoft.com",
  sharepoint: "microsoft.com",
  onedrive: "onedrive.live.com",
  teams: "teams.microsoft.com",
  microsoftteams: "teams.microsoft.com",
  slack: "slack.com",
  linear: "linear.app",
  figma: "figma.com",
  github: "github.com",
  gitlab: "gitlab.com",
  atlassian: "atlassian.com",
  jira: "atlassian.com",
  confluence: "atlassian.com",
  asana: "asana.com",
  monday: "monday.com",
  clickup: "clickup.com",
  intercom: "intercom.com",
  amplitude: "amplitude.com",
  pendo: "pendo.io",
  fireflies: "fireflies.ai",
  similarweb: "similarweb.com",
  snowflake: "snowflake.com",
  databricks: "databricks.com",
  hex: "hex.tech",
  definite: "definite.app",
  blender: "blender.org",
  davinci: "blackmagicdesign.com",
  davinciresolve: "blackmagicdesign.com",
  roblox: "roblox.com",
  robloxstudio: "roblox.com",
  supabase: "supabase.com",
  vercel: "vercel.com",
  netlify: "netlify.com",
  shadcn: "ui.shadcn.com",
  react: "react.dev",
  openai: "openai.com",
  codex: "openai.com",
  chatgpt: "chatgpt.com",
  kimi: "kimi.com",
  sentry: "sentry.io",
  posthog: "posthog.com",
  zapier: "zapier.com",
  airtable: "airtable.com",
  hubspot: "hubspot.com",
  salesforce: "salesforce.com",
  dropbox: "dropbox.com",
  trello: "trello.com",
  discord: "discord.com",
  spotify: "spotify.com",
  shopify: "shopify.com",
  paypal: "paypal.com",
  twilio: "twilio.com",
  postgres: "postgresql.org",
  postgresql: "postgresql.org",
  playwright: "playwright.dev",
  docker: "docker.com",
  aws: "aws.amazon.com",
  azure: "azure.microsoft.com",
  huggingface: "huggingface.co",
  replicate: "replicate.com",
  perplexity: "perplexity.ai",
  context7: "context7.com",
  swift: "swift.org",
};

/** Hosts that front other services, so their favicon says nothing about the server behind them. */
const PROXY_HOST_SUFFIXES = ["claude.com", "claude.ai", "anthropic.com", "github.com"];

/**
 * The brand a name refers to, matching the whole name, then each pair of
 * adjacent words, then each word: "Google Drive" is Drive, not Google, and
 * "cloudflare-api" is Cloudflare.
 */
export function brandDomainForName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const words = name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const candidates = [
    words.join(""),
    ...words.slice(1).map((word, index) => `${words[index]}${word}`),
    ...words,
  ];
  for (const candidate of candidates) {
    const domain = BRAND_DOMAINS[candidate];
    if (domain) return domain;
  }
  return undefined;
}

/** `mcp.notion.com` → `notion.com`, keeping two-part public suffixes such as `co.uk`. */
export function registrableHost(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const [secondLast = "", last = ""] = labels.slice(-2);
  const twoPartSuffix =
    last.length === 2 && ["co", "com", "org", "net", "gov", "ac", "edu"].includes(secondLast);
  return labels.slice(twoPartSuffix ? -3 : -2).join(".");
}

function isProxyHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return PROXY_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

const LOGO_SIZE = 64;

function faviconFor(domain: string | undefined): string | undefined {
  return domain ? (faviconUrlForOrigin(`https://${domain}`, LOGO_SIZE) ?? undefined) : undefined;
}

function hostFavicon(host: string | undefined): string | undefined {
  return host && !isProxyHost(host) ? faviconFor(registrableHost(host)) : undefined;
}

function githubAvatar(owner: string | undefined): string | undefined {
  return owner && /^[a-z0-9-]+$/i.test(owner)
    ? `https://github.com/${owner}.png?size=${LOGO_SIZE}`
    : undefined;
}

function unique(sources: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(sources.filter((source): source is string => Boolean(source)))];
}

export interface ExtensionLogo {
  /** Image URLs to try in order; the monogram shows when none loads. */
  readonly sources: ReadonlyArray<string>;
  readonly monogram: string;
  /** Hue for the monogram's tint, stable per name. */
  readonly hue: number;
}

function monogramFor(label: string): Pick<ExtensionLogo, "monogram" | "hue"> {
  const letter =
    label
      .replace(/^[^a-z0-9]+/i, "")
      .charAt(0)
      .toUpperCase() || "?";
  let hash = 0;
  for (const character of label) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return { monogram: letter, hue: hash % 360 };
}

export function connectorLogo(
  connector: Pick<
    ProviderConnector,
    "displayName" | "iconUrl" | "websiteHost" | "host" | "pluginName"
  >,
): ExtensionLogo {
  return {
    sources: unique([
      connector.iconUrl,
      faviconFor(brandDomainForName(connector.displayName)),
      hostFavicon(connector.websiteHost),
      hostFavicon(connector.host),
    ]),
    ...monogramFor(connector.displayName),
  };
}

export function pluginLogo(
  plugin: Pick<
    ProviderExtensionPlugin,
    "name" | "displayName" | "githubOwner" | "homepageHost" | "author"
  >,
): ExtensionLogo {
  const label = plugin.displayName ?? plugin.name;
  return {
    sources: unique([
      faviconFor(brandDomainForName(label)),
      githubAvatar(plugin.githubOwner),
      hostFavicon(plugin.homepageHost),
      faviconFor(brandDomainForName(plugin.author)),
    ]),
    ...monogramFor(label),
  };
}

/** A plugin's skill wears the plugin's logo; a personal skill one its name points at. */
export function skillLogo(
  skill: Pick<ProviderExtensionSkill, "name" | "pluginName">,
  pluginsByName: ReadonlyMap<string, ProviderExtensionPlugin>,
): ExtensionLogo {
  const plugin = skill.pluginName ? pluginsByName.get(skill.pluginName) : undefined;
  const ownName = skillDisplayName(skill.name);
  return {
    sources: unique([
      faviconFor(brandDomainForName(ownName)),
      ...(plugin ? pluginLogo(plugin).sources : []),
    ]),
    ...monogramFor(ownName),
  };
}

export function skillDisplayName(name: string): string {
  const separator = name.indexOf(":");
  return separator > 0 ? name.slice(separator + 1) : name;
}

export interface ConnectorGroup {
  readonly id: "claudeai" | "configured" | "plugin";
  readonly title: string;
  readonly connectors: ReadonlyArray<ProviderConnector>;
}

const CONFIGURED_SOURCES = new Set<ProviderConnectorSource>([
  "user",
  "project",
  "local",
  "managed",
  "other",
]);

/** claude.ai connectors, servers the user configured, then servers plugins brought. */
export function groupConnectors(connectors: ReadonlyArray<ProviderConnector>): ConnectorGroup[] {
  const groups: ConnectorGroup[] = [
    {
      id: "claudeai",
      title: "claude.ai connectors",
      connectors: connectors.filter((connector) => connector.source === "claudeai"),
    },
    {
      id: "configured",
      title: "Your MCP servers",
      connectors: connectors.filter((connector) => CONFIGURED_SOURCES.has(connector.source)),
    },
    {
      id: "plugin",
      title: "From plugins",
      connectors: connectors.filter((connector) => connector.source === "plugin"),
    },
  ];
  return groups.filter((group) => group.connectors.length > 0);
}

export function matchesExtensionQuery(
  query: string,
  ...fields: ReadonlyArray<string | undefined>
): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
