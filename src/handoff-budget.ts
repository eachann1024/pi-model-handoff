import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type BudgetInput,
  type BudgetResult,
  type ConversationRun,
  DEFAULT_HANDOFF_TOKEN_CAP,
  HANDOFF_ENTRY_TYPE,
  type HistoricalItem,
  type LaneKey,
  MAX_HANDOFF_TOKEN_CAP,
  MAX_LISTED_OMITTED_ITEMS,
  MIN_HANDOFF_TOKEN_CAP,
  type SelectAndRenderHandoffInput,
  type SelectionResult,
  SYSTEM_OVERHEAD_RESERVE_TOKENS,
  TOOL_NAME_HISTORY_READ,
} from "./types.ts";

const DEFAULT_WINDOW_TOKENS = 128_000;
const IMAGE_ATTACHMENT_TOKEN_COST = 8_192;
const OTHER_ATTACHMENT_TOKEN_COST = 4_096;
const MIN_WORK_RESERVE_TOKENS = 16_000;
const IMAGE_NOT_REPLAYED_NOTE = "[image attachment not replayed]";
const MAX_COMMAND_CHARS = 300;
const MAX_COMMAND_OUTPUT_CHARS = 1_200;
const MAX_ERROR_CHARS = 1_200;
const MIN_ANCHOR_TRUNCATE_BYTES = 160;

/** Build a canonical per-model lane key from provider and model ID. */
export function laneKeyFromModel(provider: string, modelId: string): LaneKey {
  return `${provider.trim()}/${modelId.trim()}`;
}

/** Parse and clamp the handoff token cap from an explicit or environment value. */
export function resolveTokenCap(envCap?: string | number): number {
  const raw = envCap ?? process.env.PI_MODEL_HANDOFF_TOKEN_CAP;
  if (raw === undefined) {
    return DEFAULT_HANDOFF_TOKEN_CAP;
  }

  let parsed: number;
  if (typeof raw === "number") {
    parsed = raw;
  } else {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return DEFAULT_HANDOFF_TOKEN_CAP;
    }
    parsed = Number(trimmed);
  }

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HANDOFF_TOKEN_CAP;
  }

  const floored = Math.floor(parsed);
  return Math.min(MAX_HANDOFF_TOKEN_CAP, Math.max(MIN_HANDOFF_TOKEN_CAP, floored));
}

