import { describe, expect, it } from 'vitest';
import { deprecatedPackages, requireCleanAudit } from '../scripts/check-dependencies';

const lock = (packages: Record<string, unknown> = {}) => ({
  lockfileVersion: 3,
  packages: { '': { version: '1.0.0' }, ...packages },
});
const audit = (counts: Record<string, unknown> = {}) => ({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...counts },
  },
});

describe('dependency deprecation policy', () => {
  it('accepts a clean complete lockfile', () => {
    expect(
      deprecatedPackages(lock({ 'node_modules/current': { version: '2.0.0', deprecated: '' } })),
    ).toEqual([]);
  });

  it('reports root, nested, development and optional platform-specific entries', () => {
    const findings = deprecatedPackages(
      lock({
        '': { version: '1.0.0', deprecated: 'root reason' },
        'node_modules/parent/node_modules/old': {
          version: '2.0.0',
          deprecated: 'nested reason',
          dev: true,
        },
        'node_modules/windows-only': {
          version: '3.0.0',
          deprecated: 'optional reason',
          optional: true,
          os: ['win32'],
        },
      }),
    );
    expect(findings).toEqual([
      '(root)@1.0.0: root reason',
      'node_modules/parent/node_modules/old@2.0.0: nested reason',
      'node_modules/windows-only@3.0.0: optional reason',
    ]);
  });

  it.each([
    null,
    [],
    {},
    { lockfileVersion: 2, packages: {} },
    { lockfileVersion: 3, packages: {} },
    lock({ 'node_modules/bad': null }),
    lock({ 'node_modules/bad': { version: 1 } }),
    lock({ 'node_modules/bad': { version: '1', deprecated: true } }),
  ])('rejects malformed lockfile data: %j', (value) => {
    expect(() => deprecatedPackages(value)).toThrow();
  });
});

describe('dependency vulnerability policy', () => {
  it('accepts only an explicitly clean audit', () => {
    expect(() => requireCleanAudit(audit())).not.toThrow();
  });

  it.each(['info', 'low', 'moderate', 'high', 'critical', 'total'])(
    'rejects nonzero %s counts',
    (severity) => {
      expect(() => requireCleanAudit(audit({ [severity]: 1 }))).toThrow(/vulnerabilities/);
    },
  );

  it.each([
    null,
    {},
    { error: { code: 'ENOAUDIT' } },
    { ...audit(), auditReportVersion: 1 },
    { ...audit(), vulnerabilities: null },
    { ...audit(), metadata: {} },
    audit({ low: undefined }),
    audit({ low: '0' }),
    audit({ low: -1 }),
    audit({ low: 0.5 }),
    { ...audit(), vulnerabilities: { vulnerable: {} } },
    { ...audit(), error: { code: 'ECONNRESET' } },
  ])('rejects incomplete, erroneous or inconsistent reports: %j', (value) => {
    expect(() => requireCleanAudit(value)).toThrow();
  });
});
