import { useSettingsStore } from "../stores/useSettingsStore";
import { useSubscriptionStore } from "../stores/useSubscriptionStore";

// Teammates waiting for the owner to approve/deny a seat. The server returns an
// empty pendingApprovals list to everyone except the owner, so this is always 0
// for members — they never see an approvals count.
export function usePendingApprovalsCount() {
  return useSubscriptionStore((s) => s.status?.pendingApprovals?.length ?? 0);
}

// Single source of truth for the aggregate red badge on the Settings (menu)
// button: the sum of every unviewed notification surfaced inside Settings.
// Today that's unviewed cancellations + pending seat approvals — add future
// Settings notification counts here so every placement of the icon stays in sync.
export function useSettingsBadgeTotal() {
  const cancelled = useSettingsStore((s) => s.unviewedCancelledCount);
  const productNotifs = useSettingsStore((s) => s.unviewedProductNotifCount);
  const approvals = usePendingApprovalsCount();
  return cancelled + productNotifs + approvals;
}
