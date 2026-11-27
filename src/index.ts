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
  projectMessagesForLane,
  segmentBranchIntoRuns,
  sliceActiveBranchAfterCompaction,
} from "./lane-projection.ts";
import {
  HANDOFF_ENTRY_TYPE,
  STATUS_KEY,
  TOOL_NAME_HISTORY_READ,
  type ConversationRun,
  type FrozenHandoffRecord,
  type LaneKey,
  type ProjectionResult,
} from "./types.ts";

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
  frozenRecords: Map<string, FrozenHandoffRecord>;
  targetRecords: FrozenHandoffRecord[];
  lastDeliveredRun: ConversationRun | null;
  pendingFromLane: LaneKey | null;
}

function getTargetLane(model: ExtensionContext["model"]): LaneKey | null {
  if (!model) {
    return null;
  }
  return laneKeyFromModel(model.provider, model.id);
}

function formatStrategyTag(record: FrozenHandoffRecord): string {
  if (record.strategy === "delta_since_target_last_seen") {
    return "delta";
  }
  return record.fallbackReset ? "reset" : "full";
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

  let lastDeliveredRun: ConversationRun | null = null;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].delivered && runs[i].ownerLane !== null) {
      lastDeliveredRun = runs[i];
      break;
    }
  }

  let pendingFromLane: LaneKey | null = null;
  if (
    targetLane &&
    runs.length > 0 &&
    lastDeliveredRun &&
    lastDeliveredRun.ownerLane !== null &&
    lastDeliveredRun.ownerLane !== targetLane
  ) {
    const anchorRun = runs[runs.length - 1];
    const hasAnchorRecord = frozenRecords.has(
      handoffRecordKey(targetLane, anchorRun.userEntryId),
    );
    if (!hasAnchorRecord) {
      pendingFromLane = lastDeliveredRun.ownerLane;
    }
  }

  return {
    runs,
    frozenRecords,
    targetRecords,
    lastDeliveredRun,
    pendingFromLane,
  };
}

function formatStatusLine(
  targetLane: LaneKey | null,
  bypass: boolean,
  state: BranchLaneState,
  projection?: ProjectionResult,
): string | undefined {
  if (!targetLane) {
    return bypass ? "handoff: bypass" : undefined;
  }
  if (bypass) {
    return `handoff: ${targetLane} [bypass]`;
  }

  if (projection) {
    if (projection.appliedRecords.length > 0) {
      const latest =
        projection.appliedRecords[projection.appliedRecords.length - 1];
      return `handoff: ${targetLane} (${formatStrategyTag(latest)}, ${projection.keptNativeRuns}/${projection.totalRuns}r)`;
    }
    return projection.totalRuns > 0
      ? `handoff: ${targetLane} (${projection.totalRuns}r)`
      : `handoff: ${targetLane}`;
  }

  if (state.targetRecords.length > 0) {
    const latest = state.targetRecords[state.targetRecords.length - 1];
    return `handoff: ${targetLane} (${formatStrategyTag(latest)}, ${state.runs.length}r)`;
  }
  if (state.pendingFromLane) {
    return `handoff: ${targetLane} (switch←${state.pendingFromLane})`;
  }
  return state.runs.length > 0
    ? `handoff: ${targetLane} (${state.runs.length}r)`
    : `handoff: ${targetLane}`;
}

function formatCommandSummary(
  targetLane: LaneKey | null,
  bypass: boolean,
  tokenCap: number,
  state: BranchLaneState,
): string {
  const lines: string[] = [
    `Lane: ${targetLane ?? "(none)"}`,
    `Mode: ${bypass ? "bypass (off)" : "active (on)"}`,
    `Token cap: ${tokenCap}`,
    `Active runs: ${state.runs.length}${state.lastDeliveredRun?.ownerLane ? ` (last delivered: ${state.lastDeliveredRun.ownerLane})` : ""}`,
    `Frozen records: ${state.targetRecords.length} on lane / ${state.frozenRecords.size} total`,
  ];

  if (state.targetRecords.length > 0) {
    const latest = state.targetRecords[state.targetRecords.length - 1];
    lines.push(
      `Latest handoff: ${latest.strategy}${latest.fallbackReset ? " [fallback-reset]" : ""} from ${latest.fromLane ?? "none"}, runs ${latest.coveredRunFrom}..${latest.coveredRunTo}, included=${latest.includedCount}, omitted=${latest.omittedCount}, ~${latest.estimatedTokens} tok`,
    );
  } else if (state.pendingFromLane) {
    lines.push(
      `Pending handoff: next turn will project from ${state.pendingFromLane} to ${targetLane}`,
    );
  }

  return lines.join("\n");
}

/**
 * Pi extension entrypoint for per-model context lanes, budgeted handoffs,
 * frozen cache-stable capsules, and on-demand thread history retrieval.
 */
export default function piModelHandoffExtension(pi: ExtensionAPI): void {
  const extraRecords = new Map<string, FrozenHandoffRecord>();
  let bypass = false;

  const refreshStatus = (
    ctx: ExtensionContext,
    modelOverride?: ExtensionContext["model"],
    projection?: ProjectionResult,
  ): void => {
    if (!ctx.hasUI) {
      return;
    }
    const targetLane = getTargetLane(modelOverride ?? ctx.model);
    const state = inspectBranchState(
      ctx.sessionManager.getBranch(),
      targetLane,
      extraRecords,
    );
    ctx.ui.setStatus(
      STATUS_KEY,
      formatStatusLine(targetLane, bypass, state, projection),
    );
  };

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

      if (ctx.hasUI) {
        ctx.ui.notify(
          `Handoff → ${result.newRecord.targetLane} (${formatStrategyTag(result.newRecord)}, from ${result.newRecord.fromLane ?? "none"}, ~${result.newRecord.estimatedTokens} tok)`,
          "info",
        );
      }
    }

    refreshStatus(ctx, ctx.model, result);

    if (result.modified) {
      return { messages: result.messages };
    }
    return undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    extraRecords.clear();
    refreshStatus(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    extraRecords.clear();
    refreshStatus(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    extraRecords.clear();
    refreshStatus(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    refreshStatus(ctx, event.model);
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
        refreshStatus(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify("Model handoff enabled (bypass=off).", "info");
        }
        return;
      }
      if (arg === "off" || arg === "bypass on") {
        bypass = true;
        refreshStatus(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify("Model handoff bypassed (bypass=on).", "warning");
        }
        return;
      }
      if (arg === "bypass" || arg === "toggle") {
        bypass = !bypass;
        refreshStatus(ctx);
        if (ctx.hasUI) {
          ctx.ui.notify(
            bypass
              ? "Model handoff bypassed (bypass=on)."
              : "Model handoff enabled (bypass=off).",
            bypass ? "warning" : "info",
          );
        }
        return;
      }
      if (arg.length > 0 && arg !== "status") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Usage: /handoff-status [on|off|bypass]",
            "warning",
          );
        }
        return;
      }

      const targetLane = getTargetLane(ctx.model);
      const state = inspectBranchState(
        ctx.sessionManager.getBranch(),
        targetLane,
        extraRecords,
      );
      refreshStatus(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(
          formatCommandSummary(targetLane, bypass, resolveTokenCap(), state),
          "info",
        );
      }
    },
  });
}