/** Conservatively estimate token count from text UTF-8 byte length (ceil(bytes / 4)). */
export function estimateTextTokens(text: string): number {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/** Compute the handoff byte budget and context reserve. */
export function computeHandoffBudget(input: BudgetInput): BudgetResult {
  const windowTokens =
    input.modelContextWindow !== undefined &&
    Number.isFinite(input.modelContextWindow) &&
    input.modelContextWindow > 0
      ? Math.floor(input.modelContextWindow)
      : DEFAULT_WINDOW_TOKENS;

  const nativeTokens =
    Number.isFinite(input.nativeTokens) && input.nativeTokens > 0
      ? Math.floor(input.nativeTokens)
      : 0;

  const currentTextTokens = estimateTextTokens(
    JSON.stringify(input.currentUserText ?? "") ?? "",
  );
  const imageCount =
    input.currentImageCount !== undefined &&
    Number.isFinite(input.currentImageCount) &&
    input.currentImageCount > 0
      ? Math.floor(input.currentImageCount)
      : 0;
  const otherAttachmentCount =
    input.currentOtherAttachmentCount !== undefined &&
    Number.isFinite(input.currentOtherAttachmentCount) &&
    input.currentOtherAttachmentCount > 0
      ? Math.floor(input.currentOtherAttachmentCount)
      : 0;

  const currentTokens =
    currentTextTokens +
    imageCount * IMAGE_ATTACHMENT_TOKEN_COST +
    otherAttachmentCount * OTHER_ATTACHMENT_TOKEN_COST;

  const workReserveTokens = Math.min(
    Math.max(MIN_WORK_RESERVE_TOKENS, Math.ceil(windowTokens / 4)),
    Math.ceil(windowTokens / 2),
  );
  const systemOverheadTokens = Math.min(
    SYSTEM_OVERHEAD_RESERVE_TOKENS,
    Math.floor(windowTokens * 0.1),
  );

  const tokenCap =
    Number.isFinite(input.tokenCap) && input.tokenCap > 0
      ? Math.floor(input.tokenCap)
      : 0;

  const availableTokens = Math.max(
    0,
    windowTokens -
      nativeTokens -
      currentTokens -
      workReserveTokens -
      systemOverheadTokens,
  );
  const budgetTokens = Math.max(0, Math.min(tokenCap, availableTokens));
  const maxBudgetBytes = Math.min(tokenCap * 4, MAX_HANDOFF_TOKEN_CAP * 4);
  const budgetBytes = Math.min(budgetTokens * 4, maxBudgetBytes);

  return {
    budgetBytes,
    windowTokens,
    workReserveTokens,
    nativeTokens,
    currentTokens,
  };
}

function parseTimestamp(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function truncateMiddle(text: string, maxChars: number): string {
  if (typeof text !== "string") {
    return "";
  }
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  if (maxChars <= 32) {
    return trimmed.slice(0, Math.max(0, maxChars));
  }
  const marker = "\n... [truncated] ...\n";
  const budget = maxChars - marker.length;
  const headLen = Math.ceil(budget / 2);
  const tailLen = Math.floor(budget / 2);
  return `${trimmed.slice(0, headLen)}${marker}${trimmed.slice(trimmed.length - tailLen)}`;
}

function extractTextAndImageFlag(
  content: string | readonly (TextContent | ImageContent)[] | null | undefined,
): { text: string; hasImage: boolean } {
  if (typeof content === "string") {
    return { text: content.trim(), hasImage: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasImage: false };
  }
  const textParts: string[] = [];
  let hasImage = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type === "text") {
      if (typeof block.text === "string" && block.text.trim().length > 0) {
        textParts.push(block.text.trim());
      }
    } else if (block.type === "image") {
      hasImage = true;
    }
  }
  return {
    text: textParts.join("\n"),
    hasImage,
  };
}

function formatUserLikeText(
  content: string | readonly (TextContent | ImageContent)[] | null | undefined,
): string {
  const { text, hasImage } = extractTextAndImageFlag(content);
  if (hasImage) {
    return text.length > 0
      ? `${text}\n${IMAGE_NOT_REPLAYED_NOTE}`
      : IMAGE_NOT_REPLAYED_NOTE;
  }
  return text;
}

function extractToolResultText(msg: ToolResultMessage): string {
  const { text, hasImage } = extractTextAndImageFlag(msg?.content);
  if (hasImage) {
    return text.length > 0
      ? `${text}\n${IMAGE_NOT_REPLAYED_NOTE}`
      : IMAGE_NOT_REPLAYED_NOTE;
  }
  return text;
}

