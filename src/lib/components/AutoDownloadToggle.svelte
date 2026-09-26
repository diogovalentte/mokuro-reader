<script lang="ts">
  import { Toggle } from 'flowbite-svelte';
  import { get } from 'svelte/store';
  import { unifiedCloudManager } from '$lib/util/sync/unified-cloud-manager';
  import { autoDownloadNewVolumes, setAutoDownloadNewVolumes } from '$lib/util/sync/auto-download';

  function onToggle(event: Event) {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    const listingLoaded =
      unifiedCloudManager.getActiveProvider() !== null && !get(unifiedCloudManager.isFetching);
    setAutoDownloadNewVolumes(
      enabled,
      listingLoaded ? get(unifiedCloudManager.cloudFiles) : undefined
    );
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center gap-3">
    <Toggle checked={$autoDownloadNewVolumes} onchange={onToggle}>
      Auto-download new cloud volumes
    </Toggle>
  </div>
  <p class="text-xs text-gray-500">
    On this device only. Volumes that appear in the cloud after you turn this on are downloaded
    automatically each time the cloud library is loaded or refreshed. Everything already in the
    cloud is left alone, and deleting a local copy never downloads it again.
  </p>
</div>
