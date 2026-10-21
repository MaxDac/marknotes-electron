import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deprecatedPackages(lockfile: unknown): string[] {
  if (
    !isRecord(lockfile) ||
    lockfile.lockfileVersion !== 3 ||
    !isRecord(lockfile.packages) ||
    !isRecord(lockfile.packages[''])
  ) {
    throw new Error('Expected an npm v3 lockfile with a root package and a packages object.');
  }
  const findings: string[] = [];
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (
      !isRecord(entry) ||
      typeof entry.version !== 'string' ||
      (entry.deprecated !== undefined && typeof entry.deprecated !== 'string')
    ) {
      throw new Error(`Invalid lockfile package entry: ${path || '(root)'}`);
    }
    if (typeof entry.deprecated === 'string' && entry.deprecated.trim()) {
      findings.push(`${path || '(root)'}@${entry.version}: ${entry.deprecated}`);
    }
  }
  return findings;
}

export function requireCleanAudit(report: unknown): void {
  if (
    !isRecord(report) ||
    report.auditReportVersion !== 2 ||
    !isRecord(report.vulnerabilities) ||
    !isRecord(report.metadata) ||
    !isRecord(report.metadata.vulnerabilities)
  ) {
    throw new Error('Invalid or incomplete npm audit report.');
  }
  const counts = report.metadata.vulnerabilities;
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical', 'total']) {
    const count = counts[severity];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Missing or invalid npm audit count: ${severity}`);
    }
    if (count !== 0) throw new Error(`Dependency audit reported ${count} ${severity} vulnerabilities.`);
  }
  if (Object.keys(report.vulnerabilities).length !== 0) {
    throw new Error('Dependency audit contains vulnerabilities despite zero summary counts.');
  }
  if (report.error !== undefined) throw new Error('npm audit reported an error.');
}

function main() {
  if (process.argv[2] === undefined) {
    const lockfile: unknown = JSON.parse(
      readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'),
    );
    const findings = deprecatedPackages(lockfile);
    if (findings.length) throw new Error(`Deprecated dependencies:\n${findings.join('\n')}`);
    console.log('No deprecated packages recorded in the complete lockfile.');
  } else if (process.argv[2] === 'audit') {
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Run the audit through npm run deps:audit.');
    const result = spawnSync(
      process.execPath,
      [
        npm,
        'audit',
        '--package-lock-only',
        '--include=dev',
        '--include=optional',
        '--include=peer',
        '--audit-level=low',
        '--json',
      ],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    requireCleanAudit(JSON.parse(result.stdout));
    if (result.status !== 0) throw new Error(`npm audit failed with status ${result.status}.`);
    console.log('Zero known vulnerabilities across all dependency classes.');
  } else {
    throw new Error('Usage: node scripts/check-dependencies.ts [audit]');
  }
}

if (import.meta.main) main();
