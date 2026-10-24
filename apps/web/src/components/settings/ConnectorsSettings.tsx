import type {
  EnvironmentId,
  ProviderConnector,
  ProviderConnectorSource,
  ProviderConnectorStatus,
  ProviderExtensionPlugin,
  ProviderExtensionSkill,
  ProviderExtensionsSnapshot,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { ExternalLinkIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { FaviconImage } from "../preview/PreviewFaviconIcon";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { RefreshIcon } from "../ui/refresh-icon";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  connectorLogo,
  groupConnectors,
  matchesExtensionQuery,
  pluginLogo,
  skillDisplayName,
  skillLogo,
  type ExtensionLogo,
} from "./connectorsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function ConnectorsSettingsPanel() {
  const { environment, scope } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <p className="text-muted-foreground text-sm">
          {scope.kind === "environment"
            ? `Reconnect ${scope.label} to manage its connectors and skills.`
            : "Connect an environment to manage its connectors and skills."}
        </p>
      ) : (
        <ConnectorsSettings environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "Claude Code could not apply the change.",
  });
}

function ConnectorsSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [query, setQuery] = useState("");
  const extensions = useEnvironmentQuery(
    serverEnvironment.providerExtensions({ environmentId, input: {} }),
  );
  const restart = useAtomCommand(serverEnvironment.refreshProviderExtensions, {
    reportFailure: false,
  });
  const [restarting, setRestarting] = useState(false);
  const canManage = useAtomValue(
    serverEnvironment.setProviderConnectorEnabled.permissionAtom(environmentId),
  );
  const refreshing = restarting || extensions.isPending;
  const refresh = async () => {
    setRestarting(true);
    const result = await restart({ environmentId, input: { refresh: true } });
    reportFailure("Could not check connectors", result);
    setRestarting(false);
    extensions.refresh();
  };
  const instances = extensions.data?.instances ?? [];

  return (
    <>
      <div className="flex items-center gap-2">
        <InputGroup className="flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search connectors, skills and plugins"
            aria-label="Search connectors, skills and plugins"
          />
        </InputGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="outline"
                onClick={() => void refresh()}
                disabled={refreshing}
                aria-label="Check every connector again"
              />
            }
          >
            <RefreshIcon refreshing={refreshing} />
          </TooltipTrigger>
          <TooltipPopup>Start every MCP server again and read its status</TooltipPopup>
        </Tooltip>
      </div>
      {extensions.error ? (
        <Alert variant="error">
          <AlertDescription>{extensions.error}</AlertDescription>
        </Alert>
      ) : null}
      {extensions.data === null && extensions.isPending ? (
        <p className="text-muted-foreground text-sm">
          Starting Claude Code's MCP servers to read their status…
        </p>
      ) : null}
      {extensions.data !== null && instances.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Enable a Claude provider in Settings → Providers to manage its connectors and skills.
        </p>
      ) : null}
      {instances.map((snapshot) => (
        <ExtensionsInstance
          key={snapshot.instanceId}
          environmentId={environmentId}
          snapshot={snapshot}
          showInstanceName={instances.length > 1}
          query={query}
          canManage={canManage}
          onChanged={() => extensions.refresh()}
        />
      ))}
    </>
  );
}

interface InstanceProps {
  readonly environmentId: EnvironmentId;
  readonly snapshot: ProviderExtensionsSnapshot;
  readonly canManage: boolean;
  readonly onChanged: () => void;
}

