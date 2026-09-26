import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { VolumeMetadata } from '$lib/types';
import {
  autoDownloadNewVolumes,
  cloudVolumeKey,
  diffNewPlaceholders,
  selectAutoDownloads,
  setAutoDownloadNewVolumes
} from './auto-download';

function placeholder(path: string, overrides: Partial<VolumeMetadata> = {}): VolumeMetadata {
  const [series, file] = path.split('/');
  return {
    mokuro_version: 'unknown',
    series_title: series,
    series_uuid: `s-${series}`,
    volume_title: file.replace(/\.cbz$/i, ''),
    volume_uuid: `v-${path}`,
    page_count: 0,
    character_count: 0,
    page_char_counts: [],
    isPlaceholder: true,
    cloudProvider: 'webdav',
    cloudFileId: `id-${path}`,
    cloudPath: path,
    ...overrides
  };
}

function listing(...paths: string[]): Map<string, { path: string }[]> {
  const map = new Map<string, { path: string }[]>();
  for (const path of paths) {
    const series = path.split('/')[0];
    map.set(series, [...(map.get(series) ?? []), { path }]);
  }
  return map;
}

describe('cloudVolumeKey', () => {
  it('folds case, unicode form and surrounding slashes', () => {
    expect(cloudVolumeKey('/Dr Stone/Ch 01.CBZ')).toBe(cloudVolumeKey('dr stone/ch 01.cbz'));
    expect(cloudVolumeKey('Café/Vol 1.cbz')).toBe(cloudVolumeKey('Café/Vol 1.cbz'));
  });

  it('ignores sidecars and root files', () => {
    expect(cloudVolumeKey('Series/Vol 1.mokuro')).toBe('');
    expect(cloudVolumeKey('Series/series.json')).toBe('');
    expect(cloudVolumeKey('volume-data.json')).toBe('');
  });
});

describe('diffNewPlaceholders', () => {
  it('returns only placeholders whose key is not seen', () => {
    const seen = new Set([cloudVolumeKey('A/Ch 1.cbz')]);
    const result = diffNewPlaceholders(
      [placeholder('A/Ch 1.cbz'), placeholder('A/Ch 2.cbz'), placeholder('B/Ch 1.cbz')],
      seen
    );
    expect(result.map((v) => v.cloudPath)).toEqual(['A/Ch 2.cbz', 'B/Ch 1.cbz']);
  });

  it('matches seen keys regardless of casing', () => {
    const seen = new Set([cloudVolumeKey('a/ch 1.cbz')]);
    expect(diffNewPlaceholders([placeholder('A/Ch 1.cbz')], seen)).toEqual([]);
  });

  it('skips non-placeholder rows, rows without a cloud path, and duplicates', () => {
    const result = diffNewPlaceholders(
      [
        placeholder('A/Ch 1.cbz', { isPlaceholder: undefined, metadata_only: true }),
        placeholder('A/Ch 2.cbz', { cloudPath: undefined }),
        placeholder('A/Ch 3.cbz'),
        placeholder('a/ch 3.cbz', { volume_uuid: 'other' })
      ],
      new Set()
    );
    expect(result.map((v) => v.cloudPath)).toEqual(['A/Ch 3.cbz']);
  });
});

describe('auto-download state', () => {
  beforeEach(() => {
    localStorage.clear();
    setAutoDownloadNewVolumes(false);
  });

  it('is off by default and queues nothing while off', () => {
    localStorage.clear();
    expect(get(autoDownloadNewVolumes)).toBe(false);
    expect(selectAutoDownloads([placeholder('A/Ch 1.cbz')], listing('A/Ch 1.cbz'))).toEqual([]);
  });

  it('enabling marks every listed volume as seen and queues none of them', () => {
    const current = listing('A/Ch 1.cbz', 'A/Ch 2.cbz', 'A/Ch 2.mokuro', 'B/Ch 1.cbz');
    setAutoDownloadNewVolumes(true, current);

    expect(get(autoDownloadNewVolumes)).toBe(true);
    const existing = [
      placeholder('A/Ch 1.cbz'),
      placeholder('A/Ch 2.cbz'),
      placeholder('B/Ch 1.cbz')
    ];
    expect(selectAutoDownloads(existing, current)).toEqual([]);
  });

  it('queues a volume that arrives after enabling, exactly once', () => {
    setAutoDownloadNewVolumes(true, listing('A/Ch 1.cbz'));

    const next = listing('A/Ch 1.cbz', 'A/Ch 2.cbz');
    const placeholders = [placeholder('A/Ch 1.cbz'), placeholder('A/Ch 2.cbz')];
    expect(selectAutoDownloads(placeholders, next).map((v) => v.cloudPath)).toEqual(['A/Ch 2.cbz']);
    expect(selectAutoDownloads(placeholders, next)).toEqual([]);
  });

  it('never re-queues a listed volume that was installed and later deleted', () => {
    setAutoDownloadNewVolumes(true, listing('A/Ch 1.cbz'));
    // Ch 2 arrives already installed here (no placeholder), so it is only seen.
    expect(selectAutoDownloads([], listing('A/Ch 1.cbz', 'A/Ch 2.cbz'))).toEqual([]);
    // Deleted completely later: it comes back as a placeholder, but it was seen.
    expect(
      selectAutoDownloads([placeholder('A/Ch 2.cbz')], listing('A/Ch 1.cbz', 'A/Ch 2.cbz'))
    ).toEqual([]);
  });

  it('enabled on a connected but empty cloud folder: the first volume is downloaded', () => {
    setAutoDownloadNewVolumes(true, new Map());

    expect(
      selectAutoDownloads([placeholder('A/Ch 1.cbz')], listing('A/Ch 1.cbz')).map(
        (v) => v.cloudPath
      )
    ).toEqual(['A/Ch 1.cbz']);
  });

  it('enabled with no listing yet: the first non-empty listing is the baseline', () => {
    setAutoDownloadNewVolumes(true);
    expect(selectAutoDownloads([], new Map())).toEqual([]);

    const first = listing('A/Ch 1.cbz');
    expect(selectAutoDownloads([placeholder('A/Ch 1.cbz')], first)).toEqual([]);

    const second = listing('A/Ch 1.cbz', 'A/Ch 2.cbz');
    expect(
      selectAutoDownloads([placeholder('A/Ch 1.cbz'), placeholder('A/Ch 2.cbz')], second).map(
        (v) => v.cloudPath
      )
    ).toEqual(['A/Ch 2.cbz']);
  });

  it('persists the setting and the seen set in localStorage', () => {
    setAutoDownloadNewVolumes(true, listing('A/Ch 1.cbz'));
    expect(localStorage.getItem('autoDownloadNewCloudVolumes')).toBe('true');
    expect(JSON.parse(localStorage.getItem('autoDownloadSeenCloudVolumes') ?? '[]')).toEqual([
      cloudVolumeKey('A/Ch 1.cbz')
    ]);

    setAutoDownloadNewVolumes(false);
    expect(localStorage.getItem('autoDownloadNewCloudVolumes')).toBeNull();
  });
});
