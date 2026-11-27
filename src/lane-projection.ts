import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  CompactionEntry,
  ContextEditEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  computeHandoffBudget,
  estimateTextTokens,
  extractHistoricalItems,
  laneKeyFromModel,
  selectAndRenderHandoff,
} from "./handoff-budget.ts";
import {
  HANDOFF_ENTRY_TYPE,
  MIN_DELTA_BUDGET_BYTES,
  type ConversationRun,
  type FrozenHandoffRecord,
  type HandoffPreview,
  type HandoffPreviewInput,
  type HandoffStrategy,
  type LaneKey,
  type ProjectMessagesInput,
  type ProjectionResult,
} from "./types.ts";

const IMAGE_ESTIMATE_TOKENS = 256;

export function handoffRecordKey(
  targetLane: LaneKey,
  anchorUserEntryId: string,
): string {
  return `${targetLane}::${anchorUserEntryId}`;
}

/**
 * Slice the session branch starting at the latest compaction checkpoint while
 * preserving any pre-compaction entries kept via `firstKeptEntryId` so the
 * resulting entry list aligns with Pi's `buildContextEntries`.
 */
export function sliceActiveBranchAfterCompaction(
  branch: SessionEntry[],
): SessionEntry[] {
  let compactionIdx = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      compactionIdx = i;
      break;
    }
  }
  if (compactionIdx < 0) {
    return branch.slice();
  }

  const compaction = branch[compactionIdx] as CompactionEntry;
  const active: SessionEntry[] = [compaction];

  if (compaction.firstKeptEntryId && compaction.firstKeptEntryId !== compaction.id) {
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = branch[i];
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (
        foundFirstKept &&
        entry.type !== "compaction" &&
        !(entry.type === "message" && entry.message.role === "system")
      ) {
        active.push(entry);
      }
    }
  }

  for (let i = compactionIdx + 1; i < branch.length; i++) {
    active.push(branch[i]);
  }
  return active;
}

function isUserMessageEntry(
  entry: SessionEntry,
): entry is SessionMessageEntry & { message: UserMessage } {
  return entry.type === "message" && entry.message?.role === "user";
}

function collectContextEditsByTarget(
  entries: readonly SessionEntry[],
): Map<string, ContextEditEntry> {
  const editsByTarget = new Map<string, ContextEditEntry>();
  for (const entry of entries) {
    if (entry.type === "context_edit") {
      editsByTarget.set(entry.targetId, entry);
    }
  }
  return editsByTarget;
}

function isValidAssistantMessage(msg: AssistantMessage): boolean {
  return (
    msg.stopReason !== "error" &&
    msg.stopReason !== "aborted" &&
    msg.stopReason !== "pending" &&
    msg.stopReason !== "deferred"
  );
}

function extractUsageInputTokens(msg: AssistantMessage): number | undefined {
  const usage = msg.usage;
  if (!usage) return undefined;
  const inputSum =
    (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (inputSum > 0) return inputSum;
  return usage.totalTokens > 0 ? usage.totalTokens : undefined;
}

/**
 * Segment active branch entries into user-turn runs. Each run's `ownerLane` is
 * determined by its last assistant message; `error`/`aborted` runs are marked
 * `delivered=false, hasError=true` with their model lane preserved, and the
 * current unfinished run without an assistant response belongs to `currentLane`.
 */
export function segmentBranchIntoRuns(
  activeEntries: SessionEntry[],
  currentLane: LaneKey,
): ConversationRun[] {
  const editsByTarget = collectContextEditsByTarget(activeEntries);
  const userIndices: number[] = [];
  for (let i = 0; i < activeEntries.length; i++) {
    if (isUserMessageEntry(activeEntries[i])) {
      userIndices.push(i);
    }
  }

  const runs: ConversationRun[] = [];
  for (let r = 0; r < userIndices.length; r++) {
    const startIndex = userIndices[r];
    const endIndex =
      r + 1 < userIndices.length
        ? userIndices[r + 1] - 1
        : activeEntries.length - 1;
    const entries = activeEntries.slice(startIndex, endIndex + 1);
    const userEntry = activeEntries[startIndex] as SessionMessageEntry;

    let lastAssistant: AssistantMessage | null = null;
    let lastAssistantWithModel: AssistantMessage | null = null;

    for (const entry of entries) {
      if (entry.type !== "message" || entry.message?.role !== "assistant") {
        continue;
      }
      if (editsByTarget.get(entry.id)?.replacement === null) {
        continue;
      }
      const assistant = entry.message as AssistantMessage;
      lastAssistant = assistant;
      if (assistant.provider && assistant.model) {
        lastAssistantWithModel = assistant;
      }
    }

    const isLastRun = r === userIndices.length - 1;
    let ownerLane: LaneKey | null = null;
    let delivered = false;
    let hasError = false;
    let lastUsageInputTokens: number | undefined;

    if (lastAssistant) {
      if (
        lastAssistant.stopReason === "error" ||
        lastAssistant.stopReason === "aborted"
      ) {
        delivered = false;
        hasError = true;
        const laneSource =
          lastAssistant.provider && lastAssistant.model
            ? lastAssistant
            : lastAssistantWithModel;
        ownerLane =
          laneSource && laneSource.provider && laneSource.model
            ? laneKeyFromModel(laneSource.provider, laneSource.model)
            : null;
      } else if (isValidAssistantMessage(lastAssistant)) {
        ownerLane =
          lastAssistant.provider && lastAssistant.model
            ? laneKeyFromModel(lastAssistant.provider, lastAssistant.model)
            : currentLane;
        delivered = true;
        lastUsageInputTokens = extractUsageInputTokens(lastAssistant);
      } else {
        delivered = false;
        hasError = false;
        const laneSource =
          lastAssistant.provider && lastAssistant.model
            ? lastAssistant
            : lastAssistantWithModel;
        ownerLane = isLastRun
          ? currentLane
          : laneSource && laneSource.provider && laneSource.model
            ? laneKeyFromModel(laneSource.provider, laneSource.model)
            : null;
      }
    } else if (isLastRun) {
      ownerLane = currentLane;
      delivered = false;
    }

    runs.push({
      ordinal: r + 1,
      userEntryId: userEntry.id,
      startIndex,
      endIndex,
      ownerLane,
      delivered,
      hasError,
      entries,
      ...(lastUsageInputTokens !== undefined ? { lastUsageInputTokens } : {}),
    });
  }

  return runs;
}

function isFrozenHandoffRecord(value: unknown): value is FrozenHandoffRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FrozenHandoffRecord>;
  return (
    candidate.version === 1 &&
    typeof candidate.targetLane === "string" &&
    typeof candidate.anchorUserEntryId === "string" &&
    typeof candidate.renderedText === "string" &&
    (candidate.strategy === "full_thread_summary" ||
      candidate.strategy === "delta_since_target_last_seen")
  );
}