function ExtensionsInstance(
  props: InstanceProps & { readonly showInstanceName: boolean; readonly query: string },
) {
  const { snapshot, query } = props;
  const prefix = props.showInstanceName ? `${snapshot.displayName} · ` : "";
  const openLink = useOpenLink(null);
  const pluginsByName = new Map(snapshot.plugins.map((plugin) => [plugin.name, plugin] as const));
  const connectorGroups = groupConnectors(
    snapshot.connectors.filter((connector) =>
      matchesExtensionQuery(
        query,
        connector.displayName,
        connector.name,
        connector.pluginName,
        connector.host,
      ),
    ),
  );
  const skills = snapshot.skills.filter((skill) =>
    matchesExtensionQuery(query, skill.name, skill.description, skill.pluginName),
  );
  const plugins = snapshot.plugins.filter((plugin) =>
    matchesExtensionQuery(query, plugin.displayName, plugin.name, plugin.description),
  );
  const rowProps = {
    environmentId: props.environmentId,
    snapshot,
    canManage: props.canManage,
    onChanged: props.onChanged,
  };

  return (
    <>
      {snapshot.connectorsError ? (
        <Alert variant="warning">
          <AlertDescription>{snapshot.connectorsError}</AlertDescription>
        </Alert>
      ) : null}
      {connectorGroups.map((group) => (
        <SettingsSection
          key={group.id}
          id={group.id === "claudeai" ? "connectors" : `connectors-${group.id}`}
          title={`${prefix}${group.title}`}
          headerAction={
            group.id === "claudeai" && snapshot.manageConnectorsUrl ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void openLink(snapshot.manageConnectorsUrl!)}
              >
                <ExternalLinkIcon />
                Manage on claude.ai
              </Button>
            ) : (
              <EnabledCount items={group.connectors} />
            )
          }
        >
          {group.connectors.map((connector) => (
            <ConnectorRow key={connector.name} {...rowProps} connector={connector} />
          ))}
        </SettingsSection>
      ))}
      <SettingsSection
        id="skills"
        title={`${prefix}Skills`}
        headerAction={<EnabledCount items={skills} />}
      >
        {skills.length === 0 ? (
          <SettingsRow title={query.trim() ? "No skills match." : "No skills installed."} />
        ) : (
          skills.map((skill) => (
            <SkillRow key={skill.name} {...rowProps} skill={skill} pluginsByName={pluginsByName} />
          ))
        )}
      </SettingsSection>
      <SettingsSection
        id="plugins"
        title={`${prefix}Plugins`}
        headerAction={snapshot.pluginsError ? null : <EnabledCount items={plugins} />}
      >
        {snapshot.pluginsError ? (
          <SettingsRow title="Could not list plugins" description={snapshot.pluginsError} />
        ) : plugins.length === 0 ? (
          <SettingsRow title={query.trim() ? "No plugins match." : "No plugins installed."} />
        ) : (
          plugins.map((plugin) => <PluginRow key={plugin.id} {...rowProps} plugin={plugin} />)
        )}
      </SettingsSection>
    </>
  );
}

function EnabledCount({ items }: { readonly items: ReadonlyArray<{ readonly enabled: boolean }> }) {
  if (items.length === 0) return null;
  return (
    <span className="text-muted-foreground text-xs tabular-nums">
      {items.filter((item) => item.enabled).length} of {items.length} on
    </span>
  );
}

function ExtensionLogoImage({ logo }: { readonly logo: ExtensionLogo }) {
  const monogram = (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-md font-semibold text-3xs text-white leading-none"
      style={{ backgroundColor: `hsl(${logo.hue} 45% 45%)` }}
    >
      {logo.monogram}
    </span>
  );
  return (
    <FaviconImage
      sources={logo.sources}
      fallback={monogram}
      className="size-5 shrink-0 rounded-md bg-white object-contain p-px"
    />
  );
}

function RowTitle(props: { readonly logo: ExtensionLogo; readonly children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ExtensionLogoImage logo={props.logo} />
      {props.children}
    </span>
  );
}

/**
 * Shows the switched-to value until the refreshed listing replaces the row,
 * so a switch never snaps back while its change is in flight.
 */
function useOptimisticSwitch<T extends { readonly enabled: boolean }>(item: T) {
  const [optimistic, setOptimistic] = useState<{ readonly value: boolean; readonly base: T }>();
  const [inFlight, setInFlight] = useState(false);
  const checked = optimistic?.base === item ? optimistic.value : item.enabled;
  const run = async (
    enabled: boolean,
    command: () => Promise<AtomCommandResult<unknown, unknown>>,
    failureTitle: string,
    onChanged: () => void,
  ) => {
    setOptimistic({ value: enabled, base: item });
    setInFlight(true);
    const result = await command();
    setInFlight(false);
    if (result._tag === "Failure") {
      setOptimistic(undefined);
      reportFailure(failureTitle, result);
      return;
    }
    onChanged();
  };
  return { checked, inFlight, run };
}

const SOURCE_LABELS: Readonly<Record<ProviderConnectorSource, string | null>> = {
  claudeai: "claude.ai",
  user: "Local",
  project: "Project",
  local: "Project, private",
  plugin: "Plugin",
  managed: "Managed",
  other: null,
};

