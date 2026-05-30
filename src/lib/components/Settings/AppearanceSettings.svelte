<script lang="ts">
  import { AccordionItem, Label } from 'flowbite-svelte';
  import { get } from 'svelte/store';
  import { settings, updateSetting, PRESETS, type ThemeTokens } from '$lib/settings';

  const presetList = Object.values(PRESETS);

  type TokenField = { key: keyof ThemeTokens; label: string };
  const tokenFields: TokenField[] = [
    { key: 'background', label: 'Background' },
    { key: 'surface', label: 'Surface' },
    { key: 'text', label: 'Text' },
    { key: 'muted', label: 'Muted' },
    { key: 'border', label: 'Border' },
    { key: 'accent', label: 'Accent' },
    { key: 'secondary', label: 'Secondary (downloads)' }
  ];

  let current = $derived($settings?.theme ?? 'dark');
  let custom = $derived(
    $settings?.customTheme ?? { base: 'light' as const, ...PRESETS.eink.tokens }
  );

  function selectPreset(id: string) {
    updateSetting('theme', id);
  }

  function editCustom() {
    // Switching to Custom seeds the editor from whatever preset is active now,
    // so users start from a familiar palette instead of a blank one.
    const activeId = get(settings)?.theme ?? 'dark';
    const active = PRESETS[activeId];
    if (activeId !== 'custom' && active) {
      updateSetting('customTheme', { base: active.base, ...active.tokens });
    }
    updateSetting('theme', 'custom');
  }

  function setToken(key: keyof ThemeTokens, value: string) {
    updateSetting('customTheme', { ...get(settings).customTheme, [key]: value });
  }
</script>

<AccordionItem>
  {#snippet header()}Appearance{/snippet}
  <div class="flex flex-col gap-4">
    <div class="grid grid-cols-2 gap-2">
      {#each presetList as preset (preset.id)}
        <button
          type="button"
          class="relative z-10 flex items-center gap-2 rounded-lg border p-2 text-left text-sm
            {current === preset.id
            ? 'border-primary-500 ring-2 ring-primary-500'
            : 'border-gray-300 dark:border-gray-600'}"
          onclick={() => selectPreset(preset.id)}
        >
          <span
            class="h-6 w-6 shrink-0 rounded-full border border-gray-400"
            style:background-color={preset.tokens.background}
          ></span>
          <span
            class="h-6 w-6 shrink-0 rounded-full border border-gray-400"
            style:background-color={preset.tokens.accent}
          ></span>
          <span class="text-gray-900 dark:text-white">{preset.name}</span>
        </button>
      {/each}
      <button
        type="button"
        class="relative z-10 flex items-center gap-2 rounded-lg border p-2 text-left text-sm
          {current === 'custom'
          ? 'border-primary-500 ring-2 ring-primary-500'
          : 'border-gray-300 dark:border-gray-600'}"
        onclick={editCustom}
      >
        <span class="text-gray-900 dark:text-white">Custom…</span>
      </button>
    </div>

    {#if current === 'custom'}
      <div class="flex flex-col gap-3 rounded-lg border border-gray-300 p-3 dark:border-gray-600">
        {#each tokenFields as field (field.key)}
          <div class="flex items-center justify-between gap-3">
            <Label class="text-gray-900 dark:text-white">{field.label}</Label>
            <input
              type="color"
              value={custom[field.key]}
              oninput={(e) => setToken(field.key, e.currentTarget.value)}
            />
          </div>
        {/each}
      </div>
    {/if}
  </div>
</AccordionItem>
