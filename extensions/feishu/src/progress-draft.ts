// Feishu-specific structured lines for the shared progress-draft compositor.
// Draft text itself comes from the compositor's shared formatter
// (formatChannelProgressDraftTextForStreaming), so the streaming card renders
// the same compact progress layout as the other draft-based channels.
import type { ChannelProgressDraftCompositorLine } from "openclaw/plugin-sdk/channel-outbound";

const FEISHU_COMPACTION_PROGRESS_ID = "context-compaction";

export function buildFeishuCompactionProgressLine(
  phase: "start" | "complete" | "incomplete",
): ChannelProgressDraftCompositorLine {
  const label = {
    start: "Compacting context...",
    complete: "Compaction complete",
    incomplete: "Compaction incomplete",
  }[phase];
  return {
    id: FEISHU_COMPACTION_PROGRESS_ID,
    kind: "item",
    icon: "🧹",
    label,
    text: `🧹 ${label}`,
    prefix: false,
  };
}
