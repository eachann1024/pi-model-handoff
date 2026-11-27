import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const HANDOFF_ENTRY_TYPE = "pi-model-handoff:record";
export const STATUS_KEY = "pi-model-handoff";
export const TOOL_NAME_HISTORY_READ = "thread_history_read";

export const DEFAULT_HANDOFF_TOKEN_CAP = 16_000;
export const MIN_HANDOFF_TOKEN_CAP = 1_024;
export const MAX_HANDOFF_TOKEN_CAP = 64_000;
export const HANDOFF_BYTE_CAP = 64_000;
export const MAX_LISTED_OMITTED_ITEMS = 20;
export const MIN_DELTA_BUDGET_BYTES = 512;
export const THREAD_READ_RESULT_MAX_BYTES = 30_000;

export type LaneKey = string;

export type HandoffStrategy =
  | "full_thread_summary"
  | "delta_since_target_last_seen";

export type HistoricalItemRole = "user" | "assistant";

export type HistoricalItemKind =
  | "user_message"
  | "assistant_message"
  | "command_execution"
  | "file_change"
  | "error"
  | "compaction_summary"
  | "branch_summary";

export interface HistoricalItem {
  entryId: string;
  runOrdinal: number;
  position: number;
  role: HistoricalItemRole;
  kind: HistoricalItemKind;
  title?: string;
  text: string;
  timestamp: number;
}

export interface ConversationRun {
  ordinal: number;
  userEntryId: string;
  startIndex: number;
  endIndex: number;
  ownerLane: LaneKey | null;
  delivered: boolean;
  hasError: boolean;
  entries: SessionEntry[];
  lastUsageInputTokens?: number;
}

export interface FrozenHandoffRecord {
  version: 1;
  targetLane: LaneKey;
  fromLane: LaneKey | null;
  anchorUserEntryId: string;
  strategy: HandoffStrategy;
  fallbackReset: boolean;
  coveredRunFrom: number;
  coveredRunTo: number;
  sourceEntryFrom: string | null;
  sourceEntryTo: string | null;
  includedCount: number;
  omittedCount: number;
  omittedEntryIds: string[];
  estimatedTokens: number;
  byteLength: number;
  renderedText: string;
  createdAt: number;
}

export interface BudgetInput {
  tokenCap: number;
  modelContextWindow?: number;
  nativeTokens: number;
  currentUserText: string;
  currentImageCount?: number;
  currentOtherAttachmentCount?: number;
}

export interface BudgetResult {
  budgetBytes: number;
  windowTokens: number;
  workReserveTokens: number;
  nativeTokens: number;
  currentTokens: number;
}

export interface SelectAndRenderHandoffInput {
  items: HistoricalItem[];
  strategy: HandoffStrategy;
  targetLane: LaneKey;
  fromLane: LaneKey | null;
  coveredRunFrom: number;
  coveredRunTo: number;
  budgetBytes: number;
  fallbackReset?: boolean;
}

export interface SelectionResult {
  selected: HistoricalItem[];
  omittedEntryIds: string[];
  omittedCount: number;
  listedOmittedIds: string[];
  renderedText: string;
  estimatedTokens: number;
  byteLength: number;
}

export interface ProjectMessagesInput {
  eventMessages: AgentMessage[];
  branch: SessionEntry[];
  targetLane: LaneKey;
  modelContextWindow?: number;
  tokenCap: number;
  extraRecords?: ReadonlyMap<string, FrozenHandoffRecord>;
  bypass?: boolean;
}

export interface ProjectionResult {
  messages: AgentMessage[];
  modified: boolean;
  activeLane: LaneKey;
  newRecord: FrozenHandoffRecord | null;
  appliedRecords: FrozenHandoffRecord[];
  keptNativeRuns: number;
  totalRuns: number;
}

export interface ThreadHistoryReadParams {
  entryId?: string;
  textOffset?: number;
  view?: "messages" | "activity";
  beforePosition?: number;
  afterPosition?: number;
  limit?: number;
  maxCharsPerItem?: number;
}

export interface ThreadHistoryReadItem {
  position: number;
  entryId: string;
  runOrdinal: number;
  type: string;
  role: string;
  title?: string;
  text: string;
  textTruncated: boolean;
  nextTextOffset: number | null;
  timestamp: number;
}

export interface ThreadHistoryReadResult {
  totalItems: number;
  items: ThreadHistoryReadItem[];
  nextPosition: number | null;
  earlierPosition: number | null;
  hasMore: boolean;
  byteLength: number;
}
