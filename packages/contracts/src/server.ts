import { Effect, Schema } from "effect";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { ServerAuthDescriptor } from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings.ts";
import { EditorId } from "./editor.ts";
import { ModelCapabilities } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerSettings } from "./settings.ts";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  isCustom: Schema.Boolean,
  capabilities: Schema.NullOr(ModelCapabilities),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

export const ServerProviderSlashCommandInput = Schema.Struct({
  hint: TrimmedNonEmptyString,
});
export type ServerProviderSlashCommandInput = typeof ServerProviderSlashCommandInput.Type;

export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(ServerProviderSlashCommandInput),
});
export type ServerProviderSlashCommand = typeof ServerProviderSlashCommand.Type;

export const ServerProviderSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderSkill = typeof ServerProviderSkill.Type;

/**
 * Availability of a configured provider instance from the runtime's POV.
 *
 *  - `available` — the build ships this driver and an instance is wired
 *    up. Default for legacy snapshots produced from the closed
 *    `ServerSettings.providers` map.
 *  - `unavailable` — the user's `ServerSettings.providerInstances` (or a
 *    persisted thread / session binding) references a driver this build
 *    doesn't ship. Common after rolling back from a fork or PR branch
 *    that introduced a new driver. The snapshot is preserved so the UI
 *    can render "missing driver" affordances and so the data round-trips
 *    when the user moves back to the fork.
 *
 * Snapshots with `availability: "unavailable"` MUST set
 * `installed: false` and `enabled: false`; the runtime refuses turn
 * starts against them with a structured error.
 */
export const ServerProviderAvailability = Schema.Literals(["available", "unavailable"]);
export type ServerProviderAvailability = typeof ServerProviderAvailability.Type;

export const ServerProviderContinuation = Schema.Struct({
  groupKey: TrimmedNonEmptyString,
});
export type ServerProviderContinuation = typeof ServerProviderContinuation.Type;

export const ServerProvider = Schema.Struct({
  // Routing key for the configured instance this snapshot represents. This
  // is the only stable identity consumers may use for provider routing.
  instanceId: ProviderInstanceId,
  // Open driver kind slug that selects the implementation handling this
  // instance. It is metadata/capability context, not a routing key.
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  badgeLabel: Schema.optional(TrimmedNonEmptyString),
  continuation: Schema.optional(ServerProviderContinuation),
  showInteractionModeToggle: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  // Optional for back-compat: every legacy producer omits this field and
  // an absent value is interpreted as `"available"` by consumers (see
  // `isProviderAvailable`). New `ProviderInstanceRegistry` outputs set it
  // explicitly so the UI can render unavailable shadows from
  // `ServerSettings.providerInstances`.
  availability: Schema.optional(ServerProviderAvailability),
  // Human-readable reason populated when `availability === "unavailable"`.
  // Surfaces in the UI alongside the missing-driver affordance.
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  slashCommands: Schema.Array(ServerProviderSlashCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  skills: Schema.Array(ServerProviderSkill).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ServerProvider = typeof ServerProvider.Type;

export const ServerProviders = Schema.Array(ServerProvider);
export type ServerProviders = typeof ServerProviders.Type;

/**
 * Treat the optional `availability` as "available" when absent. This is
 * the rule legacy producers (which omit the field) and new producers
 * (which set it explicitly) agree on so consumers never have to thread
 * `?? "available"` defaults through their code paths.
 */
export const isProviderAvailable = (snapshot: ServerProvider): boolean =>
  snapshot.availability !== "unavailable";

export const ServerObservability = Schema.Struct({
  logsDirectoryPath: TrimmedNonEmptyString,
  localTracingEnabled: Schema.Boolean,
  otlpTracesUrl: Schema.optional(TrimmedNonEmptyString),
  otlpTracesEnabled: Schema.Boolean,
  otlpMetricsUrl: Schema.optional(TrimmedNonEmptyString),
  otlpMetricsEnabled: Schema.Boolean,
});
export type ServerObservability = typeof ServerObservability.Type;

export const HistorySyncStatus = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("disabled"),
    configured: Schema.Boolean,
  }),
  Schema.Struct({
    state: Schema.Literal("needs-initial-sync"),
    configured: Schema.Boolean,
    lastSyncedAt: Schema.NullOr(IsoDateTime),
  }),
  Schema.Struct({
    state: Schema.Literal("idle"),
    configured: Schema.Boolean,
    lastSyncedAt: Schema.NullOr(IsoDateTime),
  }),
  Schema.Struct({
    state: Schema.Literal("syncing"),
    configured: Schema.Boolean,
    startedAt: IsoDateTime,
    lastSyncedAt: Schema.NullOr(IsoDateTime),
    progress: Schema.optionalKey(
      Schema.Struct({
        phase: TrimmedNonEmptyString,
        label: TrimmedNonEmptyString,
        current: NonNegativeInt,
        total: NonNegativeInt,
      }),
    ),
  }),
  Schema.Struct({
    state: Schema.Literal("retrying"),
    configured: Schema.Boolean,
    message: TrimmedNonEmptyString,
    startedAt: IsoDateTime,
    lastSyncedAt: Schema.NullOr(IsoDateTime),
    firstFailedAt: IsoDateTime,
    nextRetryAt: IsoDateTime,
    attempt: NonNegativeInt,
    maxAttempts: NonNegativeInt,
    recentFailures: Schema.Array(
      Schema.Struct({
        failedAt: IsoDateTime,
        message: TrimmedNonEmptyString,
        attempt: NonNegativeInt,
      }),
    ),
  }),
  Schema.Struct({
    state: Schema.Literal("error"),
    configured: Schema.Boolean,
    message: TrimmedNonEmptyString,
    lastSyncedAt: Schema.NullOr(IsoDateTime),
    retry: Schema.optionalKey(
      Schema.Struct({
        firstFailedAt: IsoDateTime,
        finalFailedAt: IsoDateTime,
        attempt: NonNegativeInt,
        maxAttempts: NonNegativeInt,
        recentFailures: Schema.Array(
          Schema.Struct({
            failedAt: IsoDateTime,
            message: TrimmedNonEmptyString,
            attempt: NonNegativeInt,
          }),
        ),
      }),
    ),
  }),
  Schema.Struct({
    state: Schema.Literal("needs-project-mapping"),
    configured: Schema.Boolean,
    remoteMaxSequence: NonNegativeInt,
    unresolvedProjectCount: NonNegativeInt,
    lastSyncedAt: Schema.NullOr(IsoDateTime),
  }),
]);
export type HistorySyncStatus = typeof HistorySyncStatus.Type;