/**
 * Collect frozen handoff records from active entries (and optional in-memory extras).
 * Always preserves the first record per `(targetLane, anchorUserEntryId)` to keep
 * prompt-cache prefixes stable.
 */
export function collectFrozenRecords(
  activeEntries: SessionEntry[],
  extraRecords?: ReadonlyMap<string, FrozenHandoffRecord>,
): Map<string, FrozenHandoffRecord> {
  const records = new Map<string, FrozenHandoffRecord>();

  for (const entry of activeEntries) {
    if (entry.type !== "custom" || entry.customType !== HANDOFF_ENTRY_TYPE) {
      continue;
    }
    if (!isFrozenHandoffRecord(entry.data)) {
      continue;
    }
    const key = handoffRecordKey(
      entry.data.targetLane,
      entry.data.anchorUserEntryId,
    );
    if (!records.has(key)) {
      records.set(key, entry.data);
    }
  }

  if (extraRecords) {
    for (const record of extraRecords.values()) {
      if (!isFrozenHandoffRecord(record)) {
        continue;
      }
      const key = handoffRecordKey(record.targetLane, record.anchorUserEntryId);
      if (!records.has(key)) {
        records.set(key, record);
      }
    }
  }

  return records;
}

function extractUserContentSummary(
  content: UserMessage["content"] | null | undefined,
): { text: string; imageCount: number; otherAttachmentCount: number } {
  if (typeof content === "string") {
    return { text: content, imageCount: 0, otherAttachmentCount: 0 };
  }
  if (!Array.isArray(content)) {
    return { text: "", imageCount: 0, otherAttachmentCount: 0 };
  }
  const textParts: string[] = [];
  let imageCount = 0;
  let otherAttachmentCount = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type === "text") {
      if (typeof block.text === "string") {
        textParts.push(block.text);
      }
    } else if (block.type === "image") {
      imageCount += 1;
    } else {
      otherAttachmentCount += 1;
    }
  }
  return {
    text: textParts.join("\n"),
    imageCount,
    otherAttachmentCount,
  };
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function estimateContentBlocksTokens(
  content:
    | string
    | readonly (
        | TextContent
        | ImageContent
        | { type: string; text?: string; name?: string; arguments?: unknown }
      )[]
    | null
    | undefined,
): number {
  if (typeof content === "string") {
    return estimateTextTokens(content);
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let tokens = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      tokens += estimateTextTokens(block.text);
    } else if (block.type === "image") {
      tokens += IMAGE_ESTIMATE_TOKENS;
    } else if (block.type === "thinking") {
      const thinkingText = (block as { thinking?: unknown }).thinking;
      if (typeof thinkingText === "string") {
        tokens += estimateTextTokens(thinkingText);
      }
    } else if (block.type === "toolCall") {
      const call = block as { name?: string; arguments?: unknown };
      tokens += estimateTextTokens(
        `${call.name ?? ""}${JSON.stringify(call.arguments ?? {})}`,
      );
    }
  }
  return tokens;
}

function estimateAgentMessageTokens(msg: AgentMessage): number {
  if (!msg || typeof msg !== "object") {
    return 0;
  }
  switch (msg.role) {
    case "user":
    case "assistant":
    case "toolResult":
    case "custom":
      return estimateContentBlocksTokens(msg.content);
    case "compactionSummary":
    case "branchSummary":
      return typeof msg.summary === "string" ? estimateTextTokens(msg.summary) : 0;
    case "bashExecution":
      return estimateTextTokens(
        `${typeof msg.command === "string" ? msg.command : ""}\n${typeof msg.output === "string" ? msg.output : ""}`,
      );
    default:
      return 0;
  }
}

function buildItemsWithOptionalPreRun(
  activeEntries: SessionEntry[],
  firstRunStart: number,
  targetRuns: ConversationRun[],
  includePreRun: boolean,
) {
  if (!includePreRun) {
    return extractHistoricalItems(targetRuns);
  }
  const preRunEntries = activeEntries.slice(0, firstRunStart);
  return extractHistoricalItems(targetRuns, preRunEntries);
}

function normalizeContextWindow(modelContextWindow?: number): number | null {
  if (
    modelContextWindow !== undefined &&
    Number.isFinite(modelContextWindow) &&
    modelContextWindow > 0
  ) {
    return Math.floor(modelContextWindow);
  }
  return null;
}

function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateAgentMessageTokens(msg);
  }
  return total;
}

function estimateSessionEntryTokens(
  entry: SessionEntry,
  editsByTarget: ReadonlyMap<string, ContextEditEntry>,
): number {
  if (!entry || typeof entry !== "object") {
    return 0;
  }
  const edit = editsByTarget.get(entry.id);
  if (edit?.replacement === null) {
    return 0;
  }
  if (entry.type === "message") {
    const baseMsg = entry.message as AgentMessage;
    if (edit?.replacement) {
      const replacement = edit.replacement as {
        content?: unknown;
      };
      if (
        replacement.content !== undefined &&
        (baseMsg.role === "user" ||
          baseMsg.role === "assistant" ||
          baseMsg.role === "toolResult" ||
          baseMsg.role === "custom")
      ) {
        return estimateContentBlocksTokens(
          replacement.content as UserMessage["content"],
        );
      }
    }
    return estimateAgentMessageTokens(baseMsg);
  }
  if (entry.type === "custom_message") {
    if (entry.customType === HANDOFF_ENTRY_TYPE) {
      return 0;
    }
    return estimateContentBlocksTokens(
      entry.content as UserMessage["content"],
    );
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return typeof entry.summary === "string"
      ? estimateTextTokens(entry.summary)
      : 0;
  }
  return 0;
}

