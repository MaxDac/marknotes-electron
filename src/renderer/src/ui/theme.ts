export type ThemeMode = 'system' | 'light' | 'dark';
export type ThemeColor =
  'violet' | 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'pink' | 'purple';

export const DEFAULT_THEME_COLOR: ThemeColor = 'violet';

export const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Accent colours of the web app; the stylesheet has the same values under `:root[data-accent]`. */
export const PALETTES: Record<ThemeColor, { label: string; accent: string }> = {
  violet: { label: 'Violet', accent: '#6d4aff' },
  blue: { label: 'Blue', accent: '#2563eb' },
  teal: { label: 'Teal', accent: '#0d9488' },
  green: { label: 'Green', accent: '#16a34a' },
  amber: { label: 'Amber', accent: '#b7791f' },
  orange: { label: 'Orange', accent: '#ea580c' },
  red: { label: 'Red', accent: '#dc2626' },
  pink: { label: 'Pink', accent: '#db2777' },
  purple: { label: 'Purple', accent: '#9333ea' },
};

/** A stored colour name, with the names of earlier palettes mapped to the closest current one. */
export function normalizeThemeColor(stored: unknown): ThemeColor {
  if (stored === 'lime') return 'green';
  return typeof stored === 'string' && stored in PALETTES ? (stored as ThemeColor) : DEFAULT_THEME_COLOR;
}

/** Applies the theme as attributes on the document root; the stylesheet defines the colours. */
export function applyTheme(mode: ThemeMode, color: ThemeColor, systemDark: boolean) {
  const dark = mode === 'dark' || (mode === 'system' && systemDark);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.accent = normalizeThemeColor(color);
}
