import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { laneKeyFromModel, resolveTokenCap } from "./handoff-budget.ts";
import { formatHistoryReadText, readBranchHistory } from "./history-read-tool.ts";
import {
  collectFrozenRecords,
  handoffRecordKey,
  previewHandoffForLane,
  projectMessagesForLane,
  segmentBranchIntoRuns,
  sliceActiveBranchAfterCompaction,
} from "./lane-projection.ts";
import {
  HANDOFF_ENTRY_TYPE,
  STATUS_KEY,
  TOOL_NAME_HISTORY_READ,
  WIDGET_KEY,
  type ConversationRun,
  type FrozenHandoffRecord,
  type HandoffPreview,
  type LaneKey,
  type ProjectionResult,
} from "./types.ts";
import {
  createFallbackNoticeWidget,
  createHandoffEntryRenderer,
  createPendingHandoffWidget,
  formatGreenStatusText,
  formatStatusCommandSummary,
} from "./ui-feedback.ts";

const HistoryReadParamsSchema = Type.Object({
  entryId: Type.Optional(
    Type.String({
      description:
        "Inspect a specific session entry by id (ignores view and pagination cursors).",
    }),
  ),
  textOffset: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        "Character offset when paging through a long entry selected by entryId.",
    }),
  ),
  view: Type.Optional(
    Type.Union([Type.Literal("messages"), Type.Literal("activity")], {
      description:
        'History filter: "messages" (default) for user/assistant/summary messages, or "activity" to include tool/bash executions.',
    }),
  ),
  beforePosition: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Return entries strictly before this 0-based timeline position.",
    }),
  ),
  afterPosition: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: "Return entries strictly after this 0-based timeline position.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 50,
      description: "Maximum items to return per page (1-50, default 10).",
    }),
  ),
  maxCharsPerItem: Type.Optional(
    Type.Integer({
      minimum: 200,
      maximum: 20000,
      description: "Maximum characters per returned item (200-20000, default 4000).",
    }),
  ),
});

interface BranchLaneState {
  runs: ConversationRun[];
  targetRecords: FrozenHandoffRecord[];
}

interface FeedbackEvalOptions {
  modelOverride?: ExtensionContext["model"];
  projection?: ProjectionResult;
  preview?: HandoffPreview;
  preferUsage?: boolean;
}

interface FeedbackSnapshot {
  targetLane: LaneKey | null;
  bypass: boolean;
  tokenCap: number;
  totalRuns: number;
  targetRecordCount: number;
  latestRecord: FrozenHandoffRecord | null;
  remainingTokens: number | null;
  contextWindow: number | null;
  pendingPreview: HandoffPreview | null;
}

function getTargetLane(model: ExtensionContext["model"] | undefined): LaneKey | null {
  if (!model) {
    return null;
  }
  return laneKeyFromModel(model.provider, model.id);
}

function resolveContextWindow(
  model: ExtensionContext["model"] | undefined,
  usageWindow?: number,
  fallbackWindow?: number | null,
): number | null {
  const modelWindow = model?.contextWindow;
  if (
    typeof modelWindow === "number" &&
    Number.isFinite(modelWindow) &&
    modelWindow > 0
  ) {
    return Math.floor(modelWindow);
  }
  if (
    typeof usageWindow === "number" &&
    Number.isFinite(usageWindow) &&
    usageWindow > 0
  ) {
    return Math.floor(usageWindow);
  }
  if (
    typeof fallbackWindow === "number" &&
    Number.isFinite(fallbackWindow) &&
    fallbackWindow > 0
  ) {
    return Math.floor(fallbackWindow);
  }
  return null;
}

function inspectBranchState(
  branch: SessionEntry[],
  targetLane: LaneKey | null,
  extraRecords: ReadonlyMap<string, FrozenHandoffRecord>,
): BranchLaneState {
  const activeEntries = sliceActiveBranchAfterCompaction(branch);
  const runs = segmentBranchIntoRuns(activeEntries, targetLane ?? "unknown/unknown");
  const frozenRecords = collectFrozenRecords(activeEntries, extraRecords);

  const targetRecords: FrozenHandoffRecord[] = [];
  if (targetLane) {
    for (const run of runs) {
      const rec = frozenRecords.get(handoffRecordKey(targetLane, run.userEntryId));
      if (rec) {
        targetRecords.push(rec);
      }
    }
  }

  return {
    runs,
    targetRecords,
  };
}

/**
 * Pi extension entrypoint for per-model context lanes, budgeted handoffs,
 * frozen cache-stable capsules, and on-demand thread history retrieval.
 */
