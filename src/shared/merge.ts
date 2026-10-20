import { lines, matches } from './diff';

export type MergeChunk =
  | { kind: 'resolved'; lines: string[]; changed: boolean }
  | { kind: 'conflict'; base: string[]; local: string[]; remote: string[] };

export type ConflictChunk = Extract<MergeChunk, { kind: 'conflict' }>;

/** How a single conflicting region is resolved. */
export type ConflictChoice = 'local' | 'remote' | 'both' | 'neither';

export const MARKER_LOCAL = '<<<<<<< this device';
export const MARKER_SEPARATOR = '=======';
export const MARKER_REMOTE = '>>>>>>> drive';

export class MergeResult {
  constructor(readonly chunks: MergeChunk[]) {}

  get conflicts(): ConflictChunk[] {
    return this.chunks.filter((c): c is ConflictChunk => c.kind === 'conflict');
  }

  get hasConflicts(): boolean {
    return this.chunks.some((c) => c.kind === 'conflict');
  }

  /**
   * Builds the merged text. `choices` is indexed by conflict (0 = first conflict); unresolved
   * conflicts are written with git-style markers.
   */
  text(choices: Partial<Record<number, ConflictChoice>> = {}): string {
    let out = '';
    const appendLines = (ls: string[]) => {
      out += ls.join('');
      if (ls.length > 0 && !ls[ls.length - 1].endsWith('\n')) out += '\n';
    };
    let conflictIndex = 0;
    for (const chunk of this.chunks) {
      if (chunk.kind === 'resolved') {
        out += chunk.lines.join('');
        continue;
      }
      switch (choices[conflictIndex]) {
        case 'local':
          out += chunk.local.join('');
          break;
        case 'remote':
          out += chunk.remote.join('');
          break;
        case 'both':
          appendLines(chunk.local);
          out += chunk.remote.join('');
          break;
        case 'neither':
          break;
        default:
          out += `${MARKER_LOCAL}\n`;
          appendLines(chunk.local);
          out += `${MARKER_SEPARATOR}\n`;
          appendLines(chunk.remote);
          out += `${MARKER_REMOTE}\n`;
      }
      conflictIndex++;
    }
    return out;
  }
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Line-based three-way merge (diff3). Without a base nothing can be merged safely: lines common to
 * both are kept and every difference is a conflict.
 */
export function merge3(base: string | null | undefined, local: string, remote: string): MergeResult {
  const l = lines(local);
  const r = lines(remote);
  if (local === remote) return new MergeResult([{ kind: 'resolved', lines: l, changed: false }]);
  const autoResolve = base != null;
  const o = base != null ? lines(base) : matches(l, r).map(([i]) => l[i]);
  return new MergeResult(diff3(o, l, r, autoResolve));
}

function diff3(o: string[], a: string[], b: string[], autoResolve: boolean): MergeChunk[] {
  const matchA = new Array<number>(o.length).fill(-1);
  const matchB = new Array<number>(o.length).fill(-1);
  for (const [i, j] of matches(o, a)) matchA[i] = j;
  for (const [i, j] of matches(o, b)) matchB[i] = j;
  const chunks: MergeChunk[] = [];

  const addResolved = (ls: string[], changed: boolean) => {
    if (ls.length === 0) return;
    const last = chunks[chunks.length - 1];
    if (last && last.kind === 'resolved' && last.changed === changed) {
      chunks[chunks.length - 1] = { kind: 'resolved', lines: [...last.lines, ...ls], changed };
    } else {
      chunks.push({ kind: 'resolved', lines: ls, changed });
    }
  };
  const addUnstable = (oPart: string[], aPart: string[], bPart: string[]) => {
    if (sameLines(aPart, bPart)) addResolved(aPart, !sameLines(aPart, oPart));
    else if (autoResolve && sameLines(aPart, oPart)) addResolved(bPart, true);
    else if (autoResolve && sameLines(bPart, oPart)) addResolved(aPart, true);
    else chunks.push({ kind: 'conflict', base: oPart, local: aPart, remote: bPart });
  };

  let lo = 0;
  let la = 0;
  let lb = 0;
  for (;;) {
    let i = 0;
    while (lo + i < o.length && matchA[lo + i] === la + i && matchB[lo + i] === lb + i) i++;
    if (i > 0) {
      addResolved(o.slice(lo, lo + i), false);
      lo += i;
      la += i;
      lb += i;
      continue;
    }
    let next = lo;
    while (next < o.length && (matchA[next] < 0 || matchB[next] < 0)) next++;
    if (next >= o.length) {
      if (lo < o.length || la < a.length || lb < b.length) {
        addUnstable(o.slice(lo), a.slice(la), b.slice(lb));
      }
      break;
    }
    addUnstable(o.slice(lo, next), a.slice(la, matchA[next]), b.slice(lb, matchB[next]));
    lo = next;
    la = matchA[next];
    lb = matchB[next];
  }
  return chunks;
}