function runHasConversationOrToolActivity(
  run: ConversationRun,
  editsByTarget: ReadonlyMap<string, ContextEditEntry>,
): boolean {
  if (run.delivered || run.hasError) {
    return true;
  }
  for (const entry of run.entries) {
    if (entry.type !== "message") {
      continue;
    }
    if (editsByTarget.get(entry.id)?.replacement === null) {
      continue;
    }
    const msg = entry.message;
    if (!msg) {
      continue;
    }
    if (msg.role === "assistant" || msg.role === "toolResult") {
      return true;
    }
    if (msg.role === "bashExecution" && !msg.excludeFromContext) {
      return true;
    }
  }
  return false;
}

interface PreRunContextInfo {
  entries: SessionEntry[];
  hasContext: boolean;
  ownerLane: LaneKey | null;
}

function inspectPreRunContext(
  activeEntries: SessionEntry[],
  firstRunStart: number,
  editsByTarget: ReadonlyMap<string, ContextEditEntry>,
): PreRunContextInfo {
  const entries = activeEntries.slice(0, firstRunStart);
  let hasContext = false;
  let lastAssistant: AssistantMessage | null = null;
  let lastAssistantWithModel: AssistantMessage | null = null;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (typeof entry.summary === "string" && entry.summary.trim().length > 0) {
        hasContext = true;
      }
      continue;
    }
    if (entry.type === "custom_message") {
      if (entry.customType !== HANDOFF_ENTRY_TYPE) {
        hasContext = true;
      }
      continue;
    }
    if (entry.type !== "message") {
      continue;
    }
    if (editsByTarget.get(entry.id)?.replacement === null) {
      continue;
    }
    const msg = entry.message;
    if (!msg) {
      continue;
    }
    if (msg.role === "assistant") {
      hasContext = true;
      const assistant = msg as AssistantMessage;
      lastAssistant = assistant;
      if (assistant.provider && assistant.model) {
        lastAssistantWithModel = assistant;
      }
    } else if (
      msg.role === "toolResult" ||
      msg.role === "compactionSummary" ||
      msg.role === "branchSummary" ||
      (msg.role === "bashExecution" && !msg.excludeFromContext) ||
      (msg.role === "custom" && msg.customType !== HANDOFF_ENTRY_TYPE)
    ) {
      hasContext = true;
    }
  }

  let ownerLane: LaneKey | null = null;
  const laneSource =
    lastAssistant && lastAssistant.provider && lastAssistant.model
      ? lastAssistant
      : lastAssistantWithModel;
  if (laneSource && laneSource.provider && laneSource.model) {
    ownerLane = laneKeyFromModel(laneSource.provider, laneSource.model);
  }

  return {
    entries,
    hasContext,
    ownerLane,
  };
}

interface AlignedMessageSlice {
  run: ConversationRun | null;
  messages: AgentMessage[];
}

/**
 * Align `eventMessages` (which may have string or ContentBlock[] user contents,
 * context edits, or trailing unsaved messages) against branch `runs`.
 */
function alignEventMessagesToRuns(
  eventMessages: AgentMessage[],
  activeEntries: SessionEntry[],
  runs: ConversationRun[],
): {
  preRunMessages: AgentMessage[];
  slices: AlignedMessageSlice[];
  runIndexByOrdinal: Map<number, number>;
} {
  const editsByTarget = collectContextEditsByTarget(activeEntries);

  const expectedRuns = runs.filter((run) => {
    const edit = editsByTarget.get(run.userEntryId);
    return !edit || edit.replacement !== null;
  });

  const userMsgPositions: number[] = [];
  for (let i = 0; i < eventMessages.length; i++) {
    if (eventMessages[i]?.role === "user") {
      userMsgPositions.push(i);
    }
  }

  const preRunMessages =
    userMsgPositions.length > 0
      ? eventMessages.slice(0, userMsgPositions[0])
      : eventMessages.slice();

  const matchedRunForUserMsg = new Array<ConversationRun | null>(
    userMsgPositions.length,
  ).fill(null);

  if (userMsgPositions.length === expectedRuns.length) {
    for (let i = 0; i < userMsgPositions.length; i++) {
      matchedRunForUserMsg[i] = expectedRuns[i];
    }
  } else if (userMsgPositions.length > 0 && expectedRuns.length > 0) {
    // Monotonic DP alignment scored by timestamp + normalized user text match.
    const m = userMsgPositions.length;
    const n = expectedRuns.length;

    const msgMeta = userMsgPositions.map((pos) => {
      const userMsg = eventMessages[pos] as UserMessage;
      return {
        timestamp: userMsg.timestamp,
        text: normalizeText(extractUserContentSummary(userMsg.content).text),
      };
    });

    const runMeta = expectedRuns.map((run) => {
      const userEntry = activeEntries[run.startIndex] as SessionMessageEntry & {
        message: UserMessage;
      };
      const edit = editsByTarget.get(run.userEntryId);
      const effectiveContent =
        edit?.replacement && typeof edit.replacement.content !== "undefined"
          ? (edit.replacement.content as UserMessage["content"])
          : userEntry.message?.content;
      return {
        timestamp: userEntry.message.timestamp,
        text: normalizeText(extractUserContentSummary(effectiveContent).text),
      };
    });

    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      new Array<number>(n + 1).fill(0),
    );
    const choice: number[][] = Array.from({ length: m + 1 }, () =>
      new Array<number>(n + 1).fill(0),
    );

    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        let pairScore = 0;
        if (msgMeta[i].timestamp === runMeta[j].timestamp) {
          pairScore += 4;
        }
        if (msgMeta[i].text === runMeta[j].text) {
          pairScore += 2;
        }

        const matchVal = pairScore > 0 ? pairScore + dp[i + 1][j + 1] : -1;
        const skipMsgVal = dp[i + 1][j];
        const skipRunVal = dp[i][j + 1];

        if (matchVal >= skipMsgVal && matchVal >= skipRunVal && pairScore > 0) {
          dp[i][j] = matchVal;
          choice[i][j] = 1;
        } else if (skipMsgVal >= skipRunVal) {
          dp[i][j] = skipMsgVal;
          choice[i][j] = 2;
        } else {
          dp[i][j] = skipRunVal;
          choice[i][j] = 3;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (choice[i][j] === 1) {
        matchedRunForUserMsg[i] = expectedRuns[j];
        i += 1;
        j += 1;
      } else if (choice[i][j] === 2) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }

  const slices: AlignedMessageSlice[] = [];
  const runIndexByOrdinal = new Map<number, number>();
  for (let u = 0; u < userMsgPositions.length; u++) {
    const start = userMsgPositions[u];
    const end =
      u + 1 < userMsgPositions.length
        ? userMsgPositions[u + 1]
        : eventMessages.length;
    const run = matchedRunForUserMsg[u];
    const sliceIdx = slices.length;
    slices.push({
      run,
      messages: eventMessages.slice(start, end),
    });
    if (run) {
      runIndexByOrdinal.set(run.ordinal, sliceIdx);
    }
  }

  return { preRunMessages, slices, runIndexByOrdinal };
}

