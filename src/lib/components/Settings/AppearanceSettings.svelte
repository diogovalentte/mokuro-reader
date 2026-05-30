<script lang="ts">
  import { AccordionItem, Label } from 'flowbite-svelte';
  import {
    ImageSolid,
    FontColorAltSolid,
    BookmarkSolid,
    DownloadSolid,
    CheckCircleSolid,
    TrashBinSolid
  } from 'flowbite-svelte-icons';
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
    { key: 'secondary', label: 'Secondary (downloads)' },
    { key: 'success', label: 'Success (read / sync)' },
    { key: 'danger', label: 'Danger (delete / warning)' }
  ];

  let current = $derived($settings?.theme ?? 'dark');
  let custom = $derived(
    $settings?.customTheme ?? { base: 'light' as const, ...PRESETS.eink.tokens }
  );

  // Each swatch button previews its own theme (surface bg, text colour, accent dot).
  let swatches = $derived([
    ...presetList.map((p) => ({ id: p.id, name: p.name, tokens: p.tokens })),
    { id: 'custom', name: 'Custom…', tokens: custom as ThemeTokens }
  ]);

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
      {#each swatches as sw (sw.id)}
        <button
          type="button"
          class="relative z-10 flex flex-col items-start gap-1.5 rounded-lg border-2 p-2 text-left text-sm"
          style:background-color={sw.tokens.surface}
          style:color={sw.tokens.text}
          style:border-color={current === sw.id ? sw.tokens.accent : sw.tokens.border}
          style:box-shadow={current === sw.id ? `0 0 0 2px ${sw.tokens.accent}` : undefined}
          onclick={() => (sw.id === 'custom' ? editCustom() : selectPreset(sw.id))}
        >
          <span class="font-medium">{sw.name}</span>
          <!-- The whole palette at a glance: one icon per token, each tinted with
               its colour and ordered to match the custom editor (background,
               muted, accent, secondary "download", success "mark as done", danger
               "delete"). Surface = button bg, text = label, border = the button's
               own outline. A faint muted outline keeps icons whose colour is close
               to the surface (e.g. background) visible. -->
          {#snippet roleIcon(color: string, Icon: typeof ImageSolid)}
            <span style:color style:filter="drop-shadow(0 0 0.5px {sw.tokens.muted})">
              <Icon class="h-4 w-4" />
            </span>
          {/snippet}
          <span class="flex flex-wrap items-center gap-1.5">
            {@render roleIcon(sw.tokens.background, ImageSolid)}
            {@render roleIcon(sw.tokens.muted, FontColorAltSolid)}
            {@render roleIcon(sw.tokens.accent, BookmarkSolid)}
            {@render roleIcon(sw.tokens.secondary, DownloadSolid)}
            {@render roleIcon(sw.tokens.success, CheckCircleSolid)}
            {@render roleIcon(sw.tokens.danger, TrashBinSolid)}
          </span>
        </button>
      {/each}
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
