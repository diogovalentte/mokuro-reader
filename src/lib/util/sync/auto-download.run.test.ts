import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';

type Listed = {
  provider: string;
  fileId: string;
  path: string;
  modifiedTime: string;
  size: number;
};

const cloudFiles = writable(new Map<string, Listed[]>());
const localRows: VolumeMetadata[] = [];
const queueSeriesVolumes = vi.fn();

vi.mock('./unified-cloud-manager', () => ({ unifiedCloudManager: { cloudFiles } }));
vi.mock('$lib/catalog/db', () => ({ db: { volumes: { toArray: async () => localRows } } }));
vi.mock('$lib/metadata/series-index', () => ({ listSeriesIndexes: async () => [] }));
vi.mock('$lib/util/download-queue', () => ({
  queueSeriesVolumes: (v: VolumeMetadata[]) => queueSeriesVolumes(v)
}));
vi.mock('$lib/catalog/cloud-ocr-upgrade', () => ({ enqueueCloudOcrUpgrade: vi.fn() }));

import { onCloudListingSettled, setAutoDownloadNewVolumes } from './auto-download';

function file(path: string): Listed {
  return { provider: 'webdav', fileId: `id-${path}`, path, modifiedTime: '', size: 1000 };
}

function listing(...paths: string[]): Map<string, Listed[]> {
  const map = new Map<string, Listed[]>();
  for (const path of paths) {
    const series = path.split('/')[0];
    map.set(series, [...(map.get(series) ?? []), file(path)]);
  }
  return map;
}

function metadataOnlyRow(series: string, volume: string): VolumeMetadata {
  return {
    mokuro_version: '0.2.1',
    series_title: series,
    series_uuid: `s-${series}`,
    volume_title: volume,
    volume_uuid: `v-${series}-${volume}`,
    page_count: 20,
    character_count: 0,
    page_char_counts: [],
    metadata_only: true
  };
}

const queuedPaths = () =>
  queueSeriesVolumes.mock.calls.flatMap(([v]) => (v as VolumeMetadata[]).map((x) => x.cloudPath));

describe('onCloudListingSettled (fork): what a real listing queues', () => {
  beforeEach(() => {
    localStorage.clear();
    localRows.length = 0;
    queueSeriesVolumes.mockClear();
    setAutoDownloadNewVolumes(true, listing('Old/Ch 1.cbz'));
  });

  it('queues a new volume the listing still shows as a placeholder', async () => {
    cloudFiles.set(listing('Old/Ch 1.cbz', 'New/Ch 1.cbz', 'New/Ch 1.mokuro'));
    localRows.push(metadataOnlyRow('Old', 'Ch 1'));
    await onCloudListingSettled();
    expect(queuedPaths()).toEqual(['New/Ch 1.cbz']);
  });

  it('queues a new volume the catalog grid already materialized into a metadata-only row', async () => {
    // A new series without cover sidecars: the grid mints metadata-only rows
    // for it before this check reads the volumes table (cover-service.ts).
    cloudFiles.set(listing('Old/Ch 1.cbz', 'New/Ch 1.cbz', 'New/Ch 2.cbz'));
    localRows.push(metadataOnlyRow('New', 'Ch 1'), metadataOnlyRow('New', 'Ch 2'));
    await onCloudListingSettled();
    expect(queuedPaths().sort()).toEqual(['New/Ch 1.cbz', 'New/Ch 2.cbz']);
    const queued = queueSeriesVolumes.mock.calls[0][0] as VolumeMetadata[];
    expect(queued.every((v) => v.cloudFileId && v.cloudProvider === 'webdav')).toBe(true);
  });

  it('does not queue a removed volume that was listed before', async () => {
    cloudFiles.set(listing('Old/Ch 1.cbz'));
    localRows.push(metadataOnlyRow('Old', 'Ch 1'));
    await onCloudListingSettled();
    expect(queueSeriesVolumes).not.toHaveBeenCalled();
  });

  it('queues each new volume once across listings', async () => {
    cloudFiles.set(listing('Old/Ch 1.cbz', 'New/Ch 1.cbz'));
    localRows.push(metadataOnlyRow('New', 'Ch 1'));
    await onCloudListingSettled();
    await onCloudListingSettled();
    expect(queuedPaths()).toEqual(['New/Ch 1.cbz']);
  });
});