function extractStringArg(call: ToolCall, key: string): string | null {
  const args = call?.arguments as unknown;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const value = (args as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function extractSummaryEntry(
  entry: CompactionEntry | BranchSummaryEntry,
  runOrdinal: number,
  items: HistoricalItem[],
): void {
  const text = typeof entry.summary === "string" ? entry.summary.trim() : "";
  if (text.length === 0) {
    return;
  }
  const isCompaction = entry.type === "compaction";
  items.push({
    entryId: entry.id,
    runOrdinal,
    position: items.length,
    role: "user",
    kind: isCompaction ? "compaction_summary" : "branch_summary",
    title: isCompaction ? "Compaction summary" : "Branch summary",
    text,
    timestamp: parseTimestamp(entry.timestamp),
  });
}

function appendMessageItems(
  entry: SessionMessageEntry,
  runOrdinal: number,
  toolResultsByCallId: ReadonlyMap<
    string,
    { entry: SessionMessageEntry; msg: ToolResultMessage }
  >,
  handledToolCallIds: Set<string>,
  items: HistoricalItem[],
): void {
  const message = entry?.message as AgentMessage | null | undefined;
  if (!message || typeof message !== "object") {
    return;
  }
  const entryTs = parseTimestamp(entry.timestamp);

  switch (message.role) {
    case "user": {
      const userMsg = message as UserMessage;
      const text = formatUserLikeText(userMsg.content);
      if (text.length > 0) {
        items.push({
          entryId: entry.id,
          runOrdinal,
          position: items.length,
          role: "user",
          kind: "user_message",
          text,
          timestamp: userMsg.timestamp > 0 ? userMsg.timestamp : entryTs,
        });
      }
      return;
    }

    case "custom": {
      if (message.customType === HANDOFF_ENTRY_TYPE) {
        return;
      }
      const text = formatUserLikeText(message.content);
      if (text.length > 0) {
        items.push({
          entryId: entry.id,
          runOrdinal,
          position: items.length,
          role: "user",
          kind: "user_message",
          text,
          timestamp: message.timestamp > 0 ? message.timestamp : entryTs,
        });
      }
      return;
    }

    case "compactionSummary": {
      const text = typeof message.summary === "string" ? message.summary.trim() : "";
      if (text.length > 0) {
        items.push({
          entryId: entry.id,
          runOrdinal,
          position: items.length,
          role: "user",
          kind: "compaction_summary",
          title: "Compaction summary",
          text,
          timestamp: message.timestamp > 0 ? message.timestamp : entryTs,
        });
      }
      return;
    }

    case "branchSummary": {
      const text = typeof message.summary === "string" ? message.summary.trim() : "";
      if (text.length > 0) {
        items.push({
          entryId: entry.id,
          runOrdinal,
          position: items.length,
          role: "user",
          kind: "branch_summary",
          title: "Branch summary",
          text,
          timestamp: message.timestamp > 0 ? message.timestamp : entryTs,
        });
      }
      return;
    }

    case "bashExecution": {
      if (message.excludeFromContext) {
        return;
      }
      const command = truncateMiddle(message.command, MAX_COMMAND_CHARS);
      const output = truncateMiddle(message.output, MAX_COMMAND_OUTPUT_CHARS);
      const statusParts: string[] = [];
      if (message.cancelled) {
        statusParts.push("cancelled");
      } else if (message.exitCode !== undefined && message.exitCode !== 0) {
        statusParts.push(`exit ${message.exitCode}`);
      }
      const statusSuffix =
        statusParts.length > 0 ? ` [${statusParts.join(", ")}]` : "";
      const body = output.length > 0 ? `$ ${command}${statusSuffix}\n${output}` : `$ ${command}${statusSuffix}`;
      items.push({
        entryId: entry.id,
        runOrdinal,
        position: items.length,
        role: "user",
        kind: "command_execution",
        title: command,
        text: body,
        timestamp: message.timestamp > 0 ? message.timestamp : entryTs,
      });
      return;
    }

    case "assistant": {
      const assistantMsg = message as AssistantMessage;
      const msgTs =
        assistantMsg.timestamp > 0 ? assistantMsg.timestamp : entryTs;

      const visibleTexts: string[] = [];
      const fileChangeLines: string[] = [];
      const seenFileChanges = new Set<string>();
      const bashCalls: ToolCall[] = [];

      const rawContent: unknown = assistantMsg.content;
      if (typeof rawContent === "string") {
        const trimmed = rawContent.trim();
        if (trimmed.length > 0) {
          visibleTexts.push(trimmed);
        }
      } else if (Array.isArray(rawContent)) {
        for (const block of rawContent) {
          if (!block || typeof block !== "object") {
            continue;
          }
          if (block.type === "thinking") {
            continue;
          }
          if (block.type === "text") {
            if (typeof block.text === "string" && block.text.trim().length > 0) {
              visibleTexts.push(block.text.trim());
            }
            continue;
          }
          if (block.type === "toolCall") {
            if (block.name === "edit" || block.name === "write") {
              const callId = typeof block.id === "string" ? block.id : "";
              const paired = callId.length > 0 ? toolResultsByCallId.get(callId) : undefined;
              if (paired?.msg.isError) {
                continue;
              }
              const filePath = extractStringArg(block, "path");
              if (filePath !== null) {
                const line = `${block.name}: ${filePath}`;
                if (!seenFileChanges.has(line)) {
                  seenFileChanges.add(line);
                  fileChangeLines.push(line);
                }
              }
            } else if (block.name === "bash") {
              bashCalls.push(block);
            }
          }
        }
      }

      if (visibleTexts.length > 0) {
        items.push({
          entryId: entry.id,
          runOrdinal,
          position: items.length,
          role: "assistant",
          kind: "assistant_message",
          text: visibleTexts.join("\n"),
          timestamp: msgTs,
        });
      }

      if (fileChangeLines.length > 0) {
        items.push({
          entryId: entry.id,
          runOrdinal,
          position: items.length,
          role: "assistant",
          kind: "file_change",
          title: "Files modified",
          text: fileChangeLines.join("\n"),
          timestamp: msgTs,
        });
      }

      for (const call of bashCalls) {
        const command = truncateMiddle(
          extractStringArg(call, "command") ?? "(empty command)",
          MAX_COMMAND_CHARS,
        );
        const callId = typeof call.id === "string" ? call.id : "";
        const paired = callId.length > 0 ? toolResultsByCallId.get(callId) : undefined;
        if (paired) {
          handledToolCallIds.add(callId);
          const resultTs =
            paired.msg.timestamp > 0 ? paired.msg.timestamp : parseTimestamp(paired.entry.timestamp);
          const outputText = extractToolResultText(paired.msg);
          if (paired.msg.isError) {
            const errBody = truncateMiddle(
              outputText.length > 0 ? `$ ${command}\n${outputText}` : `$ ${command}\n(command failed)`,
              MAX_ERROR_CHARS,
            );
            items.push({
              entryId: paired.entry.id,
              runOrdinal,
              position: items.length,
              role: "assistant",
              kind: "error",
              title: `bash error: ${command}`,
              text: errBody,
              timestamp: resultTs,
            });
          } else {
            const truncatedOutput = truncateMiddle(outputText, MAX_COMMAND_OUTPUT_CHARS);
            const cmdBody =
              truncatedOutput.length > 0
                ? `$ ${command}\n${truncatedOutput}`
                : `$ ${command}\n(no output)`;
            items.push({
              entryId: paired.entry.id,
              runOrdinal,
              position: items.length,
              role: "assistant",
              kind: "command_execution",
              title: command,
              text: cmdBody,
              timestamp: resultTs,
            });
          }
        } else {
          items.push({
            entryId: entry.id,
            runOrdinal,
            position: items.length,
            role: "assistant",
            kind: "command_execution",
            title: command,
            text: `$ ${command}\n(no tool result recorded)`,
            timestamp: msgTs,
          });
        }
      }

      const rawErrorMsg =
        typeof assistantMsg.errorMessage === "string"
          ? assistantMsg.errorMessage.trim()
          : "";
      if (
        rawErrorMsg.length > 0 ||
        assistantMsg.stopReason === "error" ||
        assistantMsg.stopReason === "aborted"
      ) {
        const errorText =
          rawErrorMsg.length > 0
            ? rawErrorMsg
            : `Assistant stopped with reason: ${assistantMsg.stopReason}`;
        items.push({
          entryId: entry.id,
          runOrdinal,
          position: items.length,
          role: "assistant",
          kind: "error",
          title: assistantMsg.stopReason === "aborted" ? "Aborted" : "Assistant error",
          text: truncateMiddle(errorText, MAX_ERROR_CHARS),
          timestamp: msgTs,
        });
      }
      return;
    }

    case "toolResult": {
      const toolResult = message as ToolResultMessage;
      const toolCallId =
        typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
      if (toolCallId.length > 0 && handledToolCallIds.has(toolCallId)) {
        return;
      }
      // Only emit failed tool results; successful read/grep/find/ls outputs are never inlined.
      if (toolResult.isError) {
        const toolName =
          typeof toolResult.toolName === "string" && toolResult.toolName.length > 0
            ? toolResult.toolName
            : "tool";
        const errText = extractToolResultText(toolResult);
        const body = truncateMiddle(
          errText.length > 0 ? errText : `${toolName} failed`,
          MAX_ERROR_CHARS,
        );
        items.push({
          entryId: entry.id,
          runOrdinal,
          position: items.length,
          role: "assistant",
          kind: "error",
          title: `${toolName} error`,
          text: body,
          timestamp: toolResult.timestamp > 0 ? toolResult.timestamp : entryTs,
        });
      }
      return;
    }

    default:
      return;
  }
}

function appendNonMessageEntry(
  entry: SessionEntry,
  runOrdinal: number,
  items: HistoricalItem[],
): void {
  if (!entry || typeof entry !== "object") {
    return;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    extractSummaryEntry(entry, runOrdinal, items);
    return;
  }
  if (entry.type === "custom_message") {
    if (entry.customType === HANDOFF_ENTRY_TYPE) {
      return;
    }
    const text = formatUserLikeText(entry.content);
    if (text.length > 0) {
      items.push({
        entryId: entry.id,
        runOrdinal,
        position: items.length,
        role: "user",
        kind: "user_message",
        text,
        timestamp: parseTimestamp(entry.timestamp),
      });
    }
  }
}

/** Deterministically extract historical items from runs and optional pre-run summaries without any LLM calls. */
export function extractHistoricalItems(
  runs: readonly ConversationRun[],
  preRunSummaries?: readonly SessionEntry[],
): HistoricalItem[] {
  const items: HistoricalItem[] = [];
  const toolResultsByCallId = new Map<
    string,
    { entry: SessionMessageEntry; msg: ToolResultMessage }
  >();
  const registerToolResults = (entries: readonly SessionEntry[] | undefined): void => {
    if (!Array.isArray(entries)) {
      return;
    }
    for (const entry of entries) {
      if (
        entry &&
        entry.type === "message" &&
        entry.message &&
        entry.message.role === "toolResult"
      ) {
        const toolResult = entry.message as ToolResultMessage;
        if (typeof toolResult.toolCallId === "string" && toolResult.toolCallId.length > 0) {
          toolResultsByCallId.set(toolResult.toolCallId, {
            entry,
            msg: toolResult,
          });
        }
      }
    }
  };

  registerToolResults(preRunSummaries);
  if (Array.isArray(runs)) {
    for (const run of runs) {
      if (run && Array.isArray(run.entries)) {
        registerToolResults(run.entries);
      }
    }
  }

  const handledToolCallIds = new Set<string>();

  if (Array.isArray(preRunSummaries)) {
    const preOrdinal = Array.isArray(runs) && runs.length > 0 ? Math.max(0, runs[0].ordinal - 1) : 0;
    for (const entry of preRunSummaries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      if (entry.type === "message") {
        appendMessageItems(
          entry,
          preOrdinal,
          toolResultsByCallId,
          handledToolCallIds,
          items,
        );
      } else {
        appendNonMessageEntry(entry, preOrdinal, items);
      }
    }
  }

  if (!Array.isArray(runs)) {
    return items;
  }

  for (const run of runs) {
    if (!run || !Array.isArray(run.entries)) {
      continue;
    }
    for (const entry of run.entries) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      if (entry.type === "message") {
        appendMessageItems(
          entry,
          run.ordinal,
          toolResultsByCallId,
          handledToolCallIds,
          items,
        );
      } else {
        appendNonMessageEntry(entry, run.ordinal, items);
      }
    }
  }

  return items;
}

function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) {
    return "";
  }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice = text.slice(0, mid);
    if (Buffer.byteLength(slice, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  // Avoid splitting a UTF-16 surrogate pair at the boundary.
  if (low > 0) {
    const code = text.charCodeAt(low - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      low -= 1;
    }
  }
  return text.slice(0, low);
}

function formatHistoricalItem(item: HistoricalItem): string {
  const titleSuffix = item.title ? ` (${item.title})` : "";
  return `### [run ${item.runOrdinal} | ${item.kind} | id: ${item.entryId}]${titleSuffix}\n${item.text}`;
}

function buildHeaderText(
  input: SelectAndRenderHandoffInput,
  items: readonly HistoricalItem[],
  selectedCount: number,
): string {
  const laneFlow =
    input.fromLane !== null
      ? `from ${input.fromLane} to ${input.targetLane}`
      : `target ${input.targetLane}`;
  const resetNote = input.fallbackReset ? " [fallback_reset]" : "";
  const entryRange =
    items.length > 0
      ? `${items[0].entryId}..${items[items.length - 1].entryId}`
      : "none";

  return [
    "[Model Handoff Capsule]",
    `strategy: ${input.strategy} (${laneFlow})${resetNote}`,
    `covered_runs: ${input.coveredRunFrom}..${input.coveredRunTo} | items: ${selectedCount}/${items.length} (entries: ${entryRange})`,
    "Notice: Attached files and native tool/reasoning state are not replayed.",
    `To inspect omitted or truncated entries, call ${TOOL_NAME_HISTORY_READ}({ entryId, maxCharsPerItem: 4000 }).`,
  ].join("\n");
}

function buildOmittedSection(
  omittedEntryIds: readonly string[],
  omittedCount: number,
  omittedBudgetBytes: number,
): { listedOmittedIds: string[]; sectionText: string } {
  if (omittedCount === 0 || omittedBudgetBytes <= 0) {
    return { listedOmittedIds: [], sectionText: "" };
  }

  const listedOmittedIds: string[] = [];
  const capCount = Math.min(MAX_LISTED_OMITTED_ITEMS, omittedEntryIds.length);

  for (let i = 0; i < capCount; i++) {
    const candidateIds = [...listedOmittedIds, omittedEntryIds[i]];
    const remaining = omittedEntryIds.length - candidateIds.length;
    const moreSuffix = remaining > 0 ? ` ... (+${remaining} more)` : "";
    const candidateLine = `Omitted entryIds (${candidateIds.length}/${omittedCount}): ${candidateIds.join(", ")}${moreSuffix}`;
    if (Buffer.byteLength(candidateLine, "utf8") <= omittedBudgetBytes) {
      listedOmittedIds.push(omittedEntryIds[i]);
    } else {
      break;
    }
  }

  if (listedOmittedIds.length > 0) {
    const remaining = omittedEntryIds.length - listedOmittedIds.length;
    const moreSuffix = remaining > 0 ? ` ... (+${remaining} more)` : "";
    return {
      listedOmittedIds,
      sectionText: `Omitted entryIds (${listedOmittedIds.length}/${omittedCount}): ${listedOmittedIds.join(", ")}${moreSuffix}`,
    };
  }

  const fallbackLine = `Omitted entries: ${omittedCount}`;
  if (Buffer.byteLength(fallbackLine, "utf8") <= omittedBudgetBytes) {
    return { listedOmittedIds: [], sectionText: fallbackLine };
  }

  return { listedOmittedIds: [], sectionText: "" };
}

function findAnchorIndices(items: readonly HistoricalItem[]): number[] {
  let lastUserIdx = -1;
  let lastAssistantIdx = -1;
  let firstUserIdx = -1;

  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "user_message") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
  }

  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "assistant_message") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === "user_message") {
      firstUserIdx = i;
      break;
    }
  }
  if (firstUserIdx === -1) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].role === "user") {
        firstUserIdx = i;
        break;
      }
    }
  }

  const anchors: number[] = [];
  for (const idx of [lastUserIdx, lastAssistantIdx, firstUserIdx]) {
    if (idx !== -1 && !anchors.includes(idx)) {
      anchors.push(idx);
    }
  }
  return anchors;
}