function inlineHandoffIntoUserMessage(
  msg: UserMessage,
  renderedText: string,
): { message: UserMessage; changed: boolean } {
  if (!renderedText) {
    return { message: msg, changed: false };
  }

  if (typeof msg.content === "string") {
    if (msg.content.startsWith(renderedText)) {
      return { message: msg, changed: false };
    }
    const nextContent = msg.content
      ? `${renderedText}\n\n${msg.content}`
      : renderedText;
    return {
      message: {
        ...msg,
        content: nextContent,
      },
      changed: true,
    };
  }

  const handoffBlock: TextContent = {
    type: "text",
    text: renderedText,
  };

  if (!Array.isArray(msg.content)) {
    return {
      message: {
        ...msg,
        content: [handoffBlock],
      },
      changed: true,
    };
  }

  const first = msg.content[0];
  if (
    first?.type === "text" &&
    typeof first.text === "string" &&
    first.text.startsWith(renderedText)
  ) {
    return { message: msg, changed: false };
  }

  return {
    message: {
      ...msg,
      content: [handoffBlock, ...msg.content],
    },
    changed: true,
  };
}

function dropOrphanedToolResults(
  messages: AgentMessage[],
): { messages: AgentMessage[]; dropped: boolean } {
  const result: AgentMessage[] = [];
  const activeToolCallIds = new Set<string>();
  let dropped = false;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    if (msg.role === "assistant") {
      activeToolCallIds.clear();
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block &&
            typeof block === "object" &&
            block.type === "toolCall" &&
            typeof block.id === "string"
          ) {
            activeToolCallIds.add(block.id);
          }
        }
      }
      result.push(msg);
      continue;
    }

    if (msg.role === "toolResult") {
      const toolResult = msg as ToolResultMessage;
      if (
        typeof toolResult.toolCallId === "string" &&
        activeToolCallIds.has(toolResult.toolCallId)
      ) {
        result.push(msg);
      } else {
        dropped = true;
      }
      continue;
    }

    activeToolCallIds.clear();
    result.push(msg);
  }

  return { messages: result, dropped };
}

interface KeepSetPlan {
  effectiveStartOrdinal: number;
  omitPreRunMessages: boolean;
  omittedOrdinals: Set<number>;
  recordByRunOrdinal: Map<number, FrozenHandoffRecord>;
}

function computeKeepSetAndEffectiveRecords(params: {
  runs: ConversationRun[];
  anchorOrdinal: number;
  anchorUserEntryId: string;
  targetLane: LaneKey;
  frozenRecords: ReadonlyMap<string, FrozenHandoffRecord>;
  fallbackResetNoRecord?: boolean;
}): KeepSetPlan {
  const {
    runs,
    anchorOrdinal,
    anchorUserEntryId,
    targetLane,
    frozenRecords,
    fallbackResetNoRecord = false,
  } = params;
  const recordByRunOrdinal = new Map<number, FrozenHandoffRecord>();
  const omittedOrdinals = new Set<number>();

  if (fallbackResetNoRecord) {
    for (const run of runs) {
      if (run.ordinal < anchorOrdinal) {
        omittedOrdinals.add(run.ordinal);
      }
    }
    return {
      effectiveStartOrdinal: anchorOrdinal,
      omitPreRunMessages: true,
      omittedOrdinals,
      recordByRunOrdinal,
    };
  }

  let effectiveStartOrdinal = 1;
  let omitPreRunMessages = false;

  const applyRecordCoverage = (
    recOrdinal: number,
    rec: FrozenHandoffRecord,
  ): void => {
    recordByRunOrdinal.set(recOrdinal, rec);
    if (rec.strategy === "full_thread_summary" || rec.fallbackReset) {
      effectiveStartOrdinal = Math.max(effectiveStartOrdinal, recOrdinal);
      omitPreRunMessages = true;
      for (const prior of runs) {
        if (prior.ordinal < recOrdinal) {
          omittedOrdinals.add(prior.ordinal);
        }
      }
      return;
    }

    // Delta record covers all runs strictly between the last delivered run on
    // targetLane before recOrdinal and recOrdinal itself (regardless of delivered).
    let lastTargetOrdinal = 0;
    for (let i = runs.length - 1; i >= 0; i--) {
      const candidate = runs[i];
      if (
        candidate.ordinal < recOrdinal &&
        candidate.delivered &&
        candidate.ownerLane === targetLane
      ) {
        lastTargetOrdinal = candidate.ordinal;
        break;
      }
    }
    for (const prior of runs) {
      if (prior.ordinal > lastTargetOrdinal && prior.ordinal < recOrdinal) {
        omittedOrdinals.add(prior.ordinal);
      }
    }
  };

  for (const run of runs) {
    if (run.ordinal > anchorOrdinal) {
      continue;
    }
    const rec = frozenRecords.get(handoffRecordKey(targetLane, run.userEntryId));
    if (rec) {
      applyRecordCoverage(run.ordinal, rec);
    }
  }

  // Handle a synthetic preview anchor not present in `runs`.
  if (!runs.some((run) => run.ordinal === anchorOrdinal)) {
    const anchorRec = frozenRecords.get(
      handoffRecordKey(targetLane, anchorUserEntryId),
    );
    if (anchorRec) {
      applyRecordCoverage(anchorOrdinal, anchorRec);
    }
  }

  return {
    effectiveStartOrdinal,
    omitPreRunMessages,
    omittedOrdinals,
    recordByRunOrdinal,
  };
}

