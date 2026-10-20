export const MANIFEST_DIRECTORY = '.marknotes';
export const MANIFEST_PATH = `${MANIFEST_DIRECTORY}/manifest.json`;
export const MANIFEST_FORMAT_VERSION = 1;

export interface ManifestEntry {
  sha256: string;
  version: string;
  syncedAt: number;
}

/**
 * Map of the notes stored in a drive, written to MANIFEST_PATH inside the synced folder after each
 * sync. Same format as the MarkNotes Android app.
 */
export class SyncManifest {
  constructor(
    readonly deviceId: string,
    readonly updatedAt: number,
    readonly files: Record<string, ManifestEntry>,
  ) {}

  toJson(): string {
    const files: Record<string, ManifestEntry> = {};
    for (const path of Object.keys(this.files).sort()) {
      const e = this.files[path];
      files[path] = { sha256: e.sha256, version: e.version, syncedAt: e.syncedAt };
    }
    return JSON.stringify({
      format: MANIFEST_FORMAT_VERSION,
      app: 'MarkNotes',
      deviceId: this.deviceId,
      updatedAt: this.updatedAt,
      files,
    });
  }

  /** True when both manifests describe the same files, ignoring who wrote them and when. */
  sameFilesAs(other: SyncManifest | null | undefined): boolean {
    if (!other) return false;
    const a = Object.keys(this.files);
    const b = Object.keys(other.files);
    if (a.length !== b.length) return false;
    return a.every((p) => {
      const o = other.files[p];
      return o !== undefined && o.sha256 === this.files[p].sha256 && o.version === this.files[p].version;
    });
  }

  /** Parses a manifest; returns null for unreadable or newer-format manifests. */
  static parse(json: string): SyncManifest | null {
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      if (typeof obj.format !== 'number' || obj.format > MANIFEST_FORMAT_VERSION) return null;
      if (typeof obj.deviceId !== 'string' || typeof obj.updatedAt !== 'number') return null;
      const files: Record<string, ManifestEntry> = {};
      const raw = (obj.files ?? {}) as Record<string, Record<string, unknown>>;
      for (const [path, e] of Object.entries(raw)) {
        if (typeof e.sha256 !== 'string' || typeof e.version !== 'string' || typeof e.syncedAt !== 'number') {
          return null;
        }
        files[path] = { sha256: e.sha256, version: e.version, syncedAt: e.syncedAt };
      }
      return new SyncManifest(obj.deviceId, obj.updatedAt, files);
    } catch {
      return null;
    }
  }
}
