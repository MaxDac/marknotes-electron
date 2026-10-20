export type DiffType = 'same' | 'added' | 'removed';

/** A line of a git-style diff. */
export interface DiffLine {
  type: DiffType;
  text: string;
}

/** Above this edit distance the inputs are treated as completely different, to bound memory. */
const MAX_EDIT_DISTANCE = 2000;

/** Splits text into lines, keeping each line terminator so that joining gives back the text. */
export function lines(text: string): string[] {
  if (text === '') return [];
  const result: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      result.push(text.substring(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) result.push(text.substring(start));
  return result;
}

/** Matching index pairs [a, b] of a longest common subsequence, in increasing order. */
export function matches(a: string[], b: string[]): [number, number][] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const result: [number, number][] = [];
  for (let i = 0; i < prefix; i++) result.push([i, i]);
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  for (const [x, y] of myers(midA, midB)) result.push([x + prefix, y + prefix]);
  for (let i = 0; i < suffix; i++) result.push([a.length - suffix + i, b.length - suffix + i]);
  return result;
}

/** Git-style line diff from old to new. */
export function diff(oldText: string, newText: string): DiffLine[] {
  const a = lines(oldText);
  const b = lines(newText);
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const [x, y] of matches(a, b)) {
    while (i < x) result.push({ type: 'removed', text: a[i++] });
    while (j < y) result.push({ type: 'added', text: b[j++] });
    result.push({ type: 'same', text: a[i] });
    i++;
    j++;
  }
  while (i < a.length) result.push({ type: 'removed', text: a[i++] });
  while (j < b.length) result.push({ type: 'added', text: b[j++] });
  return result;
}

function myers(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) return [];
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  const result: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const slice = trace[d];
    const vd = (k: number) => slice[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd(k - 1) < vd(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : vd(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      result.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  result.reverse();
  return result;
}
