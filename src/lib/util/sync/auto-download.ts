import { browser } from '$app/environment';
import { get, writable, type Readable } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import { normalizeVolumeTitleKey } from '$lib/metadata/series-key';
import { needsDownload } from '$lib/catalog/volume-state';

/**
 * Auto-download of NEW cloud volumes, opt-in and per device.
 *
 * "New" means a cloud archive this device has never seen in a listing since
 * the setting was turned on. The seen set holds every archive of every listing
 * (not only the placeholders), so a volume that was installed here and then
 * deleted completely — which turns it back into a placeholder — is never
 * re-downloaded behind the user's back.
 *
 * A candidate is anything that needs a download and has a cloud path: a
 * placeholder, or a metadata-only row decorated with its cloud file. The
 * catalog grid materializes a metadata-only row for every visible placeholder
 * without a cover sidecar (`cover-service.ts` -> `materializeSeriesVolumes`),
 * and a freshly published volume never has one, so a new volume is often
 * already a metadata-only row when this runs. A volume the user removed from
 * the device is also a metadata-only row, but it was installed and therefore
 * listed before, so the seen set keeps it out.
 *
 * Identity is the folded cloud path `<series>/<volume>` (same per-segment fold
 * the catalog uses to match a local row against a `.cbz`): it is the only key
 * every provider reports the same way and that survives re-listing. File ids
 * are provider-specific, and a placeholder's `volume_uuid` flips from the
 * path-derived uuid to the indexed one once `series.json` is cached.
 *
 * Everything lives in localStorage — device state, never synced.
 */

const ENABLED_KEY = 'autoDownloadNewCloudVolumes';
const SEEN_KEY = 'autoDownloadSeenCloudVolumes';
const BASELINE_PENDING_KEY = 'autoDownloadBaselinePending';

type Listing = Map<string, { path: string }[]>;

function readFlag(key: string): boolean {
  if (!browser) return false;
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  if (!browser) return;
  try {
    if (value) localStorage.setItem(key, 'true');
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable: the setting just won't persist.
  }
}

