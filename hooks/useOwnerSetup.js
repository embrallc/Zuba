import { useCallback, useEffect, useState } from "react";
import { logError } from "../db/logs";
import {
  getWalkthroughIntroSeen,
  markWalkthroughIntroSeen,
} from "../db/organizations";
import {
  fetchAndCacheTemplate,
  getCachedTemplate,
} from "../db/walkthroughForms";
import { useSettingsStore } from "../stores/useSettingsStore";
import { isOnline } from "../utils/connectivity";

// First-run guidance gate for a new ORG owner. Returns { showSetup, hasForm,
// markDone }. The setup card shows at most once per org — only for the owner,
// only while the intro flag is false, and never again once they publish a
// walkthrough form OR dismiss it (markDone). Deliberately org-level + one-way,
// so deleting the form later, or a member signing in, never re-triggers it.
export function useOwnerSetup() {
  const userProfile = useSettingsStore((s) => s.userProfile);
  const orgSk = useSettingsStore((s) => s.orgSk);
  const isOwner = userProfile === "owner";

  const [showSetup, setShowSetup] = useState(false);
  const [hasForm, setHasForm] = useState(false);

  useEffect(() => {
    if (!isOwner || !orgSk) {
      setShowSetup(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const seen = await getWalkthroughIntroSeen(orgSk);
        if (cancelled || seen) {
          if (!cancelled) setShowSetup(false);
          return;
        }
        // Not seen yet — but if a walkthrough form is already published, they're
        // effectively set up: mark seen and stay quiet.
        let tpl = await getCachedTemplate(orgSk);
        if (!tpl?.schema && isOnline()) {
          tpl = await fetchAndCacheTemplate(orgSk);
        }
        if (cancelled) return;
        const published = !!tpl?.schema;
        setHasForm(published);
        if (published) {
          markWalkthroughIntroSeen(orgSk).catch(() => {});
          setShowSetup(false);
        } else {
          setShowSetup(true);
        }
      } catch (e) {
        logError(e, "useOwnerSetup.evaluate");
        if (!cancelled) setShowSetup(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwner, orgSk]);

  const markDone = useCallback(async () => {
    setShowSetup(false); // hide immediately; the flag write is best-effort
    if (!orgSk) return;
    try {
      await markWalkthroughIntroSeen(orgSk);
    } catch (e) {
      logError(e, "useOwnerSetup.markDone");
    }
  }, [orgSk]);

  return { showSetup, hasForm, markDone };
}
