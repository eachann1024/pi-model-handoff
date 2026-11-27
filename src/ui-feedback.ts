import type { EntryRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import type {
  FrozenHandoffRecord,
  HandoffPreview,
  HandoffStrategy,
  LaneKey,
} from "./types.ts";

function colorize(
  theme: Theme | undefined,
  token: "success" | "muted" | "dim",
  text: string,
): string {
  return theme ? theme.fg(token, text) : text;
}

function formatStrategyLabel(
  strategy: HandoffStrategy | null,
  fallbackReset: boolean,
): string {
  if (fallbackReset) {
    return "保底摘要";
  }
  if (strategy === "delta_since_target_last_seen") {
    return "增量摘要";
  }
  if (strategy === "full_thread_summary") {
    return "首次摘要";
  }
  return "摘要";
}

function formatLaneTransition(
  lane: LaneKey,
  fromLane?: LaneKey | null,
): string {
  const targetModel = formatModelShortName(lane);
  if (
    typeof fromLane === "string" &&
    fromLane.trim().length > 0 &&
    fromLane !== lane
  ) {
    return `${formatModelShortName(fromLane)} → ${targetModel}`;
  }
  return targetModel;
}

function formatHandoffLine(
  theme: Theme | undefined,
  options: {
    prefix: string;
    lane: LaneKey;
    fromLane?: LaneKey | null;
    strategy: HandoffStrategy | null;
    fallbackReset: boolean;
    summaryTokens: number | null;
    summaryApproximate?: boolean;
    detailPrefix?: string;
    remaining: number | null;
    windowTokens: number | null;
  },
): string {
  const laneLabel = formatLaneTransition(options.lane, options.fromLane);
  const mode = formatStrategyLabel(options.strategy, options.fallbackReset);
  const modePart = options.detailPrefix
    ? `${options.detailPrefix} · ${mode}`
    : mode;
  const tokenPart =
    options.summaryTokens !== null
      ? `${options.summaryApproximate ? "约 " : ""}${formatTokenCount(options.summaryTokens)} tokens`
      : null;
  const detail = tokenPart ? `${modePart} · ${tokenPart}` : modePart;
  const mainText = `${options.prefix} ${laneLabel}（${detail}）`;
  const remainingText = formatRemainingContext(
    options.remaining,
    options.windowTokens,
  );
  return `${colorize(theme, "success", mainText)}${colorize(theme, "muted", ` · ${remainingText}`)}`;
}

/** 将 token 数量格式化为紧凑易读的字符串（如 512、16k、1.5M）。 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  const rounded = Math.round(tokens);
  if (rounded >= 1_000_000) {
    const millions = rounded / 1_000_000;
    const formatted =
      millions >= 100
        ? Math.round(millions).toString()
        : millions.toFixed(1).replace(/\.0$/, "");
    return `${formatted}M`;
  }
  if (rounded >= 1_000) {
    const thousands = rounded / 1_000;
    const formatted =
      thousands >= 100
        ? Math.round(thousands).toString()
        : thousands.toFixed(1).replace(/\.0$/, "");
    return `${formatted}k`;
  }
  return String(rounded);
}

/** 格式化会话剩余上下文描述，兼容缺少窗口或剩余数据的情况。 */
export function formatRemainingContext(
  remaining: number | null,
  windowTokens: number | null,
): string {
  const hasRemaining = remaining !== null && Number.isFinite(remaining);
  const hasWindow =
    windowTokens !== null && Number.isFinite(windowTokens) && windowTokens > 0;

  if (hasRemaining && hasWindow) {
    return `会话剩余约 ${formatTokenCount(Math.max(0, remaining))} / ${formatTokenCount(windowTokens)} tokens`;
  }
  if (hasRemaining) {
    return `会话剩余约 ${formatTokenCount(Math.max(0, remaining))} tokens`;
  }
  if (hasWindow) {
    return `上下文窗口 ${formatTokenCount(windowTokens)} tokens`;
  }
  return "会话剩余未知";
}

/** 提取模型短名称（剥离 provider 前缀）。 */
export function formatModelShortName(lane: LaneKey): string {
  const parts = lane
    .trim()
    .split("/")
    .filter((segment) => segment.length > 0);
  if (parts.length === 0) {
    return "未知模型";
  }
  return parts[parts.length - 1];
}

/** 构建待执行模型接管的单行绿色提示 Widget。 */
export function createPendingHandoffWidget(
  preview: HandoffPreview,
): (tui: TUI, theme: Theme) => Component {
  return (_tui: TUI, theme: Theme): Component => {
    if (!preview.willHandoff) {
      const model = formatModelShortName(preview.targetLane);
      const remainingText = formatRemainingContext(
        preview.remainingContextTokens,
        preview.contextWindow,
      );
      const line = `${colorize(theme, "success", `✓ 当前模型 ${model} 无需接管摘要`)}${colorize(theme, "muted", ` · ${remainingText}`)}`;
      return new Text(line, 0, 0);
    }

    const line = formatHandoffLine(theme, {
      prefix: "✓ 已切换至",
      lane: preview.targetLane,
      fromLane: preview.fromLane,
      detailPrefix: "待接管",
      strategy: preview.strategy,
      fallbackReset: preview.fallbackReset,
      summaryTokens: preview.estimatedHandoffTokens,
      summaryApproximate: true,
      remaining: preview.remainingContextTokens,
      windowTokens: preview.contextWindow,
    });
    return new Text(line, 0, 0);
  };
}

/** 构建保底模式生效时的单行绿色提示 Widget。 */
export function createFallbackNoticeWidget(
  targetLane: LaneKey,
  remaining: number | null,
  windowTokens: number | null,
): (tui: TUI, theme: Theme) => Component {
  return (_tui: TUI, theme: Theme): Component => {
    const line = formatHandoffLine(theme, {
      prefix: "✓ 已切换",
      lane: targetLane,
      strategy: null,
      fallbackReset: true,
      summaryTokens: null,
      remaining,
      windowTokens,
    });
    return new Text(line, 0, 0);
  };
}

/** 构建历史接管记录的自定义 Entry 渲染器，展开时附带 1 行省略条数说明。 */
export function createHandoffEntryRenderer(): EntryRenderer<FrozenHandoffRecord> {
  return (entry, options, theme) => {
    const record = entry.data;
    if (!record || typeof record !== "object") {
      return undefined;
    }

    const targetLane =
      typeof record.targetLane === "string" ? record.targetLane : "";
    const fromLane =
      typeof record.fromLane === "string" ? record.fromLane : null;
    const strategy =
      record.strategy === "delta_since_target_last_seen" ||
      record.strategy === "full_thread_summary"
        ? record.strategy
        : null;
    const summaryTokens =
      typeof record.estimatedTokens === "number" &&
      Number.isFinite(record.estimatedTokens)
        ? record.estimatedTokens
        : null;
    const remaining =
      typeof record.remainingContextTokens === "number" &&
      Number.isFinite(record.remainingContextTokens)
        ? record.remainingContextTokens
        : null;
    const windowTokens =
      typeof record.modelContextWindow === "number" &&
      Number.isFinite(record.modelContextWindow)
        ? record.modelContextWindow
        : null;

    const firstLine = formatHandoffLine(theme, {
      prefix: "✓ 模型交接已接管 ·",
      lane: targetLane,
      fromLane,
      strategy,
      fallbackReset: Boolean(record.fallbackReset),
      summaryTokens,
      remaining,
      windowTokens,
    });

    if (!options.expanded) {
      return new Text(firstLine, 0, 0);
    }

    const includedCount =
      typeof record.includedCount === "number" &&
      Number.isFinite(record.includedCount)
        ? record.includedCount
        : 0;
    const omittedCount =
      typeof record.omittedCount === "number" &&
      Number.isFinite(record.omittedCount)
        ? record.omittedCount
        : 0;
    const detailLine = colorize(
      theme,
      "dim",
      `  已纳入 ${includedCount} 条，省略 ${omittedCount} 条历史`,
    );
    return new Text(`${firstLine}\n${detailLine}`, 0, 0);
  };
}

/** 生成状态栏绿色提示文案；若当前无需展示则返回 undefined。 */
export function formatGreenStatusText(
  theme: Theme | undefined,
  params: {
    targetLane: LaneKey | null;
    bypass: boolean;
    remainingTokens: number | null;
    contextWindow: number | null;
    latestRecord?: FrozenHandoffRecord | null;
    pendingPreview?: HandoffPreview | null;
  },
): string | undefined {
  if (!params.targetLane) {
    return undefined;
  }

  if (params.bypass) {
    const model = formatModelShortName(params.targetLane);
    const remainingText = formatRemainingContext(
      params.remainingTokens,
      params.contextWindow,
    );
    return colorize(theme, "muted", `接管已暂停（${model}） · ${remainingText}`);
  }

  if (params.pendingPreview?.willHandoff) {
    return formatHandoffLine(theme, {
      prefix: "✓ 待接管",
      lane: params.pendingPreview.targetLane,
      strategy: params.pendingPreview.strategy,
      fallbackReset: params.pendingPreview.fallbackReset,
      summaryTokens: params.pendingPreview.estimatedHandoffTokens,
      remaining:
        params.pendingPreview.remainingContextTokens ?? params.remainingTokens,
      windowTokens:
        params.pendingPreview.contextWindow ?? params.contextWindow,
    });
  }

  if (params.latestRecord) {
    return formatHandoffLine(theme, {
      prefix: "✓ 已接管",
      lane: params.targetLane,
      strategy: params.latestRecord.strategy,
      fallbackReset: Boolean(params.latestRecord.fallbackReset),
      summaryTokens: params.latestRecord.estimatedTokens,
      remaining:
        params.remainingTokens ??
        params.latestRecord.remainingContextTokens ??
        null,
      windowTokens:
        params.contextWindow ?? params.latestRecord.modelContextWindow ?? null,
    });
  }

  if (params.remainingTokens !== null || params.contextWindow !== null) {
    const model = formatModelShortName(params.targetLane);
    const remainingText = formatRemainingContext(
      params.remainingTokens,
      params.contextWindow,
    );
    return `${colorize(theme, "success", `✓ ${model}`)}${colorize(theme, "muted", ` · ${remainingText}`)}`;
  }

  return undefined;
}

/** 生成状态查询命令的可读摘要文本。 */
export function formatStatusCommandSummary(params: {
  targetLane: LaneKey | null;
  bypass: boolean;
  tokenCap: number;
  totalRuns: number;
  targetRecordCount: number;
  latestRecord: FrozenHandoffRecord | null;
  remainingTokens: number | null;
  contextWindow: number | null;
  pendingPreview: HandoffPreview | null;
}): string {
  const stateLabel = params.bypass ? "已暂停（直通）" : "已启用";
  const targetModel = params.targetLane
    ? formatModelShortName(params.targetLane)
    : "未指定";
  const remainingText = formatRemainingContext(
    params.remainingTokens,
    params.contextWindow,
  );

  const lines: string[] = [
    `模型接管：${stateLabel} · 目标模型 ${targetModel} · ${remainingText}`,
    `摘要上限：${formatTokenCount(params.tokenCap)} tokens · 会话轮次 ${params.totalRuns} · 当前模型记录 ${params.targetRecordCount} 条`,
  ];

  if (params.pendingPreview?.willHandoff) {
    const pendingModel = formatModelShortName(params.pendingPreview.targetLane);
    const pendingMode = formatStrategyLabel(
      params.pendingPreview.strategy,
      params.pendingPreview.fallbackReset,
    );
    lines.push(
      `待执行接管：${pendingModel}（${pendingMode} · 约 ${formatTokenCount(params.pendingPreview.estimatedHandoffTokens)} tokens）`,
    );
  }

  if (params.latestRecord) {
    const latestModel = formatModelShortName(params.latestRecord.targetLane);
    const latestMode = formatStrategyLabel(
      params.latestRecord.strategy,
      Boolean(params.latestRecord.fallbackReset),
    );
    lines.push(
      `最近接管：${latestModel}（${latestMode} · ${formatTokenCount(params.latestRecord.estimatedTokens)} tokens · 覆盖第 ${params.latestRecord.coveredRunFrom}-${params.latestRecord.coveredRunTo} 轮 · 纳入 ${params.latestRecord.includedCount} 条 / 省略 ${params.latestRecord.omittedCount} 条）`,
    );
  } else {
    lines.push("最近接管：暂无");
  }

  return lines.join("\n");
}