export const HistorySyncProjectMappingCandidateStatus = Schema.Literals(["unresolved", "mapped"]);
export type HistorySyncProjectMappingCandidateStatus =
  typeof HistorySyncProjectMappingCandidateStatus.Type;

export const HistorySyncProjectMappingSuggestionReason = Schema.Literals([
  "exact-path",
  "basename",
]);
export type HistorySyncProjectMappingSuggestionReason =
  typeof HistorySyncProjectMappingSuggestionReason.Type;

export const HistorySyncProjectMappingCandidate = Schema.Struct({
  remoteProjectId: ProjectId,
  remoteTitle: TrimmedNonEmptyString,
  remoteWorkspaceRoot: TrimmedNonEmptyString,
  threadCount: NonNegativeInt,
  suggestedLocalProjectId: Schema.optionalKey(ProjectId),
  suggestedLocalWorkspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
  suggestionReason: Schema.optionalKey(HistorySyncProjectMappingSuggestionReason),
  status: HistorySyncProjectMappingCandidateStatus,
});
export type HistorySyncProjectMappingCandidate = typeof HistorySyncProjectMappingCandidate.Type;

export const HistorySyncProjectMappingLocalProject = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});
export type HistorySyncProjectMappingLocalProject =
  typeof HistorySyncProjectMappingLocalProject.Type;

export const HistorySyncProjectMappingAction = Schema.Union([
  Schema.Struct({
    remoteProjectId: ProjectId,
    action: Schema.Literal("map-existing"),
    localProjectId: ProjectId,
  }),
  Schema.Struct({
    remoteProjectId: ProjectId,
    action: Schema.Literal("map-folder"),
    workspaceRoot: TrimmedNonEmptyString,
    title: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    remoteProjectId: ProjectId,
    action: Schema.Literal("skip"),
  }),
]);
export type HistorySyncProjectMappingAction = typeof HistorySyncProjectMappingAction.Type;

export const HistorySyncProjectMappingPlan = Schema.Struct({
  syncId: TrimmedNonEmptyString,
  remoteMaxSequence: NonNegativeInt,
  candidates: Schema.Array(HistorySyncProjectMappingCandidate),
  localProjects: Schema.Array(HistorySyncProjectMappingLocalProject),
});
export type HistorySyncProjectMappingPlan = typeof HistorySyncProjectMappingPlan.Type;

export const HistorySyncProjectMappingsApplyInput = Schema.Struct({
  syncId: TrimmedNonEmptyString,
  actions: Schema.Array(HistorySyncProjectMappingAction),
});
export type HistorySyncProjectMappingsApplyInput = typeof HistorySyncProjectMappingsApplyInput.Type;

export const HistorySyncConnectionSummary = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: Schema.Number,
  database: TrimmedNonEmptyString,
  username: TrimmedNonEmptyString,
  tlsEnabled: Schema.Boolean,
});
export type HistorySyncConnectionSummary = typeof HistorySyncConnectionSummary.Type;

export const HistorySyncBackupSummary = Schema.Struct({
  createdAt: IsoDateTime,
  path: TrimmedNonEmptyString,
});
export type HistorySyncBackupSummary = typeof HistorySyncBackupSummary.Type;

