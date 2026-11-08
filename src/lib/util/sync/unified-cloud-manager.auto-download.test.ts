import { beforeEach, describe, expect, it, vi } from 'vitest';

const onCloudListingSettled = vi.fn(async () => {});
const fetchAll = vi.fn(async () => {});
const refreshFromChanges = vi.fn(async () => 'unchanged');
const getActiveProvider = vi.fn(() => ({ type: 'webdav' }));

vi.mock('./auto-download', () => ({ onCloudListingSettled: () => onCloudListingSettled() }));
vi.mock('$lib/util/sync/cache-manager', () => ({
  cacheManager: {
    fetchAll: () => fetchAll(),
    allFiles: { subscribe: vi.fn() },
    isFetchingState: { subscribe: vi.fn() },
    getCache: vi.fn(() => ({ refreshFromChanges, isLoaded: () => true })),
    getAllFiles: vi.fn(() => [])
  }
}));
vi.mock('$lib/util/sync/provider-manager', () => ({
  providerManager: { getActiveProvider: () => getActiveProvider() }
}));
vi.mock('$lib/util/sync/unified-sync-service', () => ({
  unifiedSyncService: { isSyncing: { subscribe: vi.fn() }, syncProvider: vi.fn() }
}));

import { unifiedCloudManager } from './unified-cloud-manager';

describe('fetchAllCloudVolumes runs the auto-download check (fork)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveProvider.mockReturnValue({ type: 'webdav' });
  });

  it('after a full listing', async () => {
    await unifiedCloudManager.fetchAllCloudVolumes({ refreshIndexes: false });
    await vi.waitFor(() => expect(onCloudListingSettled).toHaveBeenCalledTimes(1));
    expect(fetchAll).toHaveBeenCalledTimes(1);
  });

  it('after a change-feed refresh', async () => {
    getActiveProvider.mockReturnValue({ type: 'google-drive' });
    await unifiedCloudManager.fetchAllCloudVolumes({ refreshIndexes: false, fromChangeFeed: true });
    await vi.waitFor(() => expect(onCloudListingSettled).toHaveBeenCalledTimes(1));
    expect(refreshFromChanges).toHaveBeenCalledTimes(1);
    expect(fetchAll).not.toHaveBeenCalled();
  });
});