const STATUS_BADGES: Readonly<
  Record<
    ProviderConnectorStatus,
    {
      readonly label: string;
      readonly variant: "success" | "warning" | "error" | "secondary" | "outline";
    }
  >
> = {
  connected: { label: "Connected", variant: "success" },
  "needs-auth": { label: "Needs sign-in", variant: "warning" },
  failed: { label: "Failed", variant: "error" },
  pending: { label: "Still connecting", variant: "secondary" },
  disabled: { label: "Off", variant: "outline" },
  unknown: { label: "Not checked", variant: "outline" },
};

function connectorDescription(connector: ProviderConnector): ReactNode {
  const details = [
    connector.toolCount !== undefined
      ? `${connector.toolCount} tool${connector.toolCount === 1 ? "" : "s"}`
      : null,
    connector.transport === "stdio" ? "Runs on this machine" : (connector.host ?? null),
    connector.status === "needs-auth"
      ? connector.source === "claudeai"
        ? "Sign in on claude.ai"
        : "Sign in with /mcp in Claude Code"
      : null,
    connector.error ?? null,
  ].filter(Boolean);
  return details.length > 0 ? <span className="line-clamp-2">{details.join(" · ")}</span> : null;
}

function ConnectorRow(
  props: Omit<InstanceProps, "snapshot"> & {
    readonly snapshot: ProviderExtensionsSnapshot;
    readonly connector: ProviderConnector;
  },
) {
  const { connector } = props;
  const setEnabled = useAtomCommand(serverEnvironment.setProviderConnectorEnabled, {
    reportFailure: false,
  });
  const toggle = useOptimisticSwitch(connector);
  const status = STATUS_BADGES[connector.status];
  const source = SOURCE_LABELS[connector.source];
  return (
    <SettingsRow
      title={
        <RowTitle logo={connectorLogo(connector)}>
          <span className="truncate">{connector.displayName}</span>
          {source ? (
            <Badge variant="secondary" size="sm">
              {connector.source === "plugin" && connector.pluginName
                ? `${source} · ${connector.pluginName}`
                : source}
            </Badge>
          ) : null}
          <Badge variant={status.variant} size="sm">
            {status.label}
          </Badge>
        </RowTitle>
      }
      description={connectorDescription(connector)}
      control={
        <Switch
          checked={toggle.checked}
          disabled={!props.canManage || toggle.inFlight}
          onCheckedChange={(next) =>
            void toggle.run(
              Boolean(next),
              () =>
                setEnabled({
                  environmentId: props.environmentId,
                  input: {
                    instanceId: props.snapshot.instanceId,
                    name: connector.name,
                    enabled: Boolean(next),
                  },
                }),
              `Could not ${next ? "enable" : "disable"} ${connector.displayName}`,
              props.onChanged,
            )
          }
          aria-label={`${toggle.checked ? "Disable" : "Enable"} ${connector.displayName}`}
        />
      }
    />
  );
}

function SkillRow(
  props: Omit<InstanceProps, "snapshot"> & {
    readonly snapshot: ProviderExtensionsSnapshot;
    readonly skill: ProviderExtensionSkill;
    readonly pluginsByName: ReadonlyMap<string, ProviderExtensionPlugin>;
  },
) {
  const { skill } = props;
  const setEnabled = useAtomCommand(serverEnvironment.setProviderSkillEnabled, {
    reportFailure: false,
  });
  const toggle = useOptimisticSwitch(skill);
  const label = skillDisplayName(skill.name);
  const control = (
    <Switch
      checked={toggle.checked}
      disabled={!props.canManage || !skill.togglable || toggle.inFlight}
      onCheckedChange={(next) =>
        void toggle.run(
          Boolean(next),
          () =>
            setEnabled({
              environmentId: props.environmentId,
              input: {
                instanceId: props.snapshot.instanceId,
                name: skill.name,
                enabled: Boolean(next),
              },
            }),
          `Could not ${next ? "enable" : "disable"} ${label}`,
          props.onChanged,
        )
      }
      aria-label={`${toggle.checked ? "Disable" : "Enable"} ${label}`}
    />
  );
  return (
    <SettingsRow
      title={
        <RowTitle logo={skillLogo(skill, props.pluginsByName)}>
          <span className="truncate">{label}</span>
          <Badge variant="secondary" size="sm">
            {skill.source === "plugin"
              ? (skill.pluginName ?? "Plugin")
              : skill.source === "project"
                ? "Project"
                : "Personal"}
          </Badge>
        </RowTitle>
      }
      description={
        skill.description ? <span className="line-clamp-2">{skill.description}</span> : undefined
      }
      control={
        skill.togglable ? (
          control
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span />}>{control}</TooltipTrigger>
            <TooltipPopup>Turns on and off with its plugin</TooltipPopup>
          </Tooltip>
        )
      }
    />
  );
}