function estimateNativePrefixTokens(
  runs: ConversationRun[],
  preRunMessages: AgentMessage[],
  slices: AlignedMessageSlice[],
  runIndexByOrdinal: Map<number, number>,
  omittedOrdinals: Set<number>,
  recordByRunOrdinal: Map<number, FrozenHandoffRecord>,
  upToOrdinal: number,
  omitPreRunMessages: boolean,
): number {
  const keptPrefixRuns = runs.filter(
    (run) => run.ordinal <= upToOrdinal && !omittedOrdinals.has(run.ordinal),
  );
  if (keptPrefixRuns.length === 0) {
    return 0;
  }

  // If the last kept native run has real provider input token usage, reuse it
  // and only add estimates for any trailing kept runs without usage.
  let lastUsageIdx = -1;
  for (let i = keptPrefixRuns.length - 1; i >= 0; i--) {
    if (
      keptPrefixRuns[i].lastUsageInputTokens !== undefined &&
      keptPrefixRuns[i].lastUsageInputTokens! > 0
    ) {
      lastUsageIdx = i;
      break;
    }
  }

  let total = 0;
  let estimateFromIdx = 0;
  if (lastUsageIdx >= 0) {
    total = keptPrefixRuns[lastUsageIdx].lastUsageInputTokens!;
    estimateFromIdx = lastUsageIdx + 1;
  } else if (!omitPreRunMessages) {
    for (const msg of preRunMessages) {
      total += estimateAgentMessageTokens(msg);
    }
  }

  for (let i = estimateFromIdx; i < keptPrefixRuns.length; i++) {
    const run = keptPrefixRuns[i];
    const sliceIdx = runIndexByOrdinal.get(run.ordinal);
    if (sliceIdx === undefined) continue;
    const rec = recordByRunOrdinal.get(run.ordinal);
    const msgs = slices[sliceIdx].messages;
    for (let m = 0; m < msgs.length; m++) {
      let msg = msgs[m];
      if (m === 0 && msg.role === "user" && rec) {
        msg = inlineHandoffIntoUserMessage(msg, rec.renderedText).message;
      }
      total += estimateAgentMessageTokens(msg);
    }
  }

  return total;
}

function estimateNativePrefixTokensFromBranch(
  runs: ConversationRun[],
  preRunEntries: SessionEntry[],
  editsByTarget: ReadonlyMap<string, ContextEditEntry>,
  omittedOrdinals: Set<number>,
  recordByRunOrdinal: Map<number, FrozenHandoffRecord>,
  upToOrdinal: number,
  omitPreRunMessages: boolean,
): number {
  const keptPrefixRuns = runs.filter(
    (run) => run.ordinal <= upToOrdinal && !omittedOrdinals.has(run.ordinal),
  );
  if (keptPrefixRuns.length === 0) {
    return 0;
  }

  let lastUsageIdx = -1;
  for (let i = keptPrefixRuns.length - 1; i >= 0; i--) {
    if (
      keptPrefixRuns[i].lastUsageInputTokens !== undefined &&
      keptPrefixRuns[i].lastUsageInputTokens! > 0
    ) {
      lastUsageIdx = i;
      break;
    }
  }

  let total = 0;
  let estimateFromIdx = 0;
  if (lastUsageIdx >= 0) {
    total = keptPrefixRuns[lastUsageIdx].lastUsageInputTokens!;
    estimateFromIdx = lastUsageIdx + 1;
  } else if (!omitPreRunMessages) {
    for (const entry of preRunEntries) {
      total += estimateSessionEntryTokens(entry, editsByTarget);
    }
  }

  for (let i = estimateFromIdx; i < keptPrefixRuns.length; i++) {
    const run = keptPrefixRuns[i];
    for (const entry of run.entries) {
      total += estimateSessionEntryTokens(entry, editsByTarget);
    }
    const rec = recordByRunOrdinal.get(run.ordinal);
    if (rec) {
      total += estimateTextTokens(rec.renderedText);
    }
  }

  return total;
}

function createHandoffRecord(params: {
  activeEntries: SessionEntry[];
  firstRunStart: number;
  coveredRuns: ConversationRun[];
  strategy: HandoffStrategy;
  fallbackReset: boolean;
  targetLane: LaneKey;
  fromLane: LaneKey | null;
  anchorUserEntryId: string;
  budgetBytes: number;
  includeCompaction: boolean;
}): { record: FrozenHandoffRecord | null; exhaustedBudget: boolean } {
  const items = buildItemsWithOptionalPreRun(
    params.activeEntries,
    params.firstRunStart,
    params.coveredRuns,
    params.includeCompaction,
  );
  if (items.length === 0) {
    return { record: null, exhaustedBudget: false };
  }
  if (params.budgetBytes <= 0) {
    return { record: null, exhaustedBudget: true };
  }

  const coveredRunFrom = params.coveredRuns[0]?.ordinal ?? 0;
  const coveredRunTo =
    params.coveredRuns[params.coveredRuns.length - 1]?.ordinal ?? 0;

  const selection = selectAndRenderHandoff({
    items,
    strategy: params.strategy,
    targetLane: params.targetLane,
    fromLane: params.fromLane,
    coveredRunFrom,
    coveredRunTo,
    budgetBytes: params.budgetBytes,
    fallbackReset: params.fallbackReset,
  });

  if (selection.renderedText.length === 0 || selection.byteLength === 0) {
    return { record: null, exhaustedBudget: true };
  }

  return {
    record: {
      version: 1,
      targetLane: params.targetLane,
      fromLane: params.fromLane,
      anchorUserEntryId: params.anchorUserEntryId,
      strategy: params.strategy,
      fallbackReset: params.fallbackReset,
      coveredRunFrom,
      coveredRunTo,
      sourceEntryFrom: items[0]?.entryId ?? null,
      sourceEntryTo: items[items.length - 1]?.entryId ?? null,
      includedCount: selection.selected.length,
      omittedCount: selection.omittedCount,
      omittedEntryIds: selection.omittedEntryIds,
      estimatedTokens: selection.estimatedTokens,
      byteLength: selection.byteLength,
      renderedText: selection.renderedText,
      createdAt: Date.now(),
    },
    exhaustedBudget: false,
  };
}

