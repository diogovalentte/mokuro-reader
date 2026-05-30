// Pure leaf module: imports only ./color. Do NOT import from ./settings here —
// the active-theme store lives in settings.ts to keep this dependency one-way.
import { mix, shade, parseHex } from './color';

export type ThemeBase = 'light' | 'dark';

export type ThemeTokens = {
  background: string; // app canvas + reader viewport
  surface: string; // cards, drawers, navbar, modals
  text: string; // primary text
  muted: string; // secondary text
  border: string; // dividers, outlines
  accent: string; // primary buttons, links, highlights
};

export type CustomTheme = ThemeTokens & { base: ThemeBase };

export type ThemePreset = {
  id: string;
  name: string;
  base: ThemeBase;
  tokens: ThemeTokens; // shown as swatches; basis for custom editing
  /** If set, used verbatim instead of deriveVars() — used to keep Dark a zero-change theme. */
  vars?: Record<string, string>;
};

export type ResolvedTheme = {
  id: string;
  base: ThemeBase;
  vars: Record<string, string>;
};

/** Perceived brightness (0-255) — used to pick a readable on-accent label color. */
function brightness(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return r * 0.299 + g * 0.587 + b * 0.114;
}

/**
 * Expand the six semantic tokens into Tailwind CSS-variable overrides.
 *
 * The app is dark-first: `.dark` is kept active at all times (see ThemeController),
 * so every component — whether it uses a `dark:` variant pair or a bare dark utility
 * — reads from the SAME dark-mode colour slots. We repaint those slots per theme by
 * role rather than relying on each component to provide a light counterpart. This is
 * why a single mapping flips the whole app (including bare-utility components) and is
 * independent of any light/dark "base".
 */
export function deriveVars(tokens: ThemeTokens): Record<string, string> {
  const { background, surface, text, muted, border, accent } = tokens;
  const vars: Record<string, string> = {};

  // Primary text + icons  (text-white, text-gray-50..200 in dark-designed UI)
  vars['--color-white'] = text;
  vars['--color-gray-50'] = text;
  vars['--color-gray-100'] = text;
  vars['--color-gray-200'] = mix(text, muted, 0.3);
  vars['--color-gray-300'] = mix(text, muted, 0.6);

  // Secondary / muted text  (text-gray-400/500)
  vars['--color-gray-400'] = muted;
  vars['--color-gray-500'] = muted;
  vars['--color-body'] = muted; // Flowbite form helper colour

  // Borders, dividers, subtle/elevated fills  (border-/bg-gray-600/700)
  vars['--color-gray-600'] = mix(border, surface, 0.25);
  vars['--color-gray-700'] = border;

  // Surfaces  (bg-gray-800 cards/navbar, gray-900 deeper, gray-950 page bg)
  vars['--color-gray-800'] = surface;
  vars['--color-gray-900'] = mix(surface, background, 0.5);
  vars['--color-gray-950'] = background;
  vars['--color-black'] = background;

  // Accent -> primary scale (buttons, links, focus rings, Flowbite --color-brand)
  vars['--color-primary-300'] = shade(accent, 0.2);
  vars['--color-primary-400'] = shade(accent, 0.1);
  vars['--color-primary-500'] = accent;
  vars['--color-primary-600'] = shade(accent, -0.1);
  vars['--color-primary-700'] = shade(accent, -0.18);
  vars['--color-primary-800'] = shade(accent, -0.28);
  vars['--color-brand'] = accent;

  // Label colour forced onto strong coloured buttons/badges (see app.css), so a
  // remapped `text-white` (= theme text colour) never collides with the accent fill.
  vars['--color-on-accent'] = brightness(accent) > 150 ? '#111111' : '#ffffff';

  // App canvas + reader viewport background.
  vars['--app-bg'] = background;
  vars['--reader-bg'] = background;

  return vars;
}

export function resolveTheme(preset: ThemePreset): ResolvedTheme {
  return {
    id: preset.id,
    base: preset.base,
    vars: preset.vars ?? deriveVars(preset.tokens)
  };
}

export const PRESETS: Record<string, ThemePreset> = {
  dark: {
    id: 'dark',
    name: 'Dark',
    base: 'dark',
    tokens: {
      background: '#030712',
      surface: '#1f2937',
      text: '#ffffff',
      muted: '#9ca3af',
      border: '#374151',
      accent: '#ef562f'
    },
    // Zero-change: keep Tailwind's default ramp + primary, only drive the canvas/reader bg.
    vars: { '--app-bg': '#030712', '--reader-bg': '#030712' }
  },
  eink: {
    id: 'eink',
    name: 'E-ink',
    base: 'light',
    tokens: {
      background: '#ffffff',
      surface: '#ffffff',
      text: '#000000',
      muted: '#404040',
      border: '#bcbcbc',
      accent: '#000000'
    }
  },
  paper: {
    id: 'paper',
    name: 'Paper',
    base: 'light',
    tokens: {
      background: '#f3f4f6',
      surface: '#ffffff',
      text: '#111827',
      muted: '#6b7280',
      border: '#d1d5db',
      accent: '#2563eb'
    }
  },
  sepia: {
    id: 'sepia',
    name: 'Sepia',
    base: 'light',
    tokens: {
      background: '#f1e7d0',
      surface: '#fbf5e6',
      text: '#3a2c1c',
      muted: '#6f5f48',
      border: '#d8c9a8',
      accent: '#9a6a3a'
    }
  },
  nord: {
    id: 'nord',
    name: 'Nord',
    base: 'dark',
    tokens: {
      background: '#2e3440',
      surface: '#3b4252',
      text: '#d8dee9',
      muted: '#81a1c1',
      border: '#4c566a',
      accent: '#88c0d0'
    }
  }
};

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  base: PRESETS.eink.base,
  ...PRESETS.eink.tokens
};
