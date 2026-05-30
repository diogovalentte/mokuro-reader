import { describe, expect, it } from 'vitest';
import { PRESETS, deriveVars, resolveTheme, type ThemeTokens } from './theme';

const TOKENS: ThemeTokens = {
  background: '#ffffff',
  surface: '#ffffff',
  text: '#000000',
  muted: '#666666',
  border: '#cccccc',
  accent: '#2563eb'
};

describe('deriveVars (light base)', () => {
  const vars = deriveVars(TOKENS, 'light');
  it('maps the app canvas to the background token', () => {
    expect(vars['--app-bg']).toBe('#ffffff');
  });
  it('maps --color-white to the surface token', () => {
    expect(vars['--color-white']).toBe('#ffffff');
  });
  it('drives the reader viewport from the background token', () => {
    expect(vars['--reader-bg']).toBe('#ffffff');
  });
  it('sets the accent onto the primary scale', () => {
    expect(vars['--color-primary-500']).toBe('#2563eb');
    expect(vars['--color-brand']).toBe('#2563eb');
  });
  it('pins the border token to gray-200 in light base', () => {
    expect(vars['--color-gray-200']).toBe('#cccccc');
  });
});

describe('deriveVars (dark base)', () => {
  const vars = deriveVars(
    { ...TOKENS, background: '#111111', surface: '#222222', text: '#eeeeee' },
    'dark'
  );
  it('maps --color-white to the (light) text token so text-white stays readable', () => {
    expect(vars['--color-white']).toBe('#eeeeee');
  });
  it('pins the border token to gray-700 in dark base', () => {
    expect(vars['--color-gray-700']).toBe('#cccccc');
  });
});

describe('PRESETS', () => {
  it('includes the five built-in presets', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(['dark', 'eink', 'nord', 'paper', 'sepia']);
  });
  it('keeps Dark a zero-change theme (no ramp overrides, only reader bg)', () => {
    const resolved = resolveTheme(PRESETS.dark);
    expect(resolved.base).toBe('dark');
    expect(resolved.vars['--color-gray-950']).toBeUndefined();
    expect(resolved.vars['--app-bg']).toBe('#030712');
  });
});

describe('resolveTheme (custom)', () => {
  it('derives a full var map from tokens when no explicit vars are given', () => {
    const resolved = resolveTheme({
      id: 'custom',
      name: 'Custom',
      base: 'light',
      tokens: TOKENS
    });
    expect(resolved.id).toBe('custom');
    expect(resolved.vars['--color-white']).toBe('#ffffff');
  });
});