interface HandoffPlanOutput {
  newRecord: FrozenHandoffRecord | null;
  fallbackResetNoRecord: boolean;
  attemptedFromLane: LaneKey | null;
  plan: KeepSetPlan;
}

function planLaneHandoff(params: {
  activeEntries: SessionEntry[];
  firstRunStart: number;
  runs: ConversationRun[];
  priorRuns: ConversationRun[];
  editsByTarget: ReadonlyMap<string, ContextEditEntry>;
  preRunInfo: PreRunContextInfo;
  targetLane: LaneKey;
  modelContextWindow?: number;
  tokenCap: number;
  frozenRecords: ReadonlyMap<string, FrozenHandoffRecord>;
  anchorOrdinal: number;
  anchorUserEntryId: string;
  anchorSummary: {
    text: string;
    imageCount: number;
    otherAttachmentCount: number;
  };
  estimatePrefixTokens: (
    prefixPlan: KeepSetPlan,
    upToOrdinal: number,
  ) => number;
}): HandoffPlanOutput {
  const {
    activeEntries,
    firstRunStart,
    runs,
    priorRuns,
    editsByTarget,
    preRunInfo,
    targetLane,
    modelContextWindow,
    tokenCap,
    frozenRecords,
    anchorOrdinal,
    anchorUserEntryId,
    anchorSummary,
    estimatePrefixTokens,
  } = params;

  const workingFrozenRecords = new Map(frozenRecords);
  const anchorKey = handoffRecordKey(targetLane, anchorUserEntryId);
  let newRecord: FrozenHandoffRecord | null = null;
  let fallbackResetNoRecord = false;
  let attemptedFromLane: LaneKey | null = null;

  if (!workingFrozenRecords.has(anchorKey)) {
    let lastPriorLaneRun: ConversationRun | null = null;
    for (let i = priorRuns.length - 1; i >= 0; i--) {
      const candidate = priorRuns[i];
      if (
        candidate.ownerLane !== null &&
        runHasConversationOrToolActivity(candidate, editsByTarget)
      ) {
        lastPriorLaneRun = candidate;
        break;
      }
    }

    const fromLane =
      lastPriorLaneRun?.ownerLane ??
      (preRunInfo.hasContext ? preRunInfo.ownerLane : null);

    if (fromLane !== null && fromLane !== targetLane) {
      attemptedFromLane = fromLane;
      let lastTargetIdx = -1;
      for (let i = priorRuns.length - 1; i >= 0; i--) {
        if (
          priorRuns[i].delivered &&
          priorRuns[i].ownerLane === targetLane
        ) {
          lastTargetIdx = i;
          break;
        }
      }

      if (lastTargetIdx >= 0) {
        const lastTargetRun = priorRuns[lastTargetIdx];
        const deltaRuns = priorRuns.slice(lastTargetIdx + 1);
        const prefixPlan = computeKeepSetAndEffectiveRecords({
          runs,
          anchorOrdinal,
          anchorUserEntryId,
          targetLane,
          frozenRecords: workingFrozenRecords,
        });
        const nativeTokens = estimatePrefixTokens(
          prefixPlan,
          lastTargetRun.ordinal,
        );

        const deltaBudget = computeHandoffBudget({
          tokenCap,
          modelContextWindow,
          nativeTokens,
          currentUserText: anchorSummary.text,
          currentImageCount: anchorSummary.imageCount,
          currentOtherAttachmentCount: anchorSummary.otherAttachmentCount,
        });

        if (deltaBudget.budgetBytes < MIN_DELTA_BUDGET_BYTES) {
          const fullBudget = computeHandoffBudget({
            tokenCap,
            modelContextWindow,
            nativeTokens: 0,
            currentUserText: anchorSummary.text,
            currentImageCount: anchorSummary.imageCount,
            currentOtherAttachmentCount: anchorSummary.otherAttachmentCount,
          });
          const created = createHandoffRecord({
            activeEntries,
            firstRunStart,
            coveredRuns: priorRuns,
            strategy: "full_thread_summary",
            fallbackReset: true,
            targetLane,
            fromLane,
            anchorUserEntryId,
            budgetBytes: fullBudget.budgetBytes,
            includeCompaction: true,
          });
          newRecord = created.record;
          fallbackResetNoRecord = created.exhaustedBudget;
        } else {
          const created = createHandoffRecord({
            activeEntries,
            firstRunStart,
            coveredRuns: deltaRuns,
            strategy: "delta_since_target_last_seen",
            fallbackReset: false,
            targetLane,
            fromLane,
            anchorUserEntryId,
            budgetBytes: deltaBudget.budgetBytes,
            includeCompaction: false,
          });
          newRecord = created.record;
          fallbackResetNoRecord = created.exhaustedBudget;
        }
      } else {
        const fullBudget = computeHandoffBudget({
          tokenCap,
          modelContextWindow,
          nativeTokens: 0,
          currentUserText: anchorSummary.text,
          currentImageCount: anchorSummary.imageCount,
          currentOtherAttachmentCount: anchorSummary.otherAttachmentCount,
        });
        const created = createHandoffRecord({
          activeEntries,
          firstRunStart,
          coveredRuns: priorRuns,
          strategy: "full_thread_summary",
          fallbackReset: false,
          targetLane,
          fromLane,
          anchorUserEntryId,
          budgetBytes: fullBudget.budgetBytes,
          includeCompaction: true,
        });
        newRecord = created.record;
        fallbackResetNoRecord = created.exhaustedBudget;
      }

      if (newRecord) {
        workingFrozenRecords.set(anchorKey, newRecord);
      }
    }
  }

  const plan = computeKeepSetAndEffectiveRecords({
    runs,
    anchorOrdinal,
    anchorUserEntryId,
    targetLane,
    frozenRecords: workingFrozenRecords,
    fallbackResetNoRecord,
  });

  return {
    newRecord,
    fallbackResetNoRecord,
    attemptedFromLane,
    plan,
  };
}

/**
 * Project conversation `eventMessages` onto `targetLane` using frozen or newly
 * computed handoff records, without mutating input messages or creating orphaned
 * `toolResult` messages.
 */
