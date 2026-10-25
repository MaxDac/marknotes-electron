/** Never accept error text or caller-supplied metadata at the diagnostics boundary. */
export const DIAGNOSTIC_CODES = {
  MAIN_UNCAUGHT: 'runtime',
  MAIN_REJECTION: 'runtime',
  RENDERER_UNCAUGHT: 'runtime',
  RENDERER_REJECTION: 'runtime',
  RENDERER_EXITED: 'runtime',
  IPC_FAILED: 'operation',
  DRIVE_FAILED: 'drive',
  LOCK_FAILED: 'storage',
  UPDATE_FAILED: 'update',
  LINK_FAILED: 'operation',
  UI_FAILED: 'operation',
  SYNC_FAILED: 'sync',
  SYNC_STEP_FAILED: 'sync',
  SAVE_FAILED: 'storage',
} as const;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;
export interface DiagnosticRecord {
  time: number;
  code: DiagnosticCode;
}
export interface DiagnosticDraft {
  url: string;
  body: string;
  truncated: boolean;
}
export const DIAGNOSTICS_MAX_BYTES = 5 * 1024 * 1024;
export const DIAGNOSTICS_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export function isDiagnosticCode(code: unknown): code is DiagnosticCode {
  return typeof code === 'string' && Object.hasOwn(DIAGNOSTIC_CODES, code);
}

export function diagnosticLine(record: DiagnosticRecord): string {
  return `${new Date(record.time).toISOString()} ${DIAGNOSTIC_CODES[record.code]} ${record.code}`;
}

export const DIAGNOSTICS_MAX_URL = 2000;

/** Describes the build only (app version, OS family, CPU architecture); never a device or account. */
export function diagnosticEnvironment(version: string, platform: string, arch: string): string {
  const safe = (value: string) => value.replace(/[^\w.+-]/g, '').slice(0, 32) || 'unknown';
  return `MarkNotes Desktop ${safe(version)} (${safe(platform)} ${safe(arch)})`;
}

/** Prefer newest records; encode first so the limit includes every URL character. */
export function diagnosticDraft(records: readonly DiagnosticRecord[], environment?: string): DiagnosticDraft {
  const prefix = 'https://github.com/MaxDac/marknotes-electron/issues/new?';
  const title = 'Report a problem';
  const lines: string[] = [];
  const build = (truncated: boolean) => {
    const body = [
      'Describe the problem and steps to reproduce (review for private information):',
      '',
      ...(environment ? [environment, ''] : []),
      'Sanitized local diagnostics (newest first):',
      ...lines,
      ...(truncated ? ['[Truncated: older records omitted]'] : []),
    ].join('\n');
    const url = `${prefix}${new URLSearchParams({ title, body }).toString()}`;
    return { body, url, truncated };
  };
  for (const record of [...records].reverse()) {
    lines.push(diagnosticLine(record));
    if (build(true).url.length > DIAGNOSTICS_MAX_URL) {
      lines.pop();
      return build(true);
    }
  }
  return build(false);
}