function readSeen(): Set<string> {
  if (!browser) return new Set();
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeSeen(seen: Set<string>): void {
  if (!browser) return;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch (error) {
    console.warn('[AutoDownload] Could not persist the seen set:', error);
  }
}

const enabledStore = writable<boolean>(readFlag(ENABLED_KEY));

/** Whether this device auto-downloads new cloud volumes. Default off. */
export const autoDownloadNewVolumes: Readable<boolean> = { subscribe: enabledStore.subscribe };

/**
 * The identity of a listed cloud archive, or `''` for anything that is not a
 * `<Series>/<Volume>.cbz` (sidecars, root files).
 */
export function cloudVolumeKey(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  const parts = trimmed.split('/');
  if (parts.length !== 2 || !/\.cbz$/i.test(parts[1])) return '';
  const volume = parts[1].replace(/\.cbz$/i, '');
  return `${normalizeVolumeTitleKey(parts[0])}/${normalizeVolumeTitleKey(volume)}`;
}

/** Every archive key of a listing. */
export function listingKeys(listing: Listing): string[] {
  const keys: string[] = [];
  for (const files of listing.values()) {
    for (const file of files) {
      const key = cloudVolumeKey(file.path);
      if (key) keys.push(key);
    }
  }
  return keys;
}

/**
 * The candidates not yet seen. Pure: only volumes that need a download
 * (placeholder or metadata-only row) and carry a cloud path qualify, each key
 * at most once.
 */
export function diffNewCloudVolumes(
  candidates: VolumeMetadata[],
  seen: ReadonlySet<string>
): VolumeMetadata[] {
  const picked = new Set<string>();
  const fresh: VolumeMetadata[] = [];
  for (const volume of candidates) {
    if (!needsDownload(volume) || !volume.cloudPath) continue;
    const key = cloudVolumeKey(volume.cloudPath);
    if (!key || seen.has(key) || picked.has(key)) continue;
    picked.add(key);
    fresh.push(volume);
  }
  return fresh;
}

/**
 * Turn the setting on or off. Turning it on marks everything in `listing` as
 * seen and downloads nothing. A loaded listing is the baseline even when empty
 * (a connected, empty cloud folder). Without one (`undefined`: provider not
 * connected or still loading), the first non-empty listing becomes the baseline.
 */
export function setAutoDownloadNewVolumes(enabled: boolean, listing?: Listing): void {
  writeFlag(ENABLED_KEY, enabled);
  enabledStore.set(enabled);
  if (!enabled) {
    writeFlag(BASELINE_PENDING_KEY, false);
    return;
  }

  if (!listing) {
    writeFlag(BASELINE_PENDING_KEY, true);
    return;
  }
  const keys = listingKeys(listing);
  const seen = readSeen();
  for (const key of keys) seen.add(key);
  writeSeen(seen);
  writeFlag(BASELINE_PENDING_KEY, false);
}

/**
 * Decide what to queue for one settled listing and record it all as seen.
 * Returns nothing while disabled, for an empty listing, or when this listing
 * is the pending baseline.
 */
export function selectAutoDownloads(
  candidates: VolumeMetadata[],
  listing: Listing
): VolumeMetadata[] {
  if (!readFlag(ENABLED_KEY)) return [];
  const keys = listingKeys(listing);
  if (keys.length === 0) return [];

  const seen = readSeen();
  const baseline = readFlag(BASELINE_PENDING_KEY);
  const fresh = baseline ? [] : diffNewCloudVolumes(candidates, seen);

  const before = seen.size;
  for (const key of keys) seen.add(key);
  if (seen.size !== before) writeSeen(seen);
  if (baseline) writeFlag(BASELINE_PENDING_KEY, false);

  return fresh;
}

let chain: Promise<void> = Promise.resolve();

/**
 * Called after every cloud listing resolves. Cheap no-op while disabled; the
 * heavy modules are only loaded when the setting is on. Runs are serialized so
 * two listings settling together cannot both queue the same volume.
 */
export function onCloudListingSettled(): Promise<void> {
  if (!browser || !get(enabledStore)) return Promise.resolve();
  chain = chain.then(runAfterListing).catch((error) => {
    console.warn('[AutoDownload] Run failed:', error);
  });
  return chain;
}

async function runAfterListing(): Promise<void> {
  if (!get(enabledStore)) return;

  const [
    { unifiedCloudManager },
    { db },
    {
      generatePlaceholders,
      indexCloudFilesByPath,
      indexCloudFilesByUuid,
      cloudFieldsForRemovedVolume
    },
    { listSeriesIndexes },
    { isMetadataOnly }
  ] = await Promise.all([
    import('./unified-cloud-manager'),
    import('$lib/catalog/db'),
    import('$lib/catalog/placeholders'),
    import('$lib/metadata/series-index'),
    import('$lib/catalog/volume-state')
  ]);

  const listing = get(unifiedCloudManager.cloudFiles);
  if (listing.size === 0) return;

  const [localVolumes, indexes] = await Promise.all([db.volumes.toArray(), listSeriesIndexes()]);
  const indexMap = new Map(indexes.map((record) => [record.series_key, record]));
  const placeholders = generatePlaceholders(listing, localVolumes, indexMap);

  // Same decoration the catalog gives a metadata-only row, so the download
  // queue has a cloud file to fetch it from.
  const byPath = indexCloudFilesByPath(listing);
  const byUuid = indexCloudFilesByUuid(listing, indexMap);
  const metadataOnly: VolumeMetadata[] = [];
  for (const volume of localVolumes) {
    if (!isMetadataOnly(volume)) continue;
    const cloudFields = cloudFieldsForRemovedVolume(byPath, volume, undefined, byUuid);
    if (cloudFields) metadataOnly.push({ ...volume, ...cloudFields });
  }

  const toQueue = selectAutoDownloads([...placeholders, ...metadataOnly], listing);
  if (toQueue.length === 0) return;

  console.log(`[AutoDownload] Queueing ${toQueue.length} new cloud volume(s)`);
  const { queueSeriesVolumes } = await import('$lib/util/download-queue');
  queueSeriesVolumes(toQueue);
}
