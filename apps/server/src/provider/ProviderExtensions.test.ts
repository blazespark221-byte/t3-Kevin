import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type {
  ProviderExtensionsListing,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";

import * as ProviderExtensions from "./ProviderExtensions.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

const instanceId = ProviderInstanceId.make("claude-test");
const driver = ProviderDriverKind.make("claudeAgent");

const listing: ProviderExtensionsListing = {
  checkedAt: "2026-10-25T00:00:00.000Z",
  connectors: [
    {
      name: "claude.ai Notion",
      displayName: "Notion",
      source: "claudeai",
      status: "connected",
      enabled: true,
      toolCount: 3,
    },
  ],
  connectorsLive: true,
  skills: [{ name: "watch", source: "personal", enabled: true, togglable: true }],
  plugins: [],
};

const setup = Effect.gen(function* () {
  const lists = yield* Ref.make(0);
  const switched = yield* Ref.make<ReadonlyArray<string>>([]);
  const instance = {
    instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: "claude:test" },
    displayName: undefined,
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed({ displayName: "Claude" }),
    } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
    extensions: {
      list: Ref.update(lists, (count) => count + 1).pipe(Effect.as(listing)),
      setConnectorEnabled: (input) =>
        Ref.update(switched, (all) => [...all, `connector:${input.name}:${input.enabled}`]),
      setSkillEnabled: (input) =>
        Ref.update(switched, (all) => [...all, `skill:${input.name}:${input.enabled}`]),
      setPluginEnabled: (input) =>
        Ref.update(switched, (all) => [...all, `plugin:${input.pluginId}:${input.enabled}`]),
      uninstallPlugin: () => Effect.void,
    },
  } satisfies ProviderInstance;
  const registry = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
    listInstances: Effect.succeed([instance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  });
  const service = yield* ProviderExtensions.ProviderExtensions.pipe(
    Effect.provide(ProviderExtensions.layer.pipe(Layer.provide(registry))),
  );
  return { service, lists, switched };
});

it.effect("keeps one listing per instance until a refresh is asked for", () =>
  Effect.gen(function* () {
    const { service, lists } = yield* setup;

    const first = yield* service.list({});
    yield* service.list({});
    assert.equal(yield* Ref.get(lists), 1);
    assert.deepEqual(
      first.instances.map((snapshot) => [snapshot.instanceId, snapshot.displayName]),
      [[instanceId, "Claude"]],
    );

    yield* service.list({ refresh: true });
    assert.equal(yield* Ref.get(lists), 2);
  }),
);

it.effect("a switch shows in the next listing without starting the servers again", () =>
  Effect.gen(function* () {
    const { service, lists, switched } = yield* setup;
    yield* service.list({});

    yield* service.setConnectorEnabled({ instanceId, name: "claude.ai Notion", enabled: false });
    yield* service.setSkillEnabled({ instanceId, name: "watch", enabled: false });
    const [snapshot] = (yield* service.list({})).instances;

    assert.equal(yield* Ref.get(lists), 1);
    assert.deepEqual(yield* Ref.get(switched), [
      "connector:claude.ai Notion:false",
      "skill:watch:false",
    ]);
    assert.deepEqual(snapshot?.connectors, [
      {
        name: "claude.ai Notion",
        displayName: "Notion",
        source: "claudeai",
        status: "disabled",
        enabled: false,
      },
    ]);
    assert.isFalse(snapshot?.skills[0]?.enabled);

    yield* service.setConnectorEnabled({ instanceId, name: "claude.ai Notion", enabled: true });
    const [reenabled] = (yield* service.list({})).instances;
    // Not connected since it was switched back on, so the old status would be a guess.
    assert.equal(reenabled?.connectors[0]?.status, "unknown");
  }),
);

it.effect("a plugin change lists everything again", () =>
  Effect.gen(function* () {
    const { service, lists } = yield* setup;
    yield* service.list({});

    yield* service.setPluginEnabled({ instanceId, pluginId: "codex@openai-codex", enabled: false });
    yield* service.list({});

    assert.equal(yield* Ref.get(lists), 2);
  }),
);

it.effect("reports an unknown instance", () =>
  Effect.gen(function* () {
    const { service } = yield* setup;
    const error = yield* service
      .setSkillEnabled({ instanceId: ProviderInstanceId.make("missing"), name: "x", enabled: true })
      .pipe(Effect.flip);
    assert.equal(error.reason, "instance-not-found");
  }),
);