export default function piModelHandoffExtension(pi: ExtensionAPI): void {
  const extraRecords = new Map<string, FrozenHandoffRecord>();
  let bypass = false;

  const clearPendingWidget = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  };

  const syncPendingWidget = (
    ctx: ExtensionContext,
    preview: HandoffPreview | null,
  ): void => {
    if (!ctx.hasUI) {
      return;
    }
    if (!bypass && preview?.willHandoff) {
      ctx.ui.setWidget(WIDGET_KEY, createPendingHandoffWidget(preview));
    } else {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  };

  const evaluateFeedbackState = (
    ctx: ExtensionContext,
    options?: FeedbackEvalOptions,
  ): FeedbackSnapshot => {
    const activeModel = options?.modelOverride ?? ctx.model;
    const targetLane = getTargetLane(activeModel);
    const tokenCap = resolveTokenCap();
    if (!targetLane || !activeModel) {
      return {
        targetLane: null,
        bypass,
        tokenCap,
        totalRuns: 0,
        targetRecordCount: 0,
        latestRecord: null,
        remainingTokens: null,
        contextWindow: null,
        pendingPreview: null,
      };
    }

    const branch = ctx.sessionManager.getBranch();
    const state = inspectBranchState(branch, targetLane, extraRecords);

    if (options?.projection) {
      const projection = options.projection;
      const latestRecord =
        projection.newRecord ??
        projection.appliedRecords[projection.appliedRecords.length - 1] ??
        state.targetRecords[state.targetRecords.length - 1] ??
        null;
      return {
        targetLane,
        bypass,
        tokenCap,
        totalRuns: projection.totalRuns,
        targetRecordCount: state.targetRecords.length,
        latestRecord,
        remainingTokens: projection.remainingContextTokens,
        contextWindow: projection.contextWindow,
        pendingPreview: null,
      };
    }

    const preview =
      options?.preview ??
      previewHandoffForLane({
        branch,
        targetLane,
        modelContextWindow: activeModel.contextWindow,
        tokenCap,
        extraRecords,
        bypass,
      });
    const usage = ctx.getContextUsage();
    const contextWindow = resolveContextWindow(
      activeModel,
      usage?.contextWindow,
      preview.contextWindow,
    );
    const rawUsageTokens = usage?.tokens;
    const hasFiniteUsage =
      typeof rawUsageTokens === "number" && Number.isFinite(rawUsageTokens);

    const usedTokens =
      !bypass && preview.willHandoff
        ? preview.projectedContextTokens
        : options?.preferUsage && hasFiniteUsage
          ? rawUsageTokens
          : preview.projectedContextTokens;
    const remainingTokens =
      contextWindow !== null && Number.isFinite(usedTokens)
        ? Math.max(0, contextWindow - usedTokens)
        : preview.remainingContextTokens;

    return {
      targetLane,
      bypass,
      tokenCap,
      totalRuns: state.runs.length,
      targetRecordCount: state.targetRecords.length,
      latestRecord:
        state.targetRecords[state.targetRecords.length - 1] ?? null,
      remainingTokens,
      contextWindow,
      pendingPreview: bypass ? null : preview,
    };
  };

  const refreshStatus = (
    ctx: ExtensionContext,
    options?: FeedbackEvalOptions,
  ): FeedbackSnapshot => {
    const feedback = evaluateFeedbackState(ctx, options);
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        STATUS_KEY,
        formatGreenStatusText(ctx.ui.theme, {
          targetLane: feedback.targetLane,
          bypass: feedback.bypass,
          remainingTokens: feedback.remainingTokens,
          contextWindow: feedback.contextWindow,
          latestRecord: feedback.latestRecord,
          pendingPreview: feedback.pendingPreview,
        }),
      );
    }
    return feedback;
  };

  pi.registerEntryRenderer<FrozenHandoffRecord>(
    HANDOFF_ENTRY_TYPE,
    createHandoffEntryRenderer(),
  );

  pi.registerTool({
    name: TOOL_NAME_HISTORY_READ,
    label: "Thread History Read",
    description:
      "Read full or paginated messages and activity from the current session branch when prior turns were summarized or truncated by a model handoff.",
    promptSnippet:
      "Pull omitted or truncated earlier messages and tool activity from the session branch",
    promptGuidelines: [
      `When a handoff capsule omits or truncates an entry you need, call ${TOOL_NAME_HISTORY_READ} with entryId (or paginate with view/beforePosition/afterPosition) instead of guessing.`,
    ],
    parameters: HistoryReadParamsSchema,
    annotations: {
      readOnlyHint: true,
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = readBranchHistory(ctx.sessionManager.getBranch(), params);
      return {
        content: [{ type: "text", text: formatHistoryReadText(result) }],
        details: result,
      };
    },
  });

  pi.on("context", (event, ctx) => {
    const targetLane = getTargetLane(ctx.model);
    if (!targetLane || !ctx.model) {
      clearPendingWidget(ctx);
      refreshStatus(ctx);
      return undefined;
    }

    const result = projectMessagesForLane({
      eventMessages: event.messages,
      branch: ctx.sessionManager.getBranch(),
      targetLane,
      modelContextWindow: ctx.model.contextWindow,
      tokenCap: resolveTokenCap(),
      extraRecords,
      bypass,
    });

    if (result.newRecord) {
      const key = handoffRecordKey(
        result.newRecord.targetLane,
        result.newRecord.anchorUserEntryId,
      );
      extraRecords.set(key, result.newRecord);
      pi.appendEntry(HANDOFF_ENTRY_TYPE, result.newRecord);
      clearPendingWidget(ctx);
    } else if (result.fallbackResetNoRecord) {
      if (ctx.hasUI) {
        ctx.ui.setWidget(
          WIDGET_KEY,
          createFallbackNoticeWidget(
            targetLane,
            result.remainingContextTokens,
            result.contextWindow,
          ),
        );
      }
    } else {
      clearPendingWidget(ctx);
    }

    refreshStatus(ctx, { modelOverride: ctx.model, projection: result });

    if (result.modified) {
      return { messages: result.messages };
    }
    return undefined;
  });

  pi.on("agent_end", (_event, ctx) => {
    refreshStatus(ctx, { preferUsage: true });
  });

  pi.on("session_start", (_event, ctx) => {
    extraRecords.clear();
    bypass = false;
    clearPendingWidget(ctx);
    refreshStatus(ctx, { preferUsage: true });
  });

  pi.on("session_tree", (_event, ctx) => {
    extraRecords.clear();
    clearPendingWidget(ctx);
    refreshStatus(ctx, { preferUsage: true });
  });

  pi.on("session_compact", (_event, ctx) => {
    extraRecords.clear();
    clearPendingWidget(ctx);
    refreshStatus(ctx, { preferUsage: true });
  });

  pi.on("model_select", (event, ctx) => {
    const previousLane = getTargetLane(event.previousModel);
    const nextLane = getTargetLane(event.model);
    if (previousLane === nextLane) {
      refreshStatus(ctx, { modelOverride: event.model, preferUsage: true });
      return;
    }

    if (bypass || !nextLane) {
      clearPendingWidget(ctx);
      refreshStatus(ctx, { modelOverride: event.model });
      return;
    }

    const preview = previewHandoffForLane({
      branch: ctx.sessionManager.getBranch(),
      targetLane: nextLane,
      modelContextWindow: event.model.contextWindow,
      tokenCap: resolveTokenCap(),
      extraRecords,
      bypass,
    });
    syncPendingWidget(ctx, preview);
    refreshStatus(ctx, { modelOverride: event.model, preview });
  });

  pi.registerCommand("handoff-status", {
    description:
      "Show current model lane and handoff summary, or toggle bypass with on/off",
    getArgumentCompletions(argumentPrefix) {
      const options = [
        { value: "on", label: "on", description: "Enable model handoff (bypass off)" },
        { value: "off", label: "off", description: "Bypass model handoff (pass-through)" },
        { value: "bypass", label: "bypass", description: "Toggle bypass mode" },
      ];
      const prefix = argumentPrefix.trim().toLowerCase();
      const filtered = options.filter((opt) => opt.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    async handler(args, ctx) {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "bypass off") {
        bypass = false;
        const feedback = refreshStatus(ctx, { preferUsage: true });
        syncPendingWidget(ctx, feedback.pendingPreview);
        if (ctx.hasUI) {
          ctx.ui.notify("模型交接已启用（bypass=off）。", "info");
        }
        return;
      }
      if (arg === "off" || arg === "bypass on") {
        bypass = true;
        clearPendingWidget(ctx);
        refreshStatus(ctx, { preferUsage: true });
        if (ctx.hasUI) {
          ctx.ui.notify("模型交接已暂停（直通模式，bypass=on）。", "info");
        }
        return;
      }
      if (arg === "bypass" || arg === "toggle") {
        bypass = !bypass;
        const feedback = refreshStatus(ctx, { preferUsage: true });
        syncPendingWidget(ctx, feedback.pendingPreview);
        if (ctx.hasUI) {
          ctx.ui.notify(
            bypass
              ? "模型交接已暂停（直通模式，bypass=on）。"
              : "模型交接已启用（bypass=off）。",
            "info",
          );
        }
        return;
      }
      if (arg.length > 0 && arg !== "status") {
        if (ctx.hasUI) {
          ctx.ui.notify("用法: /handoff-status [on|off|bypass]", "info");
        }
        return;
      }

      const feedback = refreshStatus(ctx, { preferUsage: true });
      if (ctx.hasUI) {
        ctx.ui.notify(formatStatusCommandSummary(feedback), "info");
      }
    },
  });
}
