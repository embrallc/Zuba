import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as MediaLibrary from "expo-media-library";
import { logError } from "../db/logs";
import { supabase } from "./supabase";

// LocalPictureURI may hold either a MediaLibrary asset id (preferred — no
// app-sandbox storage) or a legacy file:// path from the old PHOTOS_DIR flow.
function isFilePath(uri) {
  return (
    typeof uri === "string" &&
    (uri.startsWith("file://") || uri.startsWith("content://"))
  );
}

export const BUCKET = "inspection-images";

const MAX_DIMENSION = 1600;
const COMPRESSION_QUALITY = 0.8;
const SIGNED_URL_TTL_SECONDS = 60 * 60;

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Save a temp file (from ImagePicker or the in-app camera) into the device's
// Photos library so the user owns it like any other photo. Returns the
// MediaLibrary asset id on success, null on failure or denied permission.
export async function saveToPhotoLibrary(sourceUri) {
  try {
    if (!sourceUri) return null;
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (perm?.status !== "granted") {
      console.warn(
        `[saveToPhotoLibrary] permission ${perm?.status ?? "unknown"} — not saving`,
      );
      return null;
    }
    const asset = await MediaLibrary.createAssetAsync(sourceUri);
    if (!asset?.id) return null;
    console.log(`[saveToPhotoLibrary] saved assetId=${asset.id}`);
    return asset.id;
  } catch (e) {
    logError(e, `saveToPhotoLibrary uri=${sourceUri}`);
    return null;
  }
}

// Translate a LocalPictureURI (asset id OR file:// path) into a URI that
// FileSystem / ImageManipulator / <Image> can read. Returns null if the
// underlying asset/file no longer exists.
async function resolveLocalFileUri(localUri) {
  if (!localUri) return null;
  if (isFilePath(localUri)) {
    const info = await FileSystem.getInfoAsync(localUri).catch((e) => {
      logError(e, `resolveLocalFileUri.getInfoAsync uri=${localUri}`);
      return null;
    });
    return info?.exists ? localUri : null;
  }
  // Treat as MediaLibrary asset id. A missing/deleted asset is the common
  // case here so we don't log every miss, but anything other than the
  // expected "not found" should surface.
  try {
    const info = await MediaLibrary.getAssetInfoAsync(localUri);
    return info?.localUri ?? info?.uri ?? null;
  } catch (e) {
    // Asset deletions throw; logging at debug level only would be ideal but
    // logError keeps the audit trail uniform.
    logError(e, `resolveLocalFileUri.getAssetInfoAsync id=${localUri}`);
    return null;
  }
}

async function compressToJpeg(localUri) {
  try {
    if (!localUri) return null;
    const result = await ImageManipulator.manipulateAsync(
      localUri,
      [{ resize: { width: MAX_DIMENSION } }],
      {
        compress: COMPRESSION_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
      },
    );
    return result?.uri ?? null;
  } catch (e) {
    logError(e, `utils/inspectionPhotos.compressToJpeg uri=${localUri}`);
    return null;
  }
}

// Compress + upload one local photo. Returns the storage key on success,
// null on any failure. Never throws — caller can continue gracefully.
export async function uploadInspectionPhoto({
  localUri,
  orgSk,
  userId,
  detailSk,
}) {
  try {
    if (!localUri || !orgSk || !userId || !detailSk) {
      logError(
        new Error("uploadInspectionPhoto missing arg"),
        `localUri=${!!localUri} orgSk=${!!orgSk} userId=${!!userId} detailSk=${!!detailSk}`,
      );
      return null;
    }

    const fileUri = await resolveLocalFileUri(localUri);
    if (!fileUri) {
      logError(
        new Error("local photo missing"),
        `uploadInspectionPhoto uri=${localUri}`,
      );
      return null;
    }

    const compressedUri = await compressToJpeg(fileUri);
    if (!compressedUri) return null;

    let bytes;
    try {
      const base64 = await FileSystem.readAsStringAsync(compressedUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      bytes = base64ToUint8Array(base64);
    } catch (e) {
      logError(e, `uploadInspectionPhoto read compressed uri=${compressedUri}`);
      return null;
    }

    const path = `${orgSk}/${userId}/${detailSk}/${Date.now()}.jpg`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType: "image/jpeg",
      upsert: true,
    });

    // Best-effort cleanup of the temp compressed file
    FileSystem.deleteAsync(compressedUri, { idempotent: true }).catch(() => {});

    if (error) {
      console.warn(
        `[uploadInspectionPhoto] storage rejected path=${path} msg=${error.message} status=${error.statusCode ?? "?"}`,
      );
      logError(error, `uploadInspectionPhoto path=${path}`);
      return null;
    }
    console.log(`[uploadInspectionPhoto] uploaded ${path} (${bytes.byteLength} bytes)`);
    return path;
  } catch (e) {
    logError(e, `uploadInspectionPhoto detailSk=${detailSk}`);
    return null;
  }
}

// Pick the best URI for displaying a photo. Returns null if neither
// the local file nor a signed cloud URL is available.
export async function resolvePhotoUri({ localUri, cloudUri }) {
  try {
    if (localUri) {
      const fileUri = await resolveLocalFileUri(localUri);
      if (fileUri) {
        console.log(`[resolvePhotoUri] LOCAL ${fileUri}`);
        return fileUri;
      }
    }
    if (cloudUri) {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(cloudUri, SIGNED_URL_TTL_SECONDS);
      if (error) {
        console.warn(`[resolvePhotoUri] CLOUD-ERROR cloud=${cloudUri} msg=${error.message}`);
        logError(error, `resolvePhotoUri cloud=${cloudUri}`);
        return null;
      }
      console.log(`[resolvePhotoUri] CLOUD ${cloudUri}`);
      return data?.signedUrl ?? null;
    }
    console.warn(`[resolvePhotoUri] NONE — no local or cloud URI`);
    return null;
  } catch (e) {
    logError(e, `resolvePhotoUri local=${localUri} cloud=${cloudUri}`);
    return null;
  }
}

// Best-effort delete of a cloud photo. Called when the user deletes a detail row.
export async function deleteInspectionPhoto(cloudUri) {
  try {
    if (!cloudUri) return;
    const { error } = await supabase.storage.from(BUCKET).remove([cloudUri]);
    if (error) logError(error, `deleteInspectionPhoto cloud=${cloudUri}`);
  } catch (e) {
    logError(e, `deleteInspectionPhoto cloud=${cloudUri}`);
  }
}
