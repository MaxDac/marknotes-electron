import { merge3, readId, withId, type MergeResult } from '@marknotes/sync';
import type { NoteStore } from './noteStore';
import type { SyncConflict } from './syncEngine';

/**
 * Merges a conflicted copy back into its note. Everything happens in the local tree: the next sync uploads the merged
 * note and deletes the copy on every drive.
 */
export class ConflictMergeBack {
  constructor(private readonly local: NoteStore) {}

  /** True while both the note and its conflicted copy still exist. */
  async isPending(conflict: SyncConflict): Promise<boolean> {
    return (await this.local.exists(conflict.path)) && (await this.local.exists(conflict.copyPath));
  }

  /**
   * Three-way merge of the base, the note ("local" side) and the copy ("remote" side). The copy's new id is replaced
   * by the note's id first, so that the merge keeps the note's identity.
   */
  async merge(conflict: SyncConflict): Promise<MergeResult> {
    const note = await this.local.read(conflict.path);
    const copy = await this.local.read(conflict.copyPath);
    const id = readId(note);
    const aligned = id !== undefined && readId(copy) !== undefined ? withId(copy, id) : copy;
    return merge3(conflict.baseText, note, aligned);
  }

  /** Saves `text` as the note and deletes the copy. */
  async apply(conflict: SyncConflict, text: string): Promise<void> {
    await this.local.write(conflict.path, text);
    await this.discardCopy(conflict);
  }

  /** Deletes the conflicted copy, keeping the note as it is. */
  async discardCopy(conflict: SyncConflict): Promise<void> {
    await this.local.delete(conflict.copyPath);
  }
}
