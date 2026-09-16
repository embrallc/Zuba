import { useCallback, useEffect, useState } from "react";
import { logError } from "../db/logs";
import { getDrivePromptSeen, markDrivePromptSeen } from "../db/organizations";
import { useSettingsStore } from "../stores/useSettingsStore";
import { isOnline } from "../utils/connectivity";
import { getDriveStatus } from "../utils/drive";

// One-time "set up Google Drive backup" nudge for an ORG owner. Returns
// { showPrompt, dismiss }.
//
// Google Drive backup is FORWARD-ONLY: nothing completed before the owner
// connects ever lands in their Drive, and recovering it later means a support
// request. So owners get exactly one prompt, early — after that the entry point
// lives in Settings → Integrations.
//
// Gated like useOwnerSetup: owner only, org-level, one-way (dismissing is
// permanent, even for a different member or a later sign-in). `defer` lets the
// caller hold it back while the first-run setup card is on screen, so a brand
// new owner is never double-prompted.
export function useDriveBackupPrompt({ defer = false } = {}) {
  const userProfile = useSettingsStore((s) => s.userProfile);
  const orgSk = useSettingsStore((s) => s.orgSk);
  const isOwner = userProfile === "owner";

  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    if (!isOwner || !orgSk || defer || !isOnline()) {
      setShowPrompt(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Fails CLOSED (returns true) on any error, so a flaky read never nags.
        const seen = await getDrivePromptSeen(orgSk);
        if (cancelled || seen) {
          if (!cancelled) setShowPrompt(false);
          return;
        }
        // Not seen yet — but if they've already connected (e.g. found it in
        // Settings first), they're set up: retire the prompt quietly.
        let connected = false;
        try {
          const status = await getDriveStatus();
          connected = !!status?.connected;
        } catch (e) {
          // A status failure shouldn't decide anything; fall through and prompt.
          logError(e, "useDriveBackupPrompt.status");
        }
        if (cancelled) return;
        if (connected) {
          markDrivePromptSeen(orgSk).catch(() => {});
          setShowPrompt(false);
        } else {
          setShowPrompt(true);
        }
      } catch (e) {
        logError(e, "useDriveBackupPrompt.evaluate");
        if (!cancelled) setShowPrompt(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwner, orgSk, defer]);

  const dismiss = useCallback(async () => {
    setShowPrompt(false); // hide immediately; the flag write is best-effort
    if (!orgSk) return;
    try {
      await markDrivePromptSeen(orgSk);
    } catch (e) {
      logError(e, "useDriveBackupPrompt.dismiss");
    }
  }, [orgSk]);

  return { showPrompt, dismiss };
}
