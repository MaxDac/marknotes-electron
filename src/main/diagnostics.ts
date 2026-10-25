import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DIAGNOSTICS_MAX_AGE,
  DIAGNOSTICS_MAX_BYTES,
  diagnosticDraft,
  diagnosticLine,
  isDiagnosticCode,
  type DiagnosticCode,
  type DiagnosticRecord,
} from '../shared/diagnostics';

/** Synchronous writes also work in a fatal exception handler; no raw exception ever crosses this boundary. */
export class DiagnosticsStore {
  private readonly file: string;

  constructor(
    private readonly directory: string,
    private readonly now = Date.now,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, 'errors.jsonl');
  }

  init() {
    this.prune();
  }

  private files() {
    return readdirSync(this.directory).map((name) => {
      const path = join(this.directory, name);
      return { path, ...statSync(path) };
    });
  }

  /** Invalid or partial lines (e.g. a write cut short by a crash) are dropped, never surfaced. */
  private read(): DiagnosticRecord[] {
    if (!existsSync(this.file)) return [];
    const records: DiagnosticRecord[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof value !== 'object' || value === null) continue;
      const { time, code } = value as Record<string, unknown>;
      if (typeof time !== 'number' || !Number.isSafeInteger(time) || !isDiagnosticCode(code)) continue;
      if (time >= this.now() - DIAGNOSTICS_MAX_AGE && time <= this.now()) records.push({ time, code });
    }
    return records;
  }

  private save(records: DiagnosticRecord[]) {
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, records.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  private prune(exporting = false, code?: DiagnosticCode): DiagnosticRecord[] {
    const records = this.read();
    if (code) records.push({ time: this.now(), code });
    let snapshotBytes = 0;
    const snapshots: { path: string; size: number; mtimeMs: number }[] = [];
    for (const file of this.files()) {
      if (file.path === this.file) continue;
      if (
        exporting ||
        file.mtimeMs < this.now() - DIAGNOSTICS_MAX_AGE ||
        file.mtimeMs > this.now() ||
        file.path !== join(this.directory, 'export.txt')
      ) {
        unlinkSync(file.path);
      } else {
        snapshots.push(file);
        snapshotBytes += file.size;
      }
    }
    const cost = (r: DiagnosticRecord) =>
      Buffer.byteLength(JSON.stringify(r) + '\n') +
      (exporting ? Buffer.byteLength(diagnosticLine(r) + '\n') : 0);
    let size = records.reduce((sum, r) => sum + cost(r), 0);
    for (const snapshot of snapshots) {
      if (size + snapshotBytes <= DIAGNOSTICS_MAX_BYTES) break;
      unlinkSync(snapshot.path);
      snapshotBytes -= snapshot.size;
    }
    let start = 0;
    while (size + snapshotBytes > DIAGNOSTICS_MAX_BYTES && start < records.length) {
      size -= cost(records[start++]);
    }
    const retained = records.slice(start);
    this.save(retained);
    return retained;
  }

  record(code: unknown) {
    if (!isDiagnosticCode(code)) throw new Error('Invalid diagnostics code');
    this.prune(false, code);
  }

  draft(environment?: string) {
    return diagnosticDraft(this.prune(), environment);
  }

  export(): string {
    const records = this.prune(true);
    const path = join(this.directory, 'export.txt');
    writeFileSync(path, records.map((record) => diagnosticLine(record) + '\n').join(''), { mode: 0o600 });
    // A snapshot expires with its oldest record, not seven days after the export.
    const oldest = new Date(records[0]?.time ?? this.now());
    utimesSync(path, oldest, oldest);
    return path;
  }

  clear() {
    for (const file of this.files()) unlinkSync(file.path);
  }
}