export const HistorySyncInitialSyncRecovery = Schema.Struct({
  phase: Schema.Union([
    Schema.Literal("backup"),
    Schema.Literal("push-local"),
    Schema.Literal("push-merge"),
    Schema.Literal("import-remote"),
    Schema.Literal("write-state"),
  ]),
  startedAt: IsoDateTime,
  error: Schema.optionalKey(Schema.String),
});
export type HistorySyncInitialSyncRecovery = typeof HistorySyncInitialSyncRecovery.Type;

export const HistorySyncMysqlFields = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: Schema.Number,
  database: TrimmedNonEmptyString,
  username: TrimmedNonEmptyString,
  password: Schema.String,
  tlsEnabled: Schema.Boolean,
});
export type HistorySyncMysqlFields = typeof HistorySyncMysqlFields.Type;

export const HistorySyncConfig = Schema.Struct({
  enabled: Schema.Boolean,
  configured: Schema.Boolean,
  status: HistorySyncStatus,
  intervalMs: Schema.Number,
  shutdownFlushTimeoutMs: Schema.Number,
  statusIndicatorEnabled: Schema.Boolean,
  connectionSummary: Schema.optionalKey(HistorySyncConnectionSummary),
  backup: Schema.optionalKey(HistorySyncBackupSummary),
  initialSyncRecovery: Schema.optionalKey(HistorySyncInitialSyncRecovery),
});
export type HistorySyncConfig = typeof HistorySyncConfig.Type;

export const HistorySyncSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  intervalMs: Schema.optionalKey(Schema.Number),
  shutdownFlushTimeoutMs: Schema.optionalKey(Schema.Number),
  statusIndicatorEnabled: Schema.optionalKey(Schema.Boolean),
});
export type HistorySyncSettingsPatch = typeof HistorySyncSettingsPatch.Type;

export const HistorySyncUpdateConfigInput = Schema.Struct({
  settings: Schema.optionalKey(HistorySyncSettingsPatch),
  mysql: Schema.optionalKey(HistorySyncMysqlFields),
  clearConnection: Schema.optionalKey(Schema.Boolean),
});
export type HistorySyncUpdateConfigInput = typeof HistorySyncUpdateConfigInput.Type;

export const HistorySyncConnectionTestInput = Schema.Struct({
  mysql: HistorySyncMysqlFields,
});
export type HistorySyncConnectionTestInput = typeof HistorySyncConnectionTestInput.Type;

export const HistorySyncConnectionTestResult = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.optionalKey(TrimmedNonEmptyString),
});
export type HistorySyncConnectionTestResult = typeof HistorySyncConnectionTestResult.Type;

export class HistorySyncConfigError extends Schema.TaggedErrorClass<HistorySyncConfigError>()(
  "HistorySyncConfigError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ServerConfig = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  auth: ServerAuthDescriptor,
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  availableEditors: Schema.Array(EditorId),
  observability: ServerObservability,
  historySync: Schema.optionalKey(HistorySyncStatus).pipe(
    Schema.withDecodingDefault(Effect.succeed({ state: "disabled", configured: false })),
  ),
  settings: ServerSettings,
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviders,
  settings: Schema.optional(ServerSettings),
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerConfigKeybindingsUpdatedPayload = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerConfigKeybindingsUpdatedPayload =
  typeof ServerConfigKeybindingsUpdatedPayload.Type;

export const ServerConfigProviderStatusesPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerConfigProviderStatusesPayload = typeof ServerConfigProviderStatusesPayload.Type;

export const ServerConfigSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
export type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;

export const ServerConfigHistorySyncStatusPayload = Schema.Struct({
  historySync: HistorySyncStatus,
});
export type ServerConfigHistorySyncStatusPayload = typeof ServerConfigHistorySyncStatusPayload.Type;

export const ServerConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: ServerConfig,
});
export type ServerConfigStreamSnapshotEvent = typeof ServerConfigStreamSnapshotEvent.Type;

export const ServerConfigStreamKeybindingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
export type ServerConfigStreamKeybindingsUpdatedEvent =
  typeof ServerConfigStreamKeybindingsUpdatedEvent.Type;

export const ServerConfigStreamProviderStatusesEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerStatuses"),
  payload: ServerConfigProviderStatusesPayload,
});
export type ServerConfigStreamProviderStatusesEvent =
  typeof ServerConfigStreamProviderStatusesEvent.Type;

export const ServerConfigStreamSettingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
export type ServerConfigStreamSettingsUpdatedEvent =
  typeof ServerConfigStreamSettingsUpdatedEvent.Type;

export const ServerConfigStreamHistorySyncStatusEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("historySyncStatus"),
  payload: ServerConfigHistorySyncStatusPayload,
});
export type ServerConfigStreamHistorySyncStatusEvent =
  typeof ServerConfigStreamHistorySyncStatusEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamHistorySyncStatusEvent,
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
  environment: ExecutionEnvironmentDescriptor,
});
export type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;

export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;
