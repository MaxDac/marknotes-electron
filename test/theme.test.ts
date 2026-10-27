import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_COLOR, normalizeThemeColor, PALETTES } from '../src/renderer/src/ui/theme';

describe('normalizeThemeColor', () => {
  it('keeps current palette names', () => {
    for (const name of Object.keys(PALETTES)) expect(normalizeThemeColor(name)).toBe(name);
  });

  it('maps the removed lime palette to green', () => {
    expect(normalizeThemeColor('lime')).toBe('green');
  });

  it('falls back to the default for unknown values', () => {
    expect(normalizeThemeColor('chartreuse')).toBe(DEFAULT_THEME_COLOR);
    expect(normalizeThemeColor(undefined)).toBe(DEFAULT_THEME_COLOR);
  });
});