function PluginRow(
  props: Omit<InstanceProps, "snapshot"> & {
    readonly snapshot: ProviderExtensionsSnapshot;
    readonly plugin: ProviderExtensionPlugin;
  },
) {
  const { plugin } = props;
  const label = plugin.displayName ?? plugin.name;
  const setEnabled = useAtomCommand(serverEnvironment.setProviderPluginEnabled, {
    reportFailure: false,
  });
  const uninstall = useAtomCommand(serverEnvironment.uninstallProviderPlugin, {
    reportFailure: false,
  });
  const toggle = useOptimisticSwitch(plugin);
  const [removing, setRemoving] = useState(false);
  const scope = plugin.scope ? { scope: plugin.scope } : {};

  const remove = async () => {
    const confirmed = await readLocalApi()?.dialogs.confirm(
      `Remove ${label} from Claude Code? Its skills and MCP servers go with it.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setRemoving(true);
    const result = await uninstall({
      environmentId: props.environmentId,
      input: { instanceId: props.snapshot.instanceId, pluginId: plugin.id, ...scope },
    });
    setRemoving(false);
    reportFailure(`Could not remove ${label}`, result);
    props.onChanged();
  };

  const switchControl = (
    <Switch
      checked={toggle.checked}
      disabled={!props.canManage || !plugin.togglable || toggle.inFlight || removing}
      onCheckedChange={(next) =>
        void toggle.run(
          Boolean(next),
          () =>
            setEnabled({
              environmentId: props.environmentId,
              input: {
                instanceId: props.snapshot.instanceId,
                pluginId: plugin.id,
                enabled: Boolean(next),
                ...scope,
              },
            }),
          `Could not ${next ? "enable" : "disable"} ${label}`,
          props.onChanged,
        )
      }
      aria-label={`${toggle.checked ? "Disable" : "Enable"} ${label}`}
    />
  );

  return (
    <SettingsRow
      title={
        <RowTitle logo={pluginLogo(plugin)}>
          <span className="truncate">{label}</span>
          {plugin.version ? (
            <span className="text-muted-foreground text-xs tabular-nums">{plugin.version}</span>
          ) : null}
          {plugin.marketplace ? (
            <Badge variant="outline" size="sm">
              {plugin.marketplace}
            </Badge>
          ) : null}
          {plugin.scope === "synced" ? (
            <Badge variant="info" size="sm">
              From your Claude account
            </Badge>
          ) : plugin.scope && plugin.scope !== "user" ? (
            <Badge variant="secondary" size="sm">
              {plugin.scope}
            </Badge>
          ) : null}
          {plugin.mcpServerCount ? (
            <Badge variant="secondary" size="sm">
              {plugin.mcpServerCount} MCP server{plugin.mcpServerCount === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </RowTitle>
      }
      description={
        plugin.description ? <span className="line-clamp-2">{plugin.description}</span> : undefined
      }
      control={
        <span className="flex items-center gap-2">
          {plugin.removable ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={!props.canManage || removing || toggle.inFlight}
                    onClick={() => void remove()}
                    aria-label={`Remove ${label}`}
                  />
                }
              >
                <Trash2Icon />
              </TooltipTrigger>
              <TooltipPopup>Remove</TooltipPopup>
            </Tooltip>
          ) : null}
          {plugin.togglable ? (
            switchControl
          ) : (
            <Tooltip>
              <TooltipTrigger render={<span />}>{switchControl}</TooltipTrigger>
              <TooltipPopup>Managed in your Claude account</TooltipPopup>
            </Tooltip>
          )}
        </span>
      }
    />
  );
}
