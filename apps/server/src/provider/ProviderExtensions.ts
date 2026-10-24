/**
 * Lists and switches each provider's own MCP servers, skills and plugins.
 *
 * Listing starts every MCP server a provider has configured, so one listing
 * per instance is kept for a few minutes. A connector or skill switch patches
 * that listing in place; a plugin change can add or remove servers and skills,
 * so it drops the listing instead.
 *
 * @module provider/ProviderExtensions
 */
import {
  ProviderExtensionsError,
  type ProviderConnectorSetEnabledInput,
  type ProviderExtensionsListInput,
  type ProviderExtensionsListResult,
  type ProviderExtensionsSnapshot,
  type ProviderInstanceId,
  type ProviderPluginSetEnabledInput,
  type ProviderPluginUninstallInput,
  type ProviderSkillSetEnabledInput,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import type {
  ProviderExtensionsCapability,
  ProviderExtensionsListing,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";

import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

const LISTING_TTL = Duration.minutes(5);

export class ProviderExtensions extends Context.Service<
  ProviderExtensions,
  {
    readonly list: (
      input: ProviderExtensionsListInput,
    ) => Effect.Effect<ProviderExtensionsListResult>;
    readonly setConnectorEnabled: (
      input: ProviderConnectorSetEnabledInput,
    ) => Effect.Effect<void, ProviderExtensionsError>;
    readonly setSkillEnabled: (
      input: ProviderSkillSetEnabledInput,
    ) => Effect.Effect<void, ProviderExtensionsError>;
    readonly setPluginEnabled: (
      input: ProviderPluginSetEnabledInput,
    ) => Effect.Effect<void, ProviderExtensionsError>;
    readonly uninstallPlugin: (
      input: ProviderPluginUninstallInput,
    ) => Effect.Effect<void, ProviderExtensionsError>;
  }
>()("t3/provider/ProviderExtensions") {}

/** A switched-on server has not connected since, so its last status would be stale. */
function withConnectorEnabled(
  listing: ProviderExtensionsListing,
  name: string,
  enabled: boolean,
): ProviderExtensionsListing {
  return {
    ...listing,
    connectors: listing.connectors.map((connector) => {
      if (connector.name !== name) return connector;
      const { toolCount: _toolCount, error: _error, ...rest } = connector;
      return { ...rest, enabled, status: enabled ? "unknown" : "disabled" };
    }),
  };
}

function withSkillEnabled(
  listing: ProviderExtensionsListing,
  name: string,
  enabled: boolean,
): ProviderExtensionsListing {
  return {
    ...listing,
    skills: listing.skills.map((skill) => (skill.name === name ? { ...skill, enabled } : skill)),
  };
}

type Operation = (typeof ProviderExtensionsError.fields.operation)["Type"];

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  // Switches read and rewrite the provider's whole settings file.
  const writes = yield* Semaphore.make(1);

  const listings = yield* Cache.make({
    capacity: 16,
    timeToLive: LISTING_TTL,
    lookup: (instanceId: ProviderInstanceId) =>
      registry
        .getInstance(instanceId)
        .pipe(
          Effect.flatMap((instance) =>
            instance?.extensions === undefined
              ? Effect.succeed(Option.none<ProviderExtensionsListing>())
              : Effect.asSome(instance.extensions.list),
          ),
        ),
  });

  const snapshotOf = (instance: ProviderInstance, listing: ProviderExtensionsListing) =>
    instance.snapshot.getSnapshot.pipe(
      Effect.map((provider): ProviderExtensionsSnapshot => ({
        ...listing,
        instanceId: instance.instanceId,
        driver: instance.driverKind,
        displayName: instance.displayName?.trim() || provider.displayName || instance.driverKind,
      })),
    );

  const list: ProviderExtensions["Service"]["list"] = Effect.fn("ProviderExtensions.list")(
    function* (input) {
      const instances = (yield* registry.listInstances).filter(
        (instance) => instance.enabled && instance.extensions !== undefined,
      );
      if (input.refresh) {
        yield* Effect.forEach(instances, (instance) =>
          Cache.invalidate(listings, instance.instanceId),
        );
      }
      const snapshots = yield* Effect.forEach(
        instances,
        (instance) =>
          Cache.get(listings, instance.instanceId).pipe(
            Effect.flatMap((listing) =>
              Option.isSome(listing)
                ? Effect.asSome(snapshotOf(instance, listing.value))
                : Effect.succeed(Option.none<ProviderExtensionsSnapshot>()),
            ),
          ),
        { concurrency: "unbounded" },
      );
      return { instances: snapshots.flatMap(Option.toArray) };
    },
  );

  const capability = Effect.fn("ProviderExtensions.capability")(function* (
    instanceId: ProviderInstanceId,
    operation: Operation,
  ) {
    const instance = yield* registry.getInstance(instanceId);
    if (instance === undefined) {
      return yield* new ProviderExtensionsError({
        instanceId,
        operation,
        reason: "instance-not-found",
      });
    }
    if (instance.extensions === undefined) {
      return yield* new ProviderExtensionsError({ instanceId, operation, reason: "unsupported" });
    }
    return instance.extensions;
  });

  const run = <A>(
    instanceId: ProviderInstanceId,
    operation: Operation,
    effect: (
      extensions: ProviderExtensionsCapability,
    ) => Effect.Effect<A, { readonly detail?: string }>,
  ) =>
    capability(instanceId, operation).pipe(
      Effect.flatMap((extensions) =>
        effect(extensions).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderExtensionsError({
                instanceId,
                operation,
                reason: "provider-failed",
                ...(cause.detail ? { detail: cause.detail } : {}),
                cause,
              }),
          ),
        ),
      ),
      writes.withPermits(1),
    );

  const patchListing = (
    instanceId: ProviderInstanceId,
    patch: (listing: ProviderExtensionsListing) => ProviderExtensionsListing,
  ) =>
    Cache.getOption(listings, instanceId).pipe(
      Effect.flatMap((cached) =>
        Option.isSome(cached) && Option.isSome(cached.value)
          ? Cache.set(listings, instanceId, Option.some(patch(cached.value.value)))
          : Effect.void,
      ),
    );

  return ProviderExtensions.of({
    list,
    setConnectorEnabled: Effect.fn("ProviderExtensions.setConnectorEnabled")(function* (input) {
      yield* run(input.instanceId, "set-connector-enabled", (extensions) =>
        extensions.setConnectorEnabled({ name: input.name, enabled: input.enabled }),
      );
      yield* patchListing(input.instanceId, (listing) =>
        withConnectorEnabled(listing, input.name, input.enabled),
      );
    }),
    setSkillEnabled: Effect.fn("ProviderExtensions.setSkillEnabled")(function* (input) {
      yield* run(input.instanceId, "set-skill-enabled", (extensions) =>
        extensions.setSkillEnabled({ name: input.name, enabled: input.enabled }),
      );
      yield* patchListing(input.instanceId, (listing) =>
        withSkillEnabled(listing, input.name, input.enabled),
      );
    }),
    setPluginEnabled: Effect.fn("ProviderExtensions.setPluginEnabled")(function* (input) {
      yield* run(input.instanceId, "set-plugin-enabled", (extensions) =>
        extensions.setPluginEnabled({
          pluginId: input.pluginId,
          enabled: input.enabled,
          scope: input.scope,
        }),
      ).pipe(Effect.ensuring(Cache.invalidate(listings, input.instanceId)));
    }),
    uninstallPlugin: Effect.fn("ProviderExtensions.uninstallPlugin")(function* (input) {
      yield* run(input.instanceId, "uninstall-plugin", (extensions) =>
        extensions.uninstallPlugin({ pluginId: input.pluginId, scope: input.scope }),
      ).pipe(Effect.ensuring(Cache.invalidate(listings, input.instanceId)));
    }),
  });
});

export const layer = Layer.effect(ProviderExtensions, make);
