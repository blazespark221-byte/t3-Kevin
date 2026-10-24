import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type VcsStatusRemoteResult,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitAgentTask from "./GitAgentTaskService.ts";
import * as GitWorkflow from "./GitWorkflowService.ts";

const projectId = ProjectId.make("project:git-agent-task");
const sourceThreadId = ThreadId.make("thread:git-agent-task:source");
const taskThreadId = ThreadId.make("thread:git-agent-task:task");
const runId = RunId.make("run:git-agent-task");
const sourceModel = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};
const projectDefaultModel = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
};

const pushed: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

interface HarnessOptions {
  readonly runStatus?: "completed" | "failed" | "interrupted";
  readonly remote?: VcsStatusRemoteResult | null;
  readonly waited?: Deferred.Deferred<ThreadManagement.ThreadManagementWaitInput>;
}

function makeHarness(options: HarnessOptions = {}) {
  const launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const source = {
    id: sourceThreadId,
    projectId,
    modelSelection: sourceModel,
    branch: "feature/login",
    worktreePath: "/repo-worktrees/login",
  } as OrchestrationV2ThreadShell;
  const layer = GitAgentTask.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launches.push(input);
              return {
                threadId: taskThreadId,
                projection: { runs: [{ id: runId, ordinal: 1 }] },
                resumed: false,
              } as never;
            }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(threadId === sourceThreadId ? source : { ...source, id: threadId }),
          waitForThread: (input) =>
            options.waited === undefined
              ? Effect.succeed({
                  threadId: input.threadId,
                  run: { id: runId, status: options.runStatus ?? "completed" } as never,
                  timedOut: false,
                })
              : Deferred.succeed(options.waited, input).pipe(Effect.andThen(Effect.never)),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some({ workspaceRoot: "/repo" } as never)),
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          invalidateRemoteStatus: () => Effect.void,
          remoteStatus: () =>
            Effect.succeed(options.remote === undefined ? pushed : options.remote),
        }),
        ServerSettings.layerTest({
          defaultModelSelection: projectDefaultModel,
          sourceControlWritingStyle: {
            mode: "custom",
            customInstructions: "Start every subject with a gitmoji.",
          },
        }),
      ),
    ),
  );
  return { layer, launches, dispatched };
}

it.effect("launches the task in the source thread's checkout with its model", () => {
  return Effect.gen(function* () {
    const waited = yield* Deferred.make<ThreadManagement.ThreadManagementWaitInput>();
    const harness = makeHarness({ waited });
    const result = yield* Effect.gen(function* () {
      const tasks = yield* GitAgentTask.GitAgentTaskService;
      const launched = yield* tasks.launchCommitPushTask({
        commandId: CommandId.make("command:git-agent-task:launch"),
        projectId,
        action: "commit_push",
        threadId: sourceThreadId,
      });
      // The archive waiter is forked for the run the launch created.
      return { launched, wait: yield* Deferred.await(waited) };
    }).pipe(Effect.provide(harness.layer));

    assert.equal(result.launched.threadId, taskThreadId);
    assert.deepEqual(
      { threadId: result.wait.threadId, runId: result.wait.runId },
      { threadId: taskThreadId, runId },
    );
    const [launch] = harness.launches;
    assert.isDefined(launch);
    assert.deepEqual(launch!.workspaceStrategy, {
      type: "existing_worktree",
      worktreePath: "/repo-worktrees/login",
      branch: "feature/login",
    });
    assert.deepEqual(launch!.modelSelection, sourceModel);
    assert.equal(launch!.runtimeMode, "full-access");
    assert.equal(launch!.interactionMode, "default");
    assert.equal(launch!.runSetupScript, false);
    assert.equal(launch!.title, "Commit & push");
    assert.include(launch!.initialMessage?.text ?? "", "Start every subject with a gitmoji.");
    assert.notInclude(launch!.initialMessage?.text ?? "", "pull request");
  });
});

it.effect("launches a draft's task at the project root on its branch", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const tasks = yield* GitAgentTask.GitAgentTaskService;
    yield* tasks.launchCommitPushTask({
      commandId: CommandId.make("command:git-agent-task:draft"),
      projectId,
      action: "commit_push_pr",
      branch: "main",
    });
    const [launch] = harness.launches;
    assert.deepEqual(launch?.workspaceStrategy, { type: "root", branch: "main" });
    assert.deepEqual(launch?.modelSelection, projectDefaultModel);
    assert.equal(launch?.title, "Commit, push & PR");
    assert.include(launch?.initialMessage?.text ?? "", "gh pr create");
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each([
  { name: "completed and pushed", runStatus: "completed" as const, remote: pushed, archives: true },
  { name: "failed", runStatus: "failed" as const, remote: pushed, archives: false },
  { name: "interrupted", runStatus: "interrupted" as const, remote: pushed, archives: false },
  {
    name: "completed with commits left to push",
    runStatus: "completed" as const,
    remote: { ...pushed, aheadCount: 1 },
    archives: false,
  },
  {
    name: "completed without an upstream",
    runStatus: "completed" as const,
    remote: { ...pushed, hasUpstream: false },
    archives: false,
  },
])("archives the task thread only when its run $name", ({ runStatus, remote, archives }) => {
  const harness = makeHarness({ runStatus, remote });
  return Effect.gen(function* () {
    const tasks = yield* GitAgentTask.GitAgentTaskService;
    yield* tasks.archiveAfterRun({ projectId, threadId: taskThreadId, runId });
    assert.deepEqual(
      harness.dispatched.map((command) => command.type),
      archives ? ["thread.archive"] : [],
    );
  }).pipe(Effect.provide(harness.layer));
});
