/**
 * Helpers for the relative, "/"-separated paths used throughout the app.
 * The root folder is the empty string.
 */
export const NOTE_EXTENSION = '.md';

export function join(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

export function parent(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.substring(0, index);
}

export function name(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1);
}

export function depth(path: string): number {
  return path === '' ? 0 : path.split('/').length;
}

export function isAncestor(ancestor: string, path: string): boolean {
  return ancestor === '' || path.startsWith(`${ancestor}/`);
}

export function isNote(path: string): boolean {
  return path.toLowerCase().endsWith(NOTE_EXTENSION);
}

export function displayName(path: string): string {
  const n = name(path);
  return isNote(n) ? n.slice(0, -NOTE_EXTENSION.length) : n;
}

/** Validates a single file or folder name (no separators, no dot-only names). */
export function validateName(value: string): void {
  if (value.trim() === '') throw new Error('Name cannot be empty');
  if (value.trim() !== value) throw new Error('Name cannot start or end with spaces');
  if (value.includes('/') || value.includes('\\')) throw new Error('Name cannot contain / or \\');
  if (value === '.' || value === '..') throw new Error('Invalid name');
  if (value.startsWith('.')) throw new Error('Name cannot start with a dot');
}

/** Normalizes and validates a relative path. */
export function normalize(path: string): string {
  const parts = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((p) => p !== '');
  parts.forEach(validateName);
  return parts.join('/');
}

export function compareByDepthThenPath(a: string, b: string): number {
  return depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0);
}