function renderHandoffText(
  headerText: string,
  omittedSection: string,
  formattedItems: readonly string[],
): string {
  const parts: string[] = [headerText];
  if (omittedSection.length > 0) {
    parts.push(omittedSection);
  }
  if (formattedItems.length > 0) {
    parts.push(formattedItems.join("\n\n"));
  }
  return parts.join("\n\n");
}

/**
 * Select historical items by anchor priority (last user -> last assistant -> first user -> reverse backfill)
 * within the reserved budget and render them in chronological order.
 */
export function selectAndRenderHandoff(
  input: SelectAndRenderHandoffInput,
): SelectionResult {
  const rawBudgetBytes = Number.isFinite(input.budgetBytes)
    ? Math.floor(input.budgetBytes)
    : 0;
  const budgetBytes = Math.max(
    0,
    Math.min(MAX_HANDOFF_TOKEN_CAP * 4, rawBudgetBytes),
  );
  const orderedItems = [...input.items].sort((a, b) => a.position - b.position);

  if (budgetBytes === 0) {
    const omittedEntryIds: string[] = [];
    const seen = new Set<string>();
    for (const item of orderedItems) {
      if (!seen.has(item.entryId)) {
        seen.add(item.entryId);
        omittedEntryIds.push(item.entryId);
      }
    }
    return {
      selected: [],
      omittedEntryIds,
      omittedCount: orderedItems.length,
      listedOmittedIds: [],
      renderedText: "",
      estimatedTokens: 0,
      byteLength: 0,
    };
  }

  // Reserve worst-case header size and omitted-ID list budget (<= budgetBytes / 8).
  const worstCaseHeader = buildHeaderText(input, orderedItems, orderedItems.length);
  const headerReserveBytes = Buffer.byteLength(worstCaseHeader, "utf8");
  const omittedBudgetBytes = Math.floor(budgetBytes / 8);
  const itemBudgetBytes = Math.max(
    0,
    budgetBytes - headerReserveBytes - (orderedItems.length > 0 ? omittedBudgetBytes : 0) - 4,
  );

  const selectedIndexSet = new Set<number>();
  const renderedItemByIndex = new Map<number, string>();
  let usedItemBytes = 0;

  const tryAddItem = (idx: number, allowTruncateAnchor: boolean): void => {
    if (selectedIndexSet.has(idx)) {
      return;
    }
    const item = orderedItems[idx];
    const separatorBytes = selectedIndexSet.size > 0 ? 2 : 0; // "\n\n"
    const formatted = formatHistoricalItem(item);
    const fullBytes = Buffer.byteLength(formatted, "utf8");

    if (usedItemBytes + separatorBytes + fullBytes <= itemBudgetBytes) {
      selectedIndexSet.add(idx);
      renderedItemByIndex.set(idx, formatted);
      usedItemBytes += separatorBytes + fullBytes;
      return;
    }

    if (allowTruncateAnchor) {
      const availableForBlock = itemBudgetBytes - usedItemBytes - separatorBytes;
      if (availableForBlock >= MIN_ANCHOR_TRUNCATE_BYTES) {
        const prefix = `### [run ${item.runOrdinal} | ${item.kind} | id: ${item.entryId}]${item.title ? ` (${item.title})` : ""}\n`;
        const suffix = `\n... [truncated; call ${TOOL_NAME_HISTORY_READ}({ entryId: "${item.entryId}", maxCharsPerItem: 4000 })]`;
        const overheadBytes =
          Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
        const bodyBudget = availableForBlock - overheadBytes;
        if (bodyBudget > 32) {
          const clippedBody = truncateToUtf8Bytes(item.text, bodyBudget);
          if (clippedBody.length > 0) {
            const clippedBlock = `${prefix}${clippedBody}${suffix}`;
            selectedIndexSet.add(idx);
            renderedItemByIndex.set(idx, clippedBlock);
            usedItemBytes += separatorBytes + Buffer.byteLength(clippedBlock, "utf8");
          }
        }
      }
    }
  };

  // Priority phase 1: last user -> last assistant -> first user
  const anchorIndices = findAnchorIndices(orderedItems);
  for (const idx of anchorIndices) {
    tryAddItem(idx, true);
  }

  // Priority phase 2: reverse backfill
  for (let i = orderedItems.length - 1; i >= 0; i--) {
    if (!selectedIndexSet.has(i)) {
      tryAddItem(i, false);
    }
  }

  // Chronological order output
  const selectedIndices = Array.from(selectedIndexSet).sort((a, b) => a - b);

  const buildResultForSelection = (indices: number[]): SelectionResult => {
    const indexSet = new Set(indices);
    const selected = indices.map((idx) => orderedItems[idx]);
    const omittedCount = orderedItems.length - selected.length;
    const omittedEntryIds: string[] = [];
    const seenOmitted = new Set<string>();
    for (let i = 0; i < orderedItems.length; i++) {
      if (!indexSet.has(i)) {
        const id = orderedItems[i].entryId;
        if (!seenOmitted.has(id)) {
          seenOmitted.add(id);
          omittedEntryIds.push(id);
        }
      }
    }

    const headerText = buildHeaderText(input, orderedItems, selected.length);
    const { listedOmittedIds, sectionText } = buildOmittedSection(
      omittedEntryIds,
      omittedCount,
      omittedBudgetBytes,
    );
    const formattedItems = indices.map(
      (idx) => renderedItemByIndex.get(idx) ?? formatHistoricalItem(orderedItems[idx]),
    );
    let renderedText = renderHandoffText(headerText, sectionText, formattedItems);
    if (Buffer.byteLength(renderedText, "utf8") > budgetBytes) {
      renderedText = truncateToUtf8Bytes(renderedText, budgetBytes);
    }
    const byteLength = Buffer.byteLength(renderedText, "utf8");

    return {
      selected,
      omittedEntryIds,
      omittedCount,
      listedOmittedIds,
      renderedText,
      estimatedTokens: estimateTextTokens(renderedText),
      byteLength,
    };
  };

  // Ensure unclipped/exact fit within budgetBytes even if header shrunk or budget is very tight.
  const activeIndices = [...selectedIndices];
  let result = buildResultForSelection(activeIndices);
  while (
    activeIndices.length > 0 &&
    Buffer.byteLength(
      renderHandoffText(
        buildHeaderText(input, orderedItems, activeIndices.length),
        buildOmittedSection(
          orderedItems
            .filter((_, idx) => !activeIndices.includes(idx))
            .map((item) => item.entryId)
            .filter((id, i, arr) => arr.indexOf(id) === i),
          orderedItems.length - activeIndices.length,
          omittedBudgetBytes,
        ).sectionText,
        activeIndices.map(
          (idx) => renderedItemByIndex.get(idx) ?? formatHistoricalItem(orderedItems[idx]),
        ),
      ),
      "utf8",
    ) > budgetBytes
  ) {
    // Drop lowest-priority non-anchor first, then anchors in reverse priority.
    const dropCandidate = activeIndices.find((idx) => !anchorIndices.includes(idx));
    if (dropCandidate !== undefined) {
      activeIndices.splice(activeIndices.indexOf(dropCandidate), 1);
    } else {
      let dropped = false;
      for (let p = anchorIndices.length - 1; p >= 0; p--) {
        const pos = activeIndices.indexOf(anchorIndices[p]);
        if (pos !== -1) {
          activeIndices.splice(pos, 1);
          dropped = true;
          break;
        }
      }
      if (!dropped) {
        activeIndices.pop();
      }
    }
    result = buildResultForSelection(activeIndices);
  }

  return result;
}