export function projectMessagesForLane(
  input: ProjectMessagesInput,
): ProjectionResult {
  const activeEntries = sliceActiveBranchAfterCompaction(input.branch);
  const runs = segmentBranchIntoRuns(activeEntries, input.targetLane);
  const totalRuns = runs.length;
  const contextWindow = normalizeContextWindow(input.modelContextWindow);

  const buildPassThroughResult = (): ProjectionResult => {
    const projectedContextTokens = estimateMessagesTokens(input.eventMessages);
    const remainingContextTokens =
      contextWindow !== null
        ? Math.max(0, contextWindow - projectedContextTokens)
        : null;
    return {
      messages: input.eventMessages,
      modified: false,
      activeLane: input.targetLane,
      newRecord: null,
      appliedRecords: [],
      keptNativeRuns: totalRuns,
      totalRuns,
      projectedContextTokens,
      contextWindow,
      remainingContextTokens,
    };
  };

  if (input.bypass || totalRuns === 0) {
    return buildPassThroughResult();
  }

  const editsByTarget = collectContextEditsByTarget(activeEntries);
  const firstRunStart = runs[0]?.startIndex ?? activeEntries.length;
  const preRunInfo = inspectPreRunContext(
    activeEntries,
    firstRunStart,
    editsByTarget,
  );
  const frozenRecords = collectFrozenRecords(activeEntries, input.extraRecords);
  const anchorRun = runs[runs.length - 1];
  const priorRuns = runs.slice(0, runs.length - 1);

  const hasForeignInPreRun =
    preRunInfo.hasContext &&
    preRunInfo.ownerLane !== null &&
    preRunInfo.ownerLane !== input.targetLane;
  const hasForeignInPrior = priorRuns.some(
    (run) =>
      runHasConversationOrToolActivity(run, editsByTarget) &&
      run.ownerLane !== null &&
      run.ownerLane !== input.targetLane,
  );
  const hasForeignInAnchor =
    runHasConversationOrToolActivity(anchorRun, editsByTarget) &&
    anchorRun.ownerLane !== null &&
    anchorRun.ownerLane !== input.targetLane;
  const hasFrozenForTarget = runs.some((run) =>
    frozenRecords.has(handoffRecordKey(input.targetLane, run.userEntryId)),
  );

  // Rule 4: Single-lane thread with no foreign activity and no frozen records passes through unchanged.
  if (
    !hasForeignInPreRun &&
    !hasForeignInPrior &&
    !hasForeignInAnchor &&
    !hasFrozenForTarget
  ) {
    return buildPassThroughResult();
  }

  const aligned = alignEventMessagesToRuns(
    input.eventMessages,
    activeEntries,
    runs,
  );
  const anchorSliceIdx = aligned.runIndexByOrdinal.get(anchorRun.ordinal);
  const anchorUserMsg =
    anchorSliceIdx !== undefined
      ? (aligned.slices[anchorSliceIdx].messages[0] as UserMessage)
      : (
          activeEntries[anchorRun.startIndex] as SessionMessageEntry & {
            message: UserMessage;
          }
        ).message;
  const anchorSummary = extractUserContentSummary(anchorUserMsg?.content);

  const { newRecord, fallbackResetNoRecord, plan } = planLaneHandoff({
    activeEntries,
    firstRunStart,
    runs,
    priorRuns,
    editsByTarget,
    preRunInfo,
    targetLane: input.targetLane,
    modelContextWindow: input.modelContextWindow,
    tokenCap: input.tokenCap,
    frozenRecords,
    anchorOrdinal: anchorRun.ordinal,
    anchorUserEntryId: anchorRun.userEntryId,
    anchorSummary,
    estimatePrefixTokens: (prefixPlan, upToOrdinal) =>
      estimateNativePrefixTokens(
        runs,
        aligned.preRunMessages,
        aligned.slices,
        aligned.runIndexByOrdinal,
        prefixPlan.omittedOrdinals,
        prefixPlan.recordByRunOrdinal,
        upToOrdinal,
        prefixPlan.omitPreRunMessages,
      ),
  });

  const projectedMessages: AgentMessage[] = [];
  const appliedRecords: FrozenHandoffRecord[] = [];
  let keptNativeRuns = 0;
  let hasContentModification = newRecord !== null;

  if (!plan.omitPreRunMessages) {
    projectedMessages.push(...aligned.preRunMessages);
  } else if (aligned.preRunMessages.length > 0) {
    hasContentModification = true;
  }

  for (const slice of aligned.slices) {
    if (!slice.run) {
      projectedMessages.push(...slice.messages);
      continue;
    }

    if (plan.omittedOrdinals.has(slice.run.ordinal)) {
      hasContentModification = true;
      continue;
    }

    keptNativeRuns += 1;
    const rec = plan.recordByRunOrdinal.get(slice.run.ordinal);
    if (!rec) {
      projectedMessages.push(...slice.messages);
      continue;
    }

    appliedRecords.push(rec);
    const [firstMsg, ...restMsgs] = slice.messages;
    if (firstMsg && firstMsg.role === "user") {
      const inlined = inlineHandoffIntoUserMessage(firstMsg, rec.renderedText);
      if (inlined.changed) {
        hasContentModification = true;
      }
      projectedMessages.push(inlined.message, ...restMsgs);
    } else {
      projectedMessages.push(...slice.messages);
    }
  }

  const sanitized = dropOrphanedToolResults(projectedMessages);
  const modified = hasContentModification || sanitized.dropped;
  const finalMessages = modified ? sanitized.messages : input.eventMessages;
  const projectedContextTokens = estimateMessagesTokens(finalMessages);
  const remainingContextTokens =
    contextWindow !== null
      ? Math.max(0, contextWindow - projectedContextTokens)
      : null;

  if (newRecord) {
    newRecord.projectedContextTokens = projectedContextTokens;
    if (contextWindow !== null) {
      newRecord.modelContextWindow = contextWindow;
      newRecord.remainingContextTokens = remainingContextTokens!;
    }
  }

  return {
    messages: finalMessages,
    modified,
    activeLane: input.targetLane,
    newRecord,
    appliedRecords,
    keptNativeRuns,
    totalRuns,
    projectedContextTokens,
    contextWindow,
    remainingContextTokens,
    ...(fallbackResetNoRecord ? { fallbackResetNoRecord: true } : {}),
  };
}

/**
 * Pure read-only preview of what `projectMessagesForLane` would do for
 * `targetLane` on the given `branch`, without mutating inputs or persisting records.
 */
