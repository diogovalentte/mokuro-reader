// Pure leaf module: imports only ./color. Do NOT import from ./settings here —
// the active-theme store lives in settings.ts to keep this dependency one-way.
import { mix, shade } from './color';

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

const STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/** Expand the six semantic tokens into Tailwind CSS-variable overrides. */
export function deriveVars(tokens: ThemeTokens, base: ThemeBase): Record<string, string> {
  const isDark = base === 'dark';
  // The gray ramp runs 50 (lightest) -> 950 (darkest).
  const lightEnd = isDark ? tokens.text : tokens.surface;
  const darkEnd = isDark ? tokens.background : tokens.text;

  const vars: Record<string, string> = {};
  STOPS.forEach((stop, i) => {
    vars[`--color-gray-${stop}`] = mix(lightEnd, darkEnd, i / (STOPS.length - 1));
  });

  // text-white / bg-white anchors. In dark themes "white" is the light text color;
  // in light themes it is the light surface color.
  vars['--color-white'] = isDark ? tokens.text : tokens.surface;
  vars['--color-black'] = isDark ? tokens.background : tokens.text;

  // Pin the surface, border and muted tokens onto plausible ramp stops.
  if (isDark) {
    vars['--color-gray-800'] = tokens.surface;
    vars['--color-gray-700'] = tokens.border;
    vars['--color-gray-400'] = tokens.muted;
  } else {
    vars['--color-gray-50'] = tokens.surface;
    vars['--color-gray-200'] = tokens.border;
    vars['--color-gray-500'] = tokens.muted;
  }
  vars['--color-body'] = tokens.muted; // Flowbite form helper color

  // Accent -> primary scale (+ Flowbite --color-brand used by range sliders).
  vars['--color-primary-400'] = shade(tokens.accent, 0.12);
  vars['--color-primary-500'] = tokens.accent;
  vars['--color-primary-600'] = shade(tokens.accent, -0.12);
  vars['--color-primary-700'] = shade(tokens.accent, -0.24);
  vars['--color-brand'] = tokens.accent;

  // App canvas + reader viewport background.
  vars['--app-bg'] = tokens.background;
  vars['--reader-bg'] = tokens.background;

  return vars;
}

export function resolveTheme(preset: ThemePreset): ResolvedTheme {
  return {
    id: preset.id,
    base: preset.base,
    vars: preset.vars ?? deriveVars(preset.tokens, preset.base)
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
      muted: '#3f3f3f',
      border: '#000000',
      accent: '#000000'
    }
  },
  paper: {
    id: 'paper',
    name: 'Paper',
    base: 'light',
    tokens: {
      background: '#f4f4f5',
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
      background: '#f4ecd8',
      surface: '#faf6ec',
      text: '#433422',
      muted: '#7a6a52',
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
