import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as MediaLibrary from "expo-media-library";
import { Image } from "react-native";
import { logError } from "../db/logs";
import { supabase } from "./supabase";

// Photo storage model (Apple data-storage guidelines):
//   - Capture/pick → downscale to MAX_DIMENSION + JPEG → app CACHE directory.
//     The cloud bucket is the durable copy; the cache copy is disposable.
//   - LocalPictureURI holds the cache file path. Legacy rows may still hold a
//     MediaLibrary asset id (old flow saved to the user's Photos library) —
//     resolveLocalFileUri handles both.
//   - Retrieval is cache-first; on a miss we re-download from the bucket into
//     the cache and re-record the path, so OS cache purges self-heal.
function isFilePath(uri) {
  return (
    typeof uri === "string" &&
    (uri.startsWith("file://") || uri.startsWith("content://"))
  );
}

export const BUCKET = "inspection-images";

// Name of the device photo-library album used when the user opts into
// organizing saved inspection photos (Settings → Photos → "Organize in a Zuba
// album"). Plain camera-roll saves don't touch this.
const DEVICE_ALBUM = "Zuba";

const PHOTOS_CACHE_DIR = `${FileSystem.cacheDirectory}photos/`;
const MAX_DIMENSION = 1920;
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

async function ensurePhotosCacheDir() {
  try {
    const info = await FileSystem.getInfoAsync(PHOTOS_CACHE_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(PHOTOS_CACHE_DIR, {
        intermediates: true,
      });
    }
  } catch (e) {
    logError(e, "inspectionPhotos.ensurePhotosCacheDir");
  }
}

function cachePathForDetail(detailSk) {
  return `${PHOTOS_CACHE_DIR}${detailSk}.jpg`;
}

function getImageSize(uri) {
  return new Promise((resolve) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => resolve(null),
    );
  });
}

