import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import {
  THREAD_READ_RESULT_MAX_BYTES,
  type ThreadHistoryReadItem,
  type ThreadHistoryReadParams,
  type ThreadHistoryReadResult,
} from "./types.ts";

type UserMessage = Extract<AgentMessage, { role: "user" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type BashExecutionMessage = Extract<AgentMessage, { role: "bashExecution" }>;

const DEFAULT_LIMIT = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

const DEFAULT_MAX_CHARS_PER_ITEM = 4_000;
const MIN_MAX_CHARS_PER_ITEM = 200;
const MAX_MAX_CHARS_PER_ITEM = 20_000;

const MESSAGE_VIEW_TYPES = new Set<string>([
  "user_message",
  "assistant_message",
  "custom_message",
  "compaction",
  "branch_summary",
]);

interface TimelineEntry {
  position: number;
  entryId: string;
  runOrdinal: number;
  type: string;
  role: string;
  title?: string;
  fullText: string;
  timestamp: number;
}

interface SlicedTimelineEntry {
  entry: TimelineEntry;
  startOffset: number;
  item: ThreadHistoryReadItem;
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  const intValue = Math.trunc(value);
  return Math.min(max, Math.max(min, intValue));
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function parseEntryTimestamp(isoTimestamp: string, messageTimestamp?: number): number {
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
    return messageTimestamp;
  }
  const parsed = Date.parse(isoTimestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      if (part.text.length > 0) {
        parts.push(part.text);
      }
      continue;
    }
    if (part.type === "image") {
      const mime = typeof part.mimeType === "string" && part.mimeType.length > 0 ? part.mimeType : "image";
      parts.push(`[image: ${mime}]`);
      continue;
    }
    if (part.type === "toolCall" && typeof part.name === "string") {
      const args = "arguments" in part ? safeJsonStringify(part.arguments) : "{}";
      const errSuffix =
        typeof part.argumentsError === "string" && part.argumentsError.length > 0
          ? ` (argumentsError: ${part.argumentsError})`
          : "";
      parts.push(`[toolCall: ${part.name}] ${args}${errSuffix}`);
    }
  }
  return parts.join("\n");
}

function formatAssistantText(msg: AssistantMessage): string {
  const parts: string[] = [];
  const body = extractContentText(msg.content);
  if (body.length > 0) {
    parts.push(body);
  }
  if (typeof msg.errorMessage === "string" && msg.errorMessage.length > 0) {
    parts.push(`[error] ${msg.errorMessage}`);
  } else if ((msg.stopReason === "error" || msg.stopReason === "aborted") && parts.length === 0) {
    parts.push(`[${msg.stopReason}]`);
  }
  return parts.join("\n");
}