export function previewHandoffForLane(
  input: HandoffPreviewInput,
): HandoffPreview {
  const activeEntries = sliceActiveBranchAfterCompaction(input.branch);
  const runs = segmentBranchIntoRuns(activeEntries, input.targetLane);
  const totalRuns = runs.length;
  const editsByTarget = collectContextEditsByTarget(activeEntries);
  const contextWindow = normalizeContextWindow(input.modelContextWindow);

  const estimateUnmodifiedTokens = (): number => {
    let total = 0;
    for (const entry of activeEntries) {
      total += estimateSessionEntryTokens(entry, editsByTarget);
    }
    return total;
  };

  if (input.bypass) {
    const projectedContextTokens = estimateUnmodifiedTokens();
    return {
      targetLane: input.targetLane,
      fromLane: null,
      willHandoff: false,
      strategy: null,
      estimatedHandoffTokens: 0,
      projectedContextTokens,
      contextWindow,
      remainingContextTokens:
        contextWindow !== null
          ? Math.max(0, contextWindow - projectedContextTokens)
          : null,
      coveredRunFrom: null,
      coveredRunTo: null,
      fallbackReset: false,
      keptNativeRuns: totalRuns,
      totalRuns,
    };
  }

  const firstRunStart = runs[0]?.startIndex ?? activeEntries.length;
  const preRunInfo = inspectPreRunContext(
    activeEntries,
    firstRunStart,
    editsByTarget,
  );
  const frozenRecords = collectFrozenRecords(activeEntries, input.extraRecords);

  if (totalRuns === 0 && (!preRunInfo.hasContext || preRunInfo.ownerLane === null || preRunInfo.ownerLane === input.targetLane)) {
    const projectedContextTokens = estimateUnmodifiedTokens();
    return {
      targetLane: input.targetLane,
      fromLane: null,
      willHandoff: false,
      strategy: null,
      estimatedHandoffTokens: 0,
      projectedContextTokens,
      contextWindow,
      remainingContextTokens:
        contextWindow !== null
          ? Math.max(0, contextWindow - projectedContextTokens)
          : null,
      coveredRunFrom: null,
      coveredRunTo: null,
      fallbackReset: false,
      keptNativeRuns: 0,
      totalRuns: 0,
    };
  }

  const lastRun = totalRuns > 0 ? runs[totalRuns - 1] : null;
  const lastRunIsPendingAnchor =
    lastRun !== null &&
    !lastRun.delivered &&
    !lastRun.hasError &&
    !runHasConversationOrToolActivity(lastRun, editsByTarget);

  const priorRuns = lastRunIsPendingAnchor ? runs.slice(0, -1) : runs;
  const anchorOrdinal = lastRunIsPendingAnchor
    ? lastRun.ordinal
    : totalRuns + 1;
  const anchorUserEntryId = lastRunIsPendingAnchor
    ? lastRun.userEntryId
    : "__preview_next_turn__";

  let anchorSummary = { text: "", imageCount: 0, otherAttachmentCount: 0 };
  if (lastRunIsPendingAnchor && lastRun) {
    const userEntry = activeEntries[lastRun.startIndex] as SessionMessageEntry & {
      message: UserMessage;
    };
    const edit = editsByTarget.get(lastRun.userEntryId);
    const effectiveContent =
      edit?.replacement && typeof edit.replacement.content !== "undefined"
        ? (edit.replacement.content as UserMessage["content"])
        : userEntry.message?.content;
    anchorSummary = extractUserContentSummary(effectiveContent);
  }

  const { newRecord, fallbackResetNoRecord, attemptedFromLane, plan } =
    planLaneHandoff({
      activeEntries,
      firstRunStart,
      runs,
      priorRuns,
      editsByTarget,
      preRunInfo,
      targetLane: input.targetLane,
      modelContextWindow: input.modelContextWindow,
      tokenCap: input.tokenCap,
      frozenRecords,
      anchorOrdinal,
      anchorUserEntryId,
      anchorSummary,
      estimatePrefixTokens: (prefixPlan, upToOrdinal) =>
        estimateNativePrefixTokensFromBranch(
          runs,
          preRunInfo.entries,
          editsByTarget,
          prefixPlan.omittedOrdinals,
          prefixPlan.recordByRunOrdinal,
          upToOrdinal,
          prefixPlan.omitPreRunMessages,
        ),
    });

  let projectedContextTokens = 0;
  if (!plan.omitPreRunMessages) {
    for (const entry of preRunInfo.entries) {
      projectedContextTokens += estimateSessionEntryTokens(entry, editsByTarget);
    }
  }

  let keptNativeRuns = 0;
  for (const run of runs) {
    if (plan.omittedOrdinals.has(run.ordinal)) {
      continue;
    }
    keptNativeRuns += 1;
    for (const entry of run.entries) {
      projectedContextTokens += estimateSessionEntryTokens(entry, editsByTarget);
    }
    const rec = plan.recordByRunOrdinal.get(run.ordinal);
    if (rec) {
      projectedContextTokens += estimateTextTokens(rec.renderedText);
    }
  }

  // When predicting a brand-new handoff for the upcoming turn (synthetic anchor),
  // include the predicted capsule tokens in projectedContextTokens.
  if (!lastRunIsPendingAnchor && newRecord) {
    projectedContextTokens += estimateTextTokens(newRecord.renderedText);
  }

  const remainingContextTokens =
    contextWindow !== null
      ? Math.max(0, contextWindow - projectedContextTokens)
      : null;

  return {
    targetLane: input.targetLane,
    fromLane: newRecord
      ? newRecord.fromLane
      : fallbackResetNoRecord
        ? attemptedFromLane
        : null,
    willHandoff: newRecord !== null,
    strategy: newRecord ? newRecord.strategy : null,
    estimatedHandoffTokens: newRecord ? newRecord.estimatedTokens : 0,
    projectedContextTokens,
    contextWindow,
    remainingContextTokens,
    coveredRunFrom: newRecord ? newRecord.coveredRunFrom : null,
    coveredRunTo: newRecord ? newRecord.coveredRunTo : null,
    fallbackReset: Boolean(newRecord?.fallbackReset || fallbackResetNoRecord),
    keptNativeRuns,
    totalRuns,
  };
}
