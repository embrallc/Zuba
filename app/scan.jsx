import { useRouter } from "expo-router";
import ScannerHost from "../components/scan/ScannerHost";
import { logError } from "../db/logs";
import { newId } from "../db/walkthroughForms";
import { useToolScanStore } from "../stores/usePhotoWorkflow";
import { processAndCachePhoto } from "../utils/inspectionPhotos";

// Thin scan host. The walkthrough toolbelt drops a target in the store and opens
// this route; ScannerHost (platform-resolved to the DataScanner or ML Kit engine)
// returns the confirmed item(s) plus an optional tag-photo uri. We downscale +
// cache the photo through the normal pipeline and hand everything back via the
// store for the form to append to the section instance. No platform branching here.
export default function ScanScreen() {
  const router = useRouter();

  async function handleComplete(scans, photoUri) {
    let photo = null;
    if (photoUri) {
      try {
        const id = newId("p");
        const cachePath = await processAndCachePhoto(photoUri, id);
        if (cachePath) photo = { id, localUri: cachePath, cloudUri: null };
      } catch (e) {
        logError(e, "ScanScreen.processPhoto");
      }
    }
    if (scans?.length) {
      useToolScanStore.getState().setResult({ scans, photo });
    }
    router.back();
  }

  return (
    <ScannerHost onComplete={handleComplete} onCancel={() => router.back()} />
  );
}