function formatBashExecutionText(msg: BashExecutionMessage): string {
  let text = `Ran \`${msg.command}\`\n`;
  if (msg.output) {
    text += `\`\`\`\n${msg.output}\n\`\`\``;
  } else {
    text += "(no output)";
  }
  if (msg.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`;
  }
  if (msg.truncated) {
    if (msg.fullOutputPath) {
      text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
    } else if (msg.fullOutputError) {
      text += `\n\n[Output truncated. Could not save the full output: ${msg.fullOutputError}]`;
    } else {
      text += "\n\n[Output truncated]";
    }
  }
  if (msg.excludeFromContext) {
    text += "\n\n[Excluded from LLM context]";
  }
  return text;
}

function formatShortTitle(raw: string, maxLength = 120): string | undefined {
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return undefined;
  }
  if (firstLine.length <= maxLength) {
    return firstLine;
  }
  return `${firstLine.slice(0, maxLength - 3)}...`;
}

function mapMessageEntry(
  entry: SessionMessageEntry,
  position: number,
  runOrdinal: number,
): TimelineEntry | null {
  const msg = entry.message;

  switch (msg.role) {
    case "user": {
      const userMsg = msg as UserMessage;
      return {
        position,
        entryId: entry.id,
        runOrdinal,
        type: "user_message",
        role: "user",
        fullText: extractContentText(userMsg.content),
        timestamp: parseEntryTimestamp(entry.timestamp, userMsg.timestamp),
      };
    }
    case "assistant": {
      const assistantMsg = msg as AssistantMessage;
      const modelTitle =
        typeof assistantMsg.model === "string" && assistantMsg.model.length > 0
          ? assistantMsg.provider
            ? `${assistantMsg.provider}/${assistantMsg.model}`
            : assistantMsg.model
          : undefined;
      return {
        position,
        entryId: entry.id,
        runOrdinal,
        type: "assistant_message",
        role: "assistant",
        title: modelTitle,
        fullText: formatAssistantText(assistantMsg),
        timestamp: parseEntryTimestamp(entry.timestamp, assistantMsg.timestamp),
      };
    }
    case "toolResult": {
      const toolMsg = msg as ToolResultMessage;
      const body = extractContentText(toolMsg.content);
      const fullText = toolMsg.isError
        ? body.length > 0
          ? `[error] ${body}`
          : "[error]"
        : body;
      return {
        position,
        entryId: entry.id,
        runOrdinal,
        type: "tool_result",
        role: "toolResult",
        title: toolMsg.isError ? `${toolMsg.toolName} (error)` : toolMsg.toolName,
        fullText,
        timestamp: parseEntryTimestamp(entry.timestamp, toolMsg.timestamp),
      };
    }
    case "bashExecution": {
      const bashMsg = msg as BashExecutionMessage;
      return {
        position,
        entryId: entry.id,
        runOrdinal,
        type: "bash_execution",
        role: "bashExecution",
        title: formatShortTitle(bashMsg.command),
        fullText: formatBashExecutionText(bashMsg),
        timestamp: parseEntryTimestamp(entry.timestamp, bashMsg.timestamp),
      };
    }
    default:
      return null;
  }
}

function mapCustomMessageEntry(
  entry: CustomMessageEntry,
  position: number,
  runOrdinal: number,
): TimelineEntry {
  return {
    position,
    entryId: entry.id,
    runOrdinal,
    type: "custom_message",
    role: "custom",
    title: entry.customType,
    fullText: extractContentText(entry.content),
    timestamp: parseEntryTimestamp(entry.timestamp),
  };
}

function mapCompactionEntry(
  entry: CompactionEntry,
  position: number,
  runOrdinal: number,
): TimelineEntry {
  return {
    position,
    entryId: entry.id,
    runOrdinal,
    type: "compaction",
    role: "system",
    title: "Compaction summary",
    fullText: entry.summary,
    timestamp: parseEntryTimestamp(entry.timestamp),
  };
}

function mapBranchSummaryEntry(
  entry: BranchSummaryEntry,
  position: number,
  runOrdinal: number,
): TimelineEntry {
  return {
    position,
    entryId: entry.id,
    runOrdinal,
    type: "branch_summary",
    role: "system",
    title: "Branch summary",
    fullText: entry.summary,
    timestamp: parseEntryTimestamp(entry.timestamp),
  };
}

/** Build a 0-based chronological timeline of all readable entries on a branch. */
function buildTimeline(branch: readonly SessionEntry[]): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  let currentRunOrdinal = 0;

  for (const entry of branch) {
    if (entry.type === "message") {
      if (entry.message.role === "user") {
        currentRunOrdinal += 1;
      }
      const mapped = mapMessageEntry(entry, timeline.length, currentRunOrdinal);
      if (mapped !== null) {
        timeline.push(mapped);
      }
      continue;
    }

    if (entry.type === "custom_message") {
      timeline.push(mapCustomMessageEntry(entry, timeline.length, currentRunOrdinal));
      continue;
    }

    if (entry.type === "compaction") {
      timeline.push(mapCompactionEntry(entry, timeline.length, currentRunOrdinal));
      continue;
    }

    if (entry.type === "branch_summary") {
      timeline.push(mapBranchSummaryEntry(entry, timeline.length, currentRunOrdinal));
    }
  }

  return timeline;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function adjustStartOffset(text: string, offset: number): number {
  if (offset <= 0 || offset >= text.length) {
    return offset;
  }
  if (isLowSurrogate(text.charCodeAt(offset)) && isHighSurrogate(text.charCodeAt(offset - 1))) {
    return offset + 1;
  }
  return offset;
}

function adjustEndOffset(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length) {
    return Math.min(text.length, Math.max(start, end));
  }
  if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    return end - 1 > start ? end - 1 : end;
  }
  return end;
}

function sliceTimelineEntry(
  entry: TimelineEntry,
  rawOffset: number,
  maxChars: number,
): SlicedTimelineEntry {
  const fullText = entry.fullText;
  const startOffset = adjustStartOffset(fullText, Math.max(0, rawOffset));

  let text = "";
  let textTruncated = false;
  let nextTextOffset: number | null = null;

  if (startOffset < fullText.length) {
    const endOffset = adjustEndOffset(fullText, startOffset, startOffset + maxChars);
    text = fullText.slice(startOffset, endOffset);
    textTruncated = endOffset < fullText.length;
    nextTextOffset = textTruncated ? endOffset : null;
  }

  const item: ThreadHistoryReadItem = {
    position: entry.position,
    entryId: entry.entryId,
    runOrdinal: entry.runOrdinal,
    type: entry.type,
    role: entry.role,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    text,
    textTruncated,
    nextTextOffset,
    timestamp: entry.timestamp,
  };

  return { entry, startOffset, item };
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function computePaginationState(
  referenceList: readonly TimelineEntry[],
  selectedItems: readonly ThreadHistoryReadItem[],
  mode: "entry" | "forward" | "backward" | "latest",
): {
  earlierPosition: number | null;
  nextPosition: number | null;
  hasMore: boolean;
} {
  if (selectedItems.length === 0) {
    return { earlierPosition: null, nextPosition: null, hasMore: false };
  }

  const firstPos = selectedItems[0].position;
  const lastPos = selectedItems[selectedItems.length - 1].position;
  const hasEarlier = referenceList.some((entry) => entry.position < firstPos);
  const hasLater = referenceList.some((entry) => entry.position > lastPos);

  const earlierPosition = hasEarlier ? firstPos : null;
  const nextPosition = hasLater ? lastPos : null;

  let hasMore = false;
  if (mode === "entry") {
    hasMore = selectedItems[0].textTruncated;
  } else if (mode === "forward") {
    hasMore = hasLater;
  } else {
    hasMore = hasEarlier;
  }

  return { earlierPosition, nextPosition, hasMore };
}

function measureResultBytes(result: ThreadHistoryReadResult): {
  formattedBytes: number;
  maxBytes: number;
} {
  const formattedBytes = utf8ByteLength(formatHistoryReadText(result));
  const withByteLength: ThreadHistoryReadResult = {
    ...result,
    byteLength: formattedBytes,
  };
  const jsonBytes = utf8ByteLength(JSON.stringify(withByteLength));
  return {
    formattedBytes,
    maxBytes: Math.max(formattedBytes, jsonBytes),
  };
}

function buildResultFromSlices(
  totalItems: number,
  referenceList: readonly TimelineEntry[],
  slices: readonly SlicedTimelineEntry[],
  mode: "entry" | "forward" | "backward" | "latest",
): ThreadHistoryReadResult {
  const items = slices.map((slice) => slice.item);
  const pagination = computePaginationState(referenceList, items, mode);
  return {
    totalItems,
    items,
    nextPosition: pagination.nextPosition,
    earlierPosition: pagination.earlierPosition,
    hasMore: pagination.hasMore,
    byteLength: 0,
  };
}

function enforceByteLimit(
  totalItems: number,
  referenceList: readonly TimelineEntry[],
  initialSlices: SlicedTimelineEntry[],
  mode: "entry" | "forward" | "backward" | "latest",
): ThreadHistoryReadResult {
  const slices = [...initialSlices];
  let result = buildResultFromSlices(totalItems, referenceList, slices, mode);
  let { formattedBytes, maxBytes } = measureResultBytes(result);

  // Drop overflow items while keeping at least 1 item when non-empty.
  while (slices.length > 1 && maxBytes > THREAD_READ_RESULT_MAX_BYTES) {
    if (mode === "forward") {
      slices.pop();
    } else {
      slices.shift();
    }
    result = buildResultFromSlices(totalItems, referenceList, slices, mode);
    ({ formattedBytes, maxBytes } = measureResultBytes(result));
  }

  // Safely truncate the single remaining item if it still exceeds the 30,000-byte cap.
  if (slices.length === 1 && maxBytes > THREAD_READ_RESULT_MAX_BYTES) {
    const target = slices[0];
    const fullText = target.entry.fullText;
    const startOffset = target.startOffset;

    let low = 0;
    let high = target.item.text.length;
    let bestEnd = startOffset;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const candidateEnd = adjustEndOffset(fullText, startOffset, startOffset + mid);
      const candidateText = fullText.slice(startOffset, candidateEnd);
      const candidateTruncated = candidateEnd < fullText.length;
      const candidateItem: ThreadHistoryReadItem = {
        ...target.item,
        text: candidateText,
        textTruncated: candidateTruncated,
        nextTextOffset: candidateTruncated ? candidateEnd : null,
      };
      const candidateResult = buildResultFromSlices(
        totalItems,
        referenceList,
        [{ entry: target.entry, startOffset, item: candidateItem }],
        mode,
      );
      const measured = measureResultBytes(candidateResult);
      if (measured.maxBytes <= THREAD_READ_RESULT_MAX_BYTES) {
        bestEnd = candidateEnd;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const finalText = fullText.slice(startOffset, bestEnd);
    const finalTruncated = bestEnd < fullText.length;
    slices[0] = {
      entry: target.entry,
      startOffset,
      item: {
        ...target.item,
        text: finalText,
        textTruncated: finalTruncated,
        nextTextOffset: finalTruncated ? bestEnd : null,
      },
    };
    result = buildResultFromSlices(totalItems, referenceList, slices, mode);
    ({ formattedBytes } = measureResultBytes(result));
  }

  return {
    ...result,
    byteLength: formattedBytes,
  };
}

/**
 * Read and paginate readable history entries from a session branch.
 *
 * When `params.entryId` is specified, `view` is ignored and the matching entry
 * is sliced by `textOffset` and `maxCharsPerItem`. Otherwise entries are
 * filtered by `view` (`"messages"` by default, or `"activity"`) and paginated
 * in chronological order.
 */
export function readBranchHistory(
  branch: readonly SessionEntry[],
  params: ThreadHistoryReadParams = {},
): ThreadHistoryReadResult {
  const timeline = buildTimeline(branch);
  const totalItems = timeline.length;
  const maxCharsPerItem = clampInteger(
    params.maxCharsPerItem,
    DEFAULT_MAX_CHARS_PER_ITEM,
    MIN_MAX_CHARS_PER_ITEM,
    MAX_MAX_CHARS_PER_ITEM,
  );

  if (typeof params.entryId === "string" && params.entryId.length > 0) {
    const matched = timeline.find((entry) => entry.entryId === params.entryId);
    if (!matched) {
      return enforceByteLimit(totalItems, timeline, [], "entry");
    }
    const textOffset = normalizeOffset(params.textOffset);
    const sliced = sliceTimelineEntry(matched, textOffset, maxCharsPerItem);
    return enforceByteLimit(totalItems, timeline, [sliced], "entry");
  }

  const view = params.view === "activity" ? "activity" : "messages";
  const filtered =
    view === "activity"
      ? timeline
      : timeline.filter((entry) => MESSAGE_VIEW_TYPES.has(entry.type));

  const limit = clampInteger(params.limit, DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
  const hasAfter =
    params.afterPosition !== undefined && Number.isFinite(params.afterPosition);
  const hasBefore =
    params.beforePosition !== undefined && Number.isFinite(params.beforePosition);

  let candidates = filtered;
  if (hasAfter) {
    const afterPos = Math.trunc(params.afterPosition as number);
    candidates = candidates.filter((entry) => entry.position > afterPos);
  }
  if (hasBefore) {
    const beforePos = Math.trunc(params.beforePosition as number);
    candidates = candidates.filter((entry) => entry.position < beforePos);
  }

  const mode: "forward" | "backward" | "latest" = hasAfter
    ? "forward"
    : hasBefore
      ? "backward"
      : "latest";

  const selected =
    mode === "forward" ? candidates.slice(0, limit) : candidates.slice(-limit);
  const sliced = selected.map((entry) => sliceTimelineEntry(entry, 0, maxCharsPerItem));

  return enforceByteLimit(totalItems, filtered, sliced, mode);
}

function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "unknown";
  }
  return new Date(timestamp).toISOString();
}

/** Format a `ThreadHistoryReadResult` into a readable text block for model consumption. */
export function formatHistoryReadText(result: ThreadHistoryReadResult): string {
  if (result.items.length === 0) {
    return `No matching history entries (totalItems=${result.totalItems}).`;
  }

  const header = [
    `History (${result.items.length} of ${result.totalItems} total items`,
    `hasMore=${result.hasMore}`,
    `earlierPosition=${result.earlierPosition ?? "null"}`,
    `nextPosition=${result.nextPosition ?? "null"})`,
  ].join("; ");

  const blocks = result.items.map((item) => {
    const titlePart = item.title ? ` title=${JSON.stringify(item.title)}` : "";
    const meta = `[${item.position}] entryId=${item.entryId} run=${item.runOrdinal} type=${item.type} role=${item.role}${titlePart} ts=${formatTimestamp(item.timestamp)}`;
    const truncationNote = item.textTruncated
      ? `\n...[truncated; nextTextOffset=${item.nextTextOffset}]`
      : "";
    return `${meta}\n${item.text}${truncationNote}`;
  });

  return `${header}\n\n${blocks.join("\n\n")}`;
}
