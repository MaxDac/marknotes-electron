export type ThemeMode = 'system' | 'light' | 'dark';
export type ThemeColor = 'blue' | 'teal' | 'green' | 'lime' | 'amber' | 'orange' | 'red' | 'purple';

export const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Primary colours of each palette: tone 40 for light mode and tone 80 for dark mode (same as Android). */
export const PALETTES: Record<ThemeColor, { label: string; light: string; dark: string }> = {
  blue: { label: 'Blue', light: '#1E5EB4', dark: '#A8C8FF' },
  teal: { label: 'Teal', light: '#006A65', dark: '#4FDBD3' },
  green: { label: 'Green', light: '#2E6B2F', dark: '#94D88E' },
  lime: { label: 'Lime', light: '#566500', dark: '#BDD161' },
  amber: { label: 'Amber', light: '#7A5900', dark: '#F6BE3C' },
  orange: { label: 'Orange', light: '#9A4600', dark: '#FFB68A' },
  red: { label: 'Red', light: '#B3261E', dark: '#FFB4AB' },
  purple: { label: 'Purple', light: '#6750A4', dark: '#D0BCFF' },
};

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.substring(i, i + 2), 16));
const toHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const lerp = (a: string, b: string, t: number) => {
  const x = hex(a);
  const y = hex(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
};

/** Applies the theme as CSS variables on the document root. */
export function applyTheme(mode: ThemeMode, color: ThemeColor, systemDark: boolean) {
  const dark = mode === 'dark' || (mode === 'system' && systemDark);
  const palette = PALETTES[color] ?? PALETTES.blue;
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  const primary = dark ? palette.dark : palette.light;
  root.style.setProperty('--primary', primary);
  root.style.setProperty('--on-primary', dark ? lerp(palette.light, '#000000', 0.55) : '#ffffff');
  root.style.setProperty(
    '--primary-container',
    dark ? lerp(palette.light, '#000000', 0.25) : lerp(palette.light, '#ffffff', 0.82),
  );
  root.style.setProperty(
    '--on-primary-container',
    dark ? lerp(primary, '#ffffff', 0.6) : lerp(primary, '#000000', 0.6),
  );
}
