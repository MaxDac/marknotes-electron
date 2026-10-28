import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticsStore } from '../src/main/diagnostics';
import {
  DIAGNOSTICS_MAX_AGE,
  DIAGNOSTICS_MAX_BYTES,
  diagnosticDraft,
  diagnosticEnvironment,
  diagnosticLine,
  isDiagnosticCode,
  type DiagnosticRecord,
} from '../src/shared/diagnostics';

let directory: string;
let now: number;
const recordsFile = () => join(directory, 'errors.jsonl');
const totalBytes = () =>
  readdirSync(directory).reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
const seed = (records: unknown[]) =>
  writeFileSync(recordsFile(), records.map((r) => JSON.stringify(r) + '\n').join(''));
const openStore = () => {
  const store = new DiagnosticsStore(directory, () => now);
  store.init();
  return store;
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'marknotes-diagnostics-'));
  now = Date.now();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('replacing the records file', () => {
  const denied = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };

  it('retries a rename that Windows denies while a reader holds the file', () => {
    let calls = 0;
    const store = new DiagnosticsStore(
      directory,
      () => now,
      (from, to) => {
        if (calls++ < 2) denied('EPERM')();
        renameSync(from, to);
      },
    );
    store.record('SAVE_FAILED');
    expect(calls).toBe(3);
    expect(readFileSync(recordsFile(), 'utf8')).toBe(
      JSON.stringify({ time: now, code: 'SAVE_FAILED' }) + '\n',
    );
  });

  it('writes in place and leaves no temporary file when the rename keeps failing', () => {
    const store = new DiagnosticsStore(directory, () => now, denied('EBUSY'));
    store.record('SAVE_FAILED');
    expect(readFileSync(recordsFile(), 'utf8')).toBe(
      JSON.stringify({ time: now, code: 'SAVE_FAILED' }) + '\n',
    );
    expect(readdirSync(directory)).toEqual(['errors.jsonl']);
  });

  it('does not hide other rename errors', () => {
    const store = new DiagnosticsStore(directory, () => now, denied('ENOSPC'));
    expect(() => store.record('SAVE_FAILED')).toThrow('ENOSPC');
  });
});

