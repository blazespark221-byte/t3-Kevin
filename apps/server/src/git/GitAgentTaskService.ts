/**
 * Commit and push as an agent task. The agent reviews, stages, commits and
 * pushes in the requesting thread's checkout, and its thread archives itself
 * once the run completes with the branch pushed. Any other ending leaves the
 * thread where the user can see what happened.
 *
 * @module git/GitAgentTaskService
 */
import {
  CommandId,
  type GitCommitPushTaskAction,
  type GitLaunchCommitPushTaskInput,
  type GitLaunchCommitPushTaskResult,
  type ProjectId,
  type RunId,
  type SourceControlWritingStyleSettings,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "./GitWorkflowService.ts";

export class GitAgentTaskError extends Schema.TaggedError<GitAgentTaskError>()(
  "GitAgentTaskError",
  {
    operation: Schema.Literals(["read-source-thread", "read-settings"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Commit task could not ${this.operation === "read-settings" ? "read settings" : "read the source thread"}.`;
  }
}

export class GitAgentTaskService extends Context.Service<
  GitAgentTaskService,
  {
    readonly launchCommitPushTask: (
      input: GitLaunchCommitPushTaskInput,
    ) => Effect.Effect<
      GitLaunchCommitPushTaskResult,
      | ThreadLaunch.ThreadLaunchError
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
      | GitAgentTaskError
    >;
    /** Waits for the task's run, then archives the thread when it completed with nothing left to push. */
    readonly archiveAfterRun: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<void>;
  }
>()("t3/git/GitAgentTaskService") {}

const ARCHIVE_AFTER_RUN_WAIT_MS = 24 * 60 * 60 * 1_000;

function commitStyleInstruction(style: SourceControlWritingStyleSettings): string {
  if (style.mode === "conventional_commits") {
    return "Use Conventional Commits (`type(scope): summary`); pick the narrowest accurate type and include a scope only when it is obvious from the diff.";
  }
  // An empty custom style has nothing to follow, so it falls back to the repository's conventions.
  if (style.mode === "custom" && style.customInstructions.length > 0) {
    return `Follow these commit message instructions:\n${style.customInstructions}`;
  }
  return "Match this repository's commit style: check recent `git log` subjects and any commit guidance in AGENTS.md or CLAUDE.md.";
}

function commitPushTaskPrompt(input: {
  readonly action: GitCommitPushTaskAction;
  readonly style: SourceControlWritingStyleSettings;
}): string {
  const openPullRequest = input.action === "commit_push_pr";
  return [
    `${openPullRequest ? "Commit, push, and open a pull request for" : "Commit and push"} the current changes in this checkout.`,
    "",
    "1. Run `git status` and review the diff, including untracked files.",
    "2. Stage the changes that belong in the commit. Leave out secrets (keys, tokens, `.env` files) and build or dependency output, and name any file you leave out.",
    `3. Commit with a clear message. ${commitStyleInstruction(input.style)}`,
    "4. Push the current branch, setting its upstream if it has none.",
    ...(openPullRequest
      ? [
          `5. If the branch has no open pull request, open one with the forge's CLI (for example \`gh pr create\`), with a title and body that describe the change.${input.style.followChangeRequestTemplates ? " Use the repository's pull request template if it has one." : ""}`,
        ]
      : []),
    "",
    "If there is nothing to commit, push any unpushed commits; if there is nothing to push either, say so.",
    "Work without asking questions unless you are truly blocked. If a step fails, for example a hook rejects the commit or the push is refused, stop and explain what happened. Never force-push or skip hooks.",
    `Finish with a one-line summary: the commit subject and the branch you pushed${openPullRequest ? ", plus the pull request link" : ""}.`,
  ].join("\n");
}

const make = Effect.gen(function* () {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const layerScope = yield* Effect.scope;

  const checkoutFor = Effect.fnUntraced(function* (projectId: ProjectId, threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId);
    if (shell?.worktreePath) return shell.worktreePath;
    const project = yield* projects.getById(projectId);
    return Option.isSome(project) ? project.value.workspaceRoot : null;
  });

  const archiveAfterRun: GitAgentTaskService["Service"]["archiveAfterRun"] = Effect.fn(
    "GitAgentTaskService.archiveAfterRun",
  )(
    function* (input) {
      const { run } = yield* threads.waitForThread({
        ...input,
        timeoutMs: ARCHIVE_AFTER_RUN_WAIT_MS,
      });
      if (run?.status !== "completed") return;
      // A run can complete with the agent explaining why it could not push;
      // only a pushed branch means the task actually finished.
      const cwd = yield* checkoutFor(input.projectId, input.threadId);
      if (cwd === null) return;
      yield* git.invalidateRemoteStatus(cwd);
      const remote = yield* git.remoteStatus({ cwd });
      if (remote === null || !remote.hasUpstream || remote.aheadCount > 0) return;
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`server:archive-after-run:${input.runId}`),
        threadId: input.threadId,
      });
    },
    Effect.catchCause((cause) => Effect.logWarning("Commit task thread was left open", { cause })),
  );

  const launchCommitPushTask: GitAgentTaskService["Service"]["launchCommitPushTask"] = Effect.fn(
    "GitAgentTaskService.launchCommitPushTask",
  )(function* (input) {
    const source =
      input.threadId === undefined
        ? null
        : yield* threads
            .getThreadShell(input.threadId)
            .pipe(
              Effect.mapError(
                (cause) => new GitAgentTaskError({ operation: "read-source-thread", cause }),
              ),
            );
    const projectId = source?.projectId ?? input.projectId;
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) => new GitAgentTaskError({ operation: "read-settings", cause })),
      ),
      projectId,
    ).settings;
    const worktreePath = source === null ? input.worktreePath : (source.worktreePath ?? undefined);
    const branch = source === null ? input.branch : (source.branch ?? undefined);
    const launched = yield* launches.launch({
      commandId: input.commandId,
      projectId,
      title: input.action === "commit_push_pr" ? "Commit, push & PR" : "Commit & push",
      generateTitle: false,
      modelSelection:
        source?.modelSelection ??
        settings.defaultModelSelection ??
        settings.textGenerationModelSelection,
      // Nobody is watching this thread, so an approval prompt would stall it.
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy:
        worktreePath === undefined
          ? { type: "root", ...(branch === undefined ? {} : { branch }) }
          : {
              type: "existing_worktree",
              worktreePath,
              ...(branch === undefined ? {} : { branch }),
            },
      // The requesting thread already set this checkout up.
      runSetupScript: false,
      initialMessage: {
        text: commitPushTaskPrompt({
          action: input.action,
          style: settings.sourceControlWritingStyle,
        }),
        attachments: [],
      },
      createdBy: "user",
      creationSource: input.creationSource ?? "web",
    });
    const run = ThreadManagement.latestRun(launched.projection);
    if (run !== undefined) {
      yield* archiveAfterRun({ projectId, threadId: launched.threadId, runId: run.id }).pipe(
        Effect.forkIn(layerScope),
      );
    }
    return { threadId: launched.threadId };
  });

  return GitAgentTaskService.of({ launchCommitPushTask, archiveAfterRun });
});

export const layer = Layer.effect(GitAgentTaskService, make);
