import { isDesktopPanelAvailable } from "../../app/panel-availability.ts";
import { loadSettings } from "../../app/settings.ts";
import { canonicalUiSessionKeyForPersistence } from "../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { createBackgroundTasksProps } from "./components/chat-background-tasks.ts";
import { openTaskDetailId } from "./components/chat-detail-slot.ts";
import { createSessionWorkspaceProps } from "./components/chat-session-workspace.ts";
import {
  closeSlot,
  isSidebarSlotVisible,
  openSlot,
  openDashboardPresentation,
  type SidebarSlotId,
} from "./sidebar-layout.ts";

type ChatPaneSidebarLayout = Parameters<typeof isSidebarSlotVisible>[0];
type ChatPaneGatewaySnapshot = Parameters<typeof isDesktopPanelAvailable>[0];

export function releaseAttachmentWorkspaceOwner(state: ChatPageHost, slot: SidebarSlotId): void {
  // Attachment views temporarily own Files content. Release that owner
  // with the slot so reopening Files restores the session workspace.
  if (slot === "workspace") {
    state.attachmentSidebarContent = null;
  }
}

/** Builds the two rail models and their shared sidebar slot controls. */
export function createChatPaneRails(params: {
  state: ChatPageHost;
  sidebarLayout: ChatPaneSidebarLayout;
  presentationId: string;
  presented: boolean;
  gatewaySnapshot: ChatPaneGatewaySnapshot;
  setObserverVisibility: (visible: boolean) => void;
  updateSidebarLayout: ChatPageHost["updateSidebarLayout"];
}) {
  const { state, sidebarLayout } = params;
  const isPanelVisible = (slot: SidebarSlotId) => isSidebarSlotVisible(sidebarLayout, slot);
  const openPanelSlot = (slot: SidebarSlotId) => {
    const savedLayout =
      slot === "dashboard"
        ? loadSettings().sidebarSessionLayouts?.[
            canonicalUiSessionKeyForPersistence(state, state.sessionKey)
          ]
        : undefined;
    // Selecting an existing legacy tab is not a new fullscreen/split choice.
    const legacy =
      savedLayout !== undefined && savedLayout.dashboardPresentationOverride === undefined;
    const override = savedLayout ? savedLayout.dashboardPresentationOverride : null;
    const nextLayout =
      slot === "dashboard"
        ? { ...sidebarLayout, dashboardPresentationOverride: override }
        : sidebarLayout;
    params.updateSidebarLayout(
      slot === "dashboard" && !legacy
        ? openDashboardPresentation(
            nextLayout,
            override ?? selectedChatSessionRow(state)?.boardPresentation ?? "split",
          )
        : openSlot(nextLayout, slot),
    );
    if (slot === "companion") {
      params.setObserverVisibility(true);
    }
  };
  const closePanelSlot = (slot: SidebarSlotId) => {
    if (slot === "companion") {
      params.setObserverVisibility(false);
    }
    releaseAttachmentWorkspaceOwner(state, slot);
    params.updateSidebarLayout(closeSlot(sidebarLayout, slot));
  };
  const togglePanelSlot = (slot: SidebarSlotId) =>
    isPanelVisible(slot) ? closePanelSlot(slot) : openPanelSlot(slot);
  const sessionWorkspaceBase = createSessionWorkspaceProps(state, {
    draftScope: params.presentationId,
    expanded: isSidebarSlotVisible(sidebarLayout, "workspace"),
    narrowLayout: false,
    presented: params.presented,
  });
  const sessionWorkspace = {
    ...sessionWorkspaceBase,
    collapsed: !isPanelVisible("workspace"),
    narrowLayout: false,
    onToggleCollapsed: () => togglePanelSlot("workspace"),
    onToggleTerminal: state.terminalAvailable ? () => togglePanelSlot("terminal") : undefined,
    onToggleBrowser: state.browserPanelAvailable ? () => togglePanelSlot("browser") : undefined,
    onToggleDesktop: isDesktopPanelAvailable(params.gatewaySnapshot)
      ? () => togglePanelSlot("desktop")
      : undefined,
  };
  const backgroundTasksBase = createBackgroundTasksProps(state, {
    narrowLayout: false,
    openTaskId: openTaskDetailId(state.sidebarContent, sidebarLayout),
    onOpenTaskDetail: (task) => state.handleOpenSidebar({ kind: "task", taskId: task.id }),
    presented: params.presented,
  });
  const backgroundTasks = {
    ...backgroundTasksBase,
    collapsed: !isPanelVisible("tasks"),
    narrowLayout: false,
    onToggleCollapsed: () => togglePanelSlot("tasks"),
  };
  return {
    backgroundTasks,
    closePanelSlot,
    openPanelSlot,
    sessionWorkspace,
  };
}