// Downscale (longest side ≤ MAX_DIMENSION, never upscaled) + JPEG-compress a
// just-captured/picked photo and park it in the app cache under the detail's
// sk. This single pass is what both the cache AND the cloud store — roughly
// an 80% size cut vs. raw 12MP camera output, paid once.
// Returns the cache file path, or null on failure.
export async function processAndCachePhoto(sourceUri, detailSk) {
  try {
    if (!sourceUri || !detailSk) return null;

    const size = await getImageSize(sourceUri);
    const longest = size ? Math.max(size.width, size.height) : null;
    const actions = [];
    if (longest && longest > MAX_DIMENSION) {
      actions.push(
        size.width >= size.height
          ? { resize: { width: MAX_DIMENSION } }
          : { resize: { height: MAX_DIMENSION } },
      );
    }

    // Even with no resize, this pass normalizes HEIC/PNG to JPEG so the
    // upload, report generator, and cache all speak one format.
    const result = await ImageManipulator.manipulateAsync(sourceUri, actions, {
      compress: COMPRESSION_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    if (!result?.uri) return null;

    await ensurePhotosCacheDir();
    const dest = cachePathForDetail(detailSk);
    await FileSystem.moveAsync({ from: result.uri, to: dest });
    return dest;
  } catch (e) {
    logError(e, `inspectionPhotos.processAndCachePhoto sk=${detailSk}`);
    return null;
  }
}

// Translate a LocalPictureURI (asset id OR file:// path) into a URI that
// FileSystem / ImageManipulator / <Image> can read. Returns null if the
// underlying asset/file no longer exists.
export async function resolveLocalFileUri(localUri) {
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
    // Same sizing rule as processAndCachePhoto: shrink the LONGEST side to
    // MAX_DIMENSION, never upscale, respect portrait orientation.
    const size = await getImageSize(localUri);
    const longest = size ? Math.max(size.width, size.height) : null;
    const actions = [];
    if (longest && longest > MAX_DIMENSION) {
      actions.push(
        size.width >= size.height
          ? { resize: { width: MAX_DIMENSION } }
          : { resize: { height: MAX_DIMENSION } },
      );
    }
    const result = await ImageManipulator.manipulateAsync(localUri, actions, {
      compress: COMPRESSION_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    });
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

    // Files in our photo cache were already downscaled + JPEG'd by
    // processAndCachePhoto — re-compressing would degrade them for nothing.
    // Anything else (legacy MediaLibrary assets, stray files) gets the full
    // treatment before upload.
    const alreadyProcessed = fileUri.startsWith(PHOTOS_CACHE_DIR);
    const uploadUri = alreadyProcessed ? fileUri : await compressToJpeg(fileUri);
    if (!uploadUri) return null;

    let bytes;
    try {
      const base64 = await FileSystem.readAsStringAsync(uploadUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      bytes = base64ToUint8Array(base64);
    } catch (e) {
      logError(e, `uploadInspectionPhoto read uri=${uploadUri}`);
      return null;
    }

    const path = `${orgSk}/${userId}/${detailSk}/${Date.now()}.jpg`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType: "image/jpeg",
      upsert: true,
    });

    // Best-effort cleanup of the temp compressed file (never the cache copy —
    // that's the display source).
    if (!alreadyProcessed) {
      FileSystem.deleteAsync(uploadUri, { idempotent: true }).catch(() => {});
    }

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

// Pick the best URI for displaying a photo: cache first; on a miss pull the
// cloud copy back INTO the cache so the next open is instant and free. Falls
// back to a signed URL if the re-cache fails; null when nothing is available.
// `detailSk` is the photo id; the cache path is derived from it, so re-caching
// lands on the same deterministic path the photo ref already points at.
export async function resolvePhotoUri({ localUri, cloudUri, detailSk }) {
  try {
    if (localUri) {
      const fileUri = await resolveLocalFileUri(localUri);
      if (fileUri) return fileUri;
    }
    if (cloudUri) {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(cloudUri, SIGNED_URL_TTL_SECONDS);
      if (error) {
        logError(error, `resolvePhotoUri cloud=${cloudUri}`);
        return null;
      }
      const signedUrl = data?.signedUrl ?? null;
      if (!signedUrl) return null;

      if (detailSk) {
        try {
          await ensurePhotosCacheDir();
          const dest = cachePathForDetail(detailSk);
          const dl = await FileSystem.downloadAsync(signedUrl, dest);
          if (dl?.status === 200) {
            // Re-cached to the photo's deterministic path so the next open is
            // instant. The path lives on the photo ref in the answers JSON, not
            // a DB row, so there's nothing to write back here.
            return dest;
          }
        } catch (e) {
          logError(e, `resolvePhotoUri recache id=${detailSk}`);
        }
      }
      return signedUrl;
    }
    return null;
  } catch (e) {
    logError(e, `resolvePhotoUri local=${localUri} cloud=${cloudUri}`);
    return null;
  }
}

// Best-effort delete of a photo's cache copy. Called alongside
// deleteInspectionPhoto when a detail row is deleted.
export async function deleteCachedPhoto(detailSk) {
  try {
    if (!detailSk) return;
    await FileSystem.deleteAsync(cachePathForDetail(detailSk), {
      idempotent: true,
    });
  } catch (_e) {
    // cache file may simply not exist — nothing to surface
  }
}

// Request the media-library permission needed to save a photo to the device.
//   - `full: false` (default) → write-only ("Add Photos Only" on iOS), enough
//     for a plain camera-roll save via saveToLibraryAsync.
//   - `full: true` → full read-write, required to read/append an album.
// Returns true when the granted access is sufficient for the requested mode.
export async function ensureMediaWritePermission({ full = false } = {}) {
  try {
    // requestPermissionsAsync(writeOnly): pass true to ask for the lighter
    // add-only permission, false to ask for full access.
    const res = await MediaLibrary.requestPermissionsAsync(!full);
    if (!res?.granted) return false;
    // Album operations need read access too; "limited" iOS access can't
    // enumerate/append our album reliably, so require full privileges there.
    if (full && res.accessPrivileges && res.accessPrivileges !== "all") {
      return false;
    }
    return true;
  } catch (e) {
    logError(e, `inspectionPhotos.ensureMediaWritePermission full=${full}`);
    return false;
  }
}

// Best-effort save of one already-cached photo to the device's photo library.
// Never throws — a failed device-save must not block the cache/cloud pipeline.
//   - album=false → save to the camera roll (saveToLibraryAsync; write-only ok).
//   - album=true  → file the photo into the "Zuba" album (needs full access).
// Caller is responsible for having obtained the matching permission first.
export async function savePhotoToDevice(fileUri, { album = false } = {}) {
  try {
    if (!fileUri) return;
    if (!album) {
      await MediaLibrary.saveToLibraryAsync(fileUri);
      return;
    }
    // Album path: create the asset, then drop it into the Zuba album. copyAsset
    // = false moves the reference into the album instead of leaving a duplicate
    // loose in the camera roll.
    const asset = await MediaLibrary.createAssetAsync(fileUri);
    const existing = await MediaLibrary.getAlbumAsync(DEVICE_ALBUM);
    if (existing) {
      await MediaLibrary.addAssetsToAlbumAsync([asset], existing, false);
    } else {
      await MediaLibrary.createAlbumAsync(DEVICE_ALBUM, asset, false);
    }
  } catch (e) {
    logError(e, `inspectionPhotos.savePhotoToDevice album=${album}`);
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
