import { parseManifest, readId } from '@marknotes/sync';
import { describe, expect, it } from 'vitest';
import { ConflictMergeBack } from '../src/shared/conflictMergeBack';
import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import { utf8 } from '../src/shared/hashing';
import { MultiDriveSync, type DriveSyncTarget } from '../src/shared/multiDriveSync';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import { InMemoryBaseContentStore, InMemorySyncMetadataStore } from '../src/shared/types';

/** One MarkNotes device: its own notes, sync records and base copies for each shared drive. */
class Device {
  readonly notes: NoteStore;
  private readonly targets: DriveSyncTarget[];
  private readonly sync: MultiDriveSync;

  constructor(name: string, clock: () => number, drives: Record<string, FakeRemoteDriveStore>) {
    this.notes = new NoteStore(new MemoryNodeBackend(), clock);
    this.targets = Object.entries(drives).map(([driveId, remote]) => ({
      driveId,
      remote,
      metadata: new InMemorySyncMetadataStore(),
      base: new InMemoryBaseContentStore(),
    }));
    this.sync = new MultiDriveSync(this.notes, name, undefined, clock);
  }

  async run() {
    const result = await this.sync.sync(this.targets);
    for (const o of result.outcomes) expect(o.result?.errors ?? o.error).toEqual([]);
    return result;
  }

  async tree(): Promise<Record<string, string>> {
    const tree: Record<string, string> = {};
    for (const e of await this.notes.listAll()) if (!e.isFolder) tree[e.path] = await this.notes.read(e.path);
    return tree;
  }
}

// A full sync through the real shared core: two devices, two drives, edits, a conflict and its merge-back.
describe('sync integration', () => {
  it('two devices converge through two drives, including a conflict merged back', async () => {
    let now = 1000;
    const clock = () => now;
    const drives = { proton: new FakeRemoteDriveStore(), dropbox: new FakeRemoteDriveStore() };
    const laptop = new Device('laptop', clock, drives);
    const desktop = new Device('desktop', clock, drives);

    await laptop.notes.write('Work/plan.md', '---\nid: abcd1234\n---\n# Plan\none\ntwo\nthree\n');
    await laptop.notes.writeBytes(`attachments/${'a'.repeat(64)}.png`, utf8.encode('png bytes'));
    await laptop.run();
    await desktop.run();
    expect(await desktop.tree()).toEqual(await laptop.tree());

    // Non-overlapping edits merge; overlapping ones keep the newest and save a copy.
    now = 2000;
    await laptop.notes.write('Work/plan.md', '---\nid: abcd1234\n---\n# Plan\nONE\ntwo\nthree laptop\n');
    now = 3000;
    await desktop.notes.write('Work/plan.md', '---\nid: abcd1234\n---\n# Plan\none\ntwo\nthree desktop\n');
    await desktop.run();
    const { conflicts } = await laptop.run();

    expect(conflicts).toHaveLength(1);
    const [conflict] = conflicts;
    expect(conflict).toMatchObject({ path: 'Work/plan.md', copyPath: 'Work/plan (conflicted copy).md' });
    expect(conflict.winner).toBe('remote');
    const copy = await laptop.notes.read(conflict.copyPath);
    expect(readId(copy)).not.toBe('abcd1234');
    expect(copy).toContain('three laptop');

    await desktop.run();
    expect(await desktop.tree()).toEqual(await laptop.tree());

    // The laptop merges the copy back: the note keeps its id and the copy disappears everywhere.
    const mergeBack = new ConflictMergeBack(laptop.notes);
    const merge = await mergeBack.merge(conflict);
    expect(merge.conflicts).toBe(1);
    now = 4000;
    await mergeBack.apply(conflict, '---\nid: abcd1234\n---\n# Plan\nONE\ntwo\nthree desktop and laptop\n');
    await laptop.run();
    await desktop.run();

    const expected = {
      'Work/plan.md': '---\nid: abcd1234\n---\n# Plan\nONE\ntwo\nthree desktop and laptop\n',
      [`attachments/${'a'.repeat(64)}.png`]: 'png bytes',
    };
    expect(await laptop.tree()).toEqual(expected);
    expect(await desktop.tree()).toEqual(expected);
    for (const drive of Object.values(drives)) {
      expect(drive.exists('Work/plan (conflicted copy).md')).toBe(false);
      const manifest = parseManifest(utf8.decode(drive.manifest!))!;
      expect(Object.keys(manifest.files).sort()).toEqual(Object.keys(expected).sort());
    }
  });
});
