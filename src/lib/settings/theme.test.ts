import { describe, expect, it } from 'vitest';
import { PRESETS, deriveVars, resolveTheme, type ThemeTokens } from './theme';

const TOKENS: ThemeTokens = {
  background: '#ffffff',
  surface: '#ffffff',
  text: '#000000',
  muted: '#666666',
  border: '#cccccc',
  accent: '#2563eb',
  secondary: '#0e7490'
};

describe('deriveVars (role-based, base-independent)', () => {
  const vars = deriveVars(TOKENS);

  it('maps the app canvas + reader viewport to the background token', () => {
    expect(vars['--app-bg']).toBe('#ffffff');
    expect(vars['--reader-bg']).toBe('#ffffff');
  });

  it('maps --color-white to the TEXT token (.dark is always on, so text-white = body text)', () => {
    expect(vars['--color-white']).toBe('#000000');
    expect(vars['--color-gray-50']).toBe('#000000');
  });

  it('maps the surface slot (gray-800) and page bg slot (gray-950)', () => {
    expect(vars['--color-gray-800']).toBe('#ffffff'); // surface
    expect(vars['--color-gray-950']).toBe('#ffffff'); // background
    expect(vars['--color-black']).toBe('#ffffff'); // deepest bg
  });

  it('maps muted text and borders onto their slots', () => {
    expect(vars['--color-gray-400']).toBe('#666666'); // muted
    expect(vars['--color-gray-700']).toBe('#cccccc'); // border
  });

  it('sets the accent onto the primary scale', () => {
    expect(vars['--color-primary-500']).toBe('#2563eb');
    expect(vars['--color-brand']).toBe('#2563eb');
  });

  it('sets the secondary token onto the blue scale (download/cloud tone)', () => {
    expect(vars['--color-blue-500']).toBe('#0e7490');
    expect(vars['--color-blue-400']).toBeDefined();
    expect(vars['--color-blue-700']).toBeDefined();
  });

  it('picks a readable on-accent label colour (white on a dark accent)', () => {
    expect(vars['--color-on-accent']).toBe('#ffffff');
  });

  it('picks a dark on-accent label colour on a light accent', () => {
    const light = deriveVars({ ...TOKENS, accent: '#fde047' }); // light yellow
    expect(light['--color-on-accent']).toBe('#111111');
  });
});

describe('PRESETS', () => {
  it('includes the five built-in presets', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(['dark', 'eink', 'nord', 'paper', 'sepia']);
  });
  it('keeps Dark a zero-change theme (no ramp overrides, only canvas/reader bg)', () => {
    const resolved = resolveTheme(PRESETS.dark);
    expect(resolved.vars['--color-gray-950']).toBeUndefined();
    expect(resolved.vars['--color-white']).toBeUndefined();
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
    expect(resolved.vars['--color-white']).toBe('#000000');
    expect(resolved.vars['--app-bg']).toBe('#ffffff');
  });
});