describe('local diagnostic retention and sanitization', () => {
  it('only stores timestamp and allowlisted code, reconstructing input without metadata', () => {
    seed([
      { time: now, code: 'UI_FAILED', message: 'secret password', path: 'private/note.md', id: 'account' },
    ]);
    const store = openStore();
    expect(readFileSync(recordsFile(), 'utf8')).toBe(JSON.stringify({ time: now, code: 'UI_FAILED' }) + '\n');
    for (const invalid of ['secret password', '__proto__', 'toString', null, { code: 'UI_FAILED' }]) {
      expect(() => store.record(invalid)).toThrow('Invalid diagnostics code');
      expect(isDiagnosticCode(invalid)).toBe(false);
    }
    expect(readFileSync(store.export(), 'utf8')).toBe(
      diagnosticLine({ time: now, code: 'UI_FAILED' }) + '\n',
    );
  });

  it('prunes on startup, write and export, including expired snapshots and future records', () => {
    seed([
      { time: now - DIAGNOSTICS_MAX_AGE - 1, code: 'UI_FAILED' },
      { time: now, code: 'SAVE_FAILED' },
      { time: now + 1, code: 'UI_FAILED' },
    ]);
    const snapshot = join(directory, 'export.txt');
    writeFileSync(snapshot, 'old');
    utimesSync(
      snapshot,
      new Date(now - DIAGNOSTICS_MAX_AGE - 1000),
      new Date(now - DIAGNOSTICS_MAX_AGE - 1000),
    );
    const store = openStore();
    expect(readdirSync(directory)).toEqual(['errors.jsonl']);
    expect(store.draft().body).toContain('SAVE_FAILED');
    expect(store.draft().body).not.toContain('UI_FAILED');
    now += DIAGNOSTICS_MAX_AGE + 1;
    store.record('SYNC_FAILED');
    expect(readFileSync(recordsFile(), 'utf8')).not.toContain('SAVE_FAILED');
    now += DIAGNOSTICS_MAX_AGE + 1;
    expect(readFileSync(store.export(), 'utf8')).toBe('');
  });

  it('enforces the exact 5 MiB combined budget on startup, write and full export', () => {
    const record = { time: now, code: 'SYNC_STEP_FAILED' } satisfies DiagnosticRecord;
    const count = Math.ceil(DIAGNOSTICS_MAX_BYTES / (JSON.stringify(record).length + 1)) + 100;
    seed(Array.from({ length: count }, () => record));
    const store = openStore();
    expect(totalBytes()).toBeLessThanOrEqual(DIAGNOSTICS_MAX_BYTES);
    store.record('SAVE_FAILED');
    expect(totalBytes()).toBeLessThanOrEqual(DIAGNOSTICS_MAX_BYTES);
    const path = store.export();
    expect(totalBytes()).toBeLessThanOrEqual(DIAGNOSTICS_MAX_BYTES);
    const retained = readFileSync(recordsFile(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as DiagnosticRecord);
    expect(readFileSync(path, 'utf8')).toBe(retained.map((r) => diagnosticLine(r) + '\n').join(''));
    expect(retained.at(-1)?.code).toBe('SAVE_FAILED');
    store.clear();
    expect(readdirSync(directory)).toEqual([]);
    expect(store.draft().body).not.toContain('SAVE_FAILED');
  });

  it('expires exports with their oldest record rather than extending retention at export time', () => {
    seed([{ time: now - DIAGNOSTICS_MAX_AGE + 2000, code: 'SAVE_FAILED' }]);
    const store = openStore();
    store.export();
    now += 3000;
    store.record('UI_FAILED');
    expect(readdirSync(directory)).toEqual(['errors.jsonl']);
    expect(store.draft().body).not.toContain('SAVE_FAILED');
  });

  it('drops corrupted or partial lines and keeps recording', () => {
    writeFileSync(
      recordsFile(),
      `bad json\n${JSON.stringify({ time: now, code: 'SAVE_FAILED' })}\n{"time":${now},"code":"NOT_A_CODE"}\n{"time":`,
    );
    writeFileSync(`${recordsFile()}.tmp`, 'left over by a crash');
    const store = openStore();
    expect(readdirSync(directory)).toEqual(['errors.jsonl']);
    expect(readFileSync(recordsFile(), 'utf8')).toBe(
      JSON.stringify({ time: now, code: 'SAVE_FAILED' }) + '\n',
    );
    store.record('UI_FAILED');
    expect(store.draft().body).toContain('UI_FAILED');
    expect(store.draft().body).toContain('SAVE_FAILED');
  });

  it('drops lines that are valid JSON but not records', () => {
    writeFileSync(
      recordsFile(),
      ['42', 'null', '"UI_FAILED"', JSON.stringify({ time: Number.MAX_VALUE, code: 'UI_FAILED' })].join('\n'),
    );
    openStore();
    expect(readFileSync(recordsFile(), 'utf8')).toBe('');
  });

  it('keeps a recent export within the budget and removes it first when records need the space', () => {
    const snapshot = join(directory, 'export.txt');
    const recent = new Date(now - 1000);
    writeFileSync(snapshot, 'exported');
    utimesSync(snapshot, recent, recent);
    seed([{ time: now, code: 'SAVE_FAILED' }]);
    openStore();
    expect(readdirSync(directory).sort()).toEqual(['errors.jsonl', 'export.txt']);

    writeFileSync(snapshot, Buffer.alloc(DIAGNOSTICS_MAX_BYTES));
    utimesSync(snapshot, recent, recent);
    const store = openStore();
    expect(readdirSync(directory)).toEqual(['errors.jsonl']);
    expect(store.draft().body).toContain('SAVE_FAILED');
  });
});

describe('reviewable GitHub draft', () => {
  it('targets desktop and encodes the exact review text without transmitting anything', () => {
    const draft = diagnosticDraft([{ time: now, code: 'DRIVE_FAILED' }]);
    const url = new URL(draft.url);
    expect(url.origin + url.pathname).toBe('https://github.com/MaxDac/marknotes-electron/issues/new');
    expect(url.searchParams.get('body')).toBe(draft.body);
    expect(draft.truncated).toBe(false);
  });

  it('describes only the build, stripping anything that is not a plain version token', () => {
    expect(diagnosticEnvironment('1.4.0-beta.2', 'win32', 'x64')).toBe(
      'MarkNotes Desktop 1.4.0-beta.2 (win32 x64)',
    );
    expect(diagnosticEnvironment('1.0 /home/me', 'linux\n', '')).toBe(
      'MarkNotes Desktop 1.0homeme (linux unknown)',
    );
    const draft = diagnosticDraft(
      [{ time: now, code: 'DRIVE_FAILED' }],
      'MarkNotes Desktop 1.0.0 (linux x64)',
    );
    expect(draft.body).toContain('MarkNotes Desktop 1.0.0 (linux x64)');
  });

  it('bounds the entire encoded URL to 2000 ASCII characters and includes only whole recent records', () => {
    const records = Array.from({ length: 1000 }, (_, i) => ({
      time: now - 1000 + i,
      code: 'MAIN_REJECTION' as const,
    }));
    const draft = diagnosticDraft(records);
    expect(draft.url.length).toBeLessThanOrEqual(2000);
    expect(draft.url).toMatch(/^[\x20-\x7e]+$/);
    expect(draft.truncated).toBe(true);
    expect(draft.body).toContain('[Truncated: older records omitted]');
    const lines = draft.body.split('\n').filter((line) => line.includes('MAIN_REJECTION'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).toEqual(records.slice(-lines.length).reverse().map(diagnosticLine));
    expect(new URL(draft.url).searchParams.get('body')).toBe(draft.body);
  });
});
