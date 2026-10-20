import { describe, expect, it } from 'vitest';
import { MANIFEST_FORMAT_VERSION, MANIFEST_PATH, SyncManifest } from '../src/shared/manifest';

describe('SyncManifest', () => {
  const manifest = new SyncManifest('device-1', 1234, {
    'b/z.md': { sha256: 'h2', version: 'v2', syncedAt: 20 },
    'a.md': { sha256: 'h1', version: 'v1', syncedAt: 10 },
  });

  it('lives in the .marknotes folder', () => {
    expect(MANIFEST_PATH).toBe('.marknotes/manifest.json');
    expect(MANIFEST_FORMAT_VERSION).toBe(1);
  });

  it('serializes keys in a stable order with files sorted by path', () => {
    expect(manifest.toJson()).toBe(
      '{"format":1,"app":"MarkNotes","deviceId":"device-1","updatedAt":1234,"files":{' +
        '"a.md":{"sha256":"h1","version":"v1","syncedAt":10},' +
        '"b/z.md":{"sha256":"h2","version":"v2","syncedAt":20}}}',
    );
  });

  it('round trips through parse', () => {
    const parsed = SyncManifest.parse(manifest.toJson());
    expect(parsed).not.toBeNull();
    expect(parsed!.deviceId).toBe('device-1');
    expect(parsed!.updatedAt).toBe(1234);
    expect(parsed!.files).toEqual(manifest.files);
  });

  it('parses a manifest without files', () => {
    const parsed = SyncManifest.parse('{"format":1,"deviceId":"d","updatedAt":5}');
    expect(parsed!.files).toEqual({});
  });

  it('rejects newer formats and unreadable input', () => {
    expect(
      SyncManifest.parse('{"format":2,"app":"MarkNotes","deviceId":"d","updatedAt":1,"files":{}}'),
    ).toBeNull();
    expect(SyncManifest.parse('not json')).toBeNull();
    expect(SyncManifest.parse('{"format":1,"updatedAt":1}')).toBeNull();
    expect(
      SyncManifest.parse('{"format":1,"deviceId":"d","updatedAt":1,"files":{"a.md":{"sha256":"h"}}}'),
    ).toBeNull();
  });

  it('sameFilesAs ignores writer, time and syncedAt', () => {
    const other = new SyncManifest('device-2', 9999, {
      'a.md': { sha256: 'h1', version: 'v1', syncedAt: 99 },
      'b/z.md': { sha256: 'h2', version: 'v2', syncedAt: 99 },
    });
    expect(manifest.sameFilesAs(other)).toBe(true);
    expect(other.sameFilesAs(manifest)).toBe(true);
  });

  it('sameFilesAs detects differences', () => {
    expect(manifest.sameFilesAs(null)).toBe(false);
    expect(manifest.sameFilesAs(undefined)).toBe(false);
    const changedHash = new SyncManifest('device-1', 1234, {
      ...manifest.files,
      'a.md': { sha256: 'other', version: 'v1', syncedAt: 10 },
    });
    expect(manifest.sameFilesAs(changedHash)).toBe(false);
    const changedVersion = new SyncManifest('device-1', 1234, {
      ...manifest.files,
      'a.md': { sha256: 'h1', version: 'v9', syncedAt: 10 },
    });
    expect(manifest.sameFilesAs(changedVersion)).toBe(false);
    const fewer = new SyncManifest('device-1', 1234, { 'a.md': manifest.files['a.md'] });
    expect(manifest.sameFilesAs(fewer)).toBe(false);
    expect(fewer.sameFilesAs(manifest)).toBe(false);
  });
});
