import {
  buildManifest,
  conflictCopyName,
  localDeletions,
  merge3,
  mergeText,
  parseManifest,
  plan,
  reconcile,
  serializeManifest,
  SyncScheduler,
  type ConflictChoice,
} from '@marknotes/sync';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachmentRefs,
  extensionForType,
  imageMarkdown,
  isAttachmentPath,
  scaledSize,
} from '../src/shared/attachments';
import {
  chordDisplayNames,
  isChordSequence,
  parseChordBody,
  serializeChordBody,
  validateChordSequence,
  type Chord,
  type ChordSequence,
} from '../src/shared/chords';
import { isNoteId, joinFrontMatter, noteIdOf, splitFrontMatter, withNoteId } from '../src/shared/frontMatter';

import { buildNoteIndex, filterNotes, findMention, noteIdFromHref, noteLink } from '../src/shared/noteLinks';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import { executorSafety } from './executorSafety';

/**
 * Runs the shared marknotes-spec golden fixtures (git submodule at spec/) against the desktop implementation.
 * See spec/README.md, "How apps consume this repository". The sync, manifest and merge fixtures run against the
 * shared sync core (`@marknotes/sync`), which the desktop sync engine calls.
 */

const APP = 'desktop';
const FIXTURES = join(import.meta.dirname, '..', 'spec', 'fixtures');

interface FixtureCase {
  name: string;
  input: Record<string, unknown>;
  expected: unknown;
  knownDivergence?: Partial<Record<'android' | 'desktop' | 'web', string>>;
}

interface FixtureFile {
  description: string;
  cases: FixtureCase[];
}

// Fixture inputs are untyped JSON; each runner reads the fields its fixture file documents.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Runner = (input: any) => unknown;

const newStore = () => new NoteStore(new MemoryNodeBackend());

/** Maps every fixture file (its path under fixtures/, without .json) to the desktop code it exercises. */
const runners: Record<string, Runner> = {
  'note-ids/validation': ({ value }) => ({ valid: isNoteId(value) }),

  'front-matter/read-id': ({ text }) => ({ id: noteIdOf(text) }),
  'front-matter/with-id': ({ text, id }) => ({ text: withNoteId(text, id) }),
  'front-matter/split': ({ text }) => {
    const { frontMatter, body } = splitFrontMatter(text);
    return { frontMatter, body };
  },
  'front-matter/with-body': ({ frontMatter, body }) => ({ text: joinFrontMatter(frontMatter, body) }),

  'note-links/link-markdown': ({ title, id }) => ({ markdown: noteLink(title, id) }),
  'note-links/parse-href': ({ href }) => ({ id: noteIdFromHref(href) }),
  'note-links/mention': ({ lineBeforeCursor }) => ({ mention: findMention(lineBeforeCursor, 0) }),
  'note-links/filter': ({ query, notes }) => {
    const index = (notes as { id: string; title: string; fullPath: string }[]).map((n) => ({
      ...n,
      path: `${n.fullPath}.md`,
    }));
    return { ids: filterNotes(index, query).map((n) => n.id) };
  },

  'attachments/extension-for-type': ({ mime }) => ({ extension: extensionForType(mime) }),
  'attachments/is-attachment-path': ({ path }) => ({ isAttachment: isAttachmentPath(path) }),
  'attachments/image-markdown': ({ fileName, path }) => ({ markdown: imageMarkdown(fileName, path) }),
  'attachments/scaled-size': ({ width, height }) => scaledSize(width, height),
  'attachments/refs': ({ text }) => ({ refs: [...attachmentRefs(text)].sort() }),

  'manifest/parse': ({ json }) => ({ manifest: parseManifest(json) }),
  'manifest/serialize': (manifest) => ({ json: serializeManifest(manifest) }),
  'manifest/build': ({ records, deviceId, nowMillis, previous }) => ({
    json: buildManifest(records, deviceId, nowMillis, previous) ?? null,
  }),
  // The note index gives later duplicates (by sorted path) a new id and saves them.
  'duplicate-ids/resolve': async ({ notes }) => {
    const store = newStore();
    const list = notes as { path: string; id: string }[];
    for (const n of list) await store.write(n.path, `---\nid: ${n.id}\n---\nBody\n`);
    await buildNoteIndex(store, { assign: true });
    const reassigned: string[] = [];
    for (const n of list) if (noteIdOf(await store.read(n.path)) !== n.id) reassigned.push(n.path);
    return { reassigned: reassigned.sort() };
  },

  'chords/detect': ({ text }) => ({ chords: isChordSequence(text) }),
  'chords/parse': ({ body }) => parseChordBody(body),
  'chords/serialize': ({ sequence, lineEnding }) => ({
    body: serializeChordBody(sequence as ChordSequence, lineEnding),
  }),
  'chords/validate': ({ sequence }) => ({ errors: validateChordSequence(sequence as ChordSequence) }),
  'chords/display-names': ({ chords }) => ({ displayNames: chordDisplayNames(chords as Chord[]) }),

  'merge/merge3': ({ base, local, remote, choices }) => {
    const result = merge3(base, local, remote);
    const text = choices ? mergeText(result.chunks, choices as Record<number, ConflictChoice>) : result.text;
    return { text, conflicts: result.conflicts };
  },
  'merge/conflict-copy-name': ({ path, existingPaths }) => ({
    path: conflictCopyName(path, existingPaths ?? []),
  }),

  'sync/plan': (input) => plan(input),
  'sync/reconcile': (input) => reconcile(input),
  'sync/executor-safety': executorSafety,
  'sync/local-deletions': ({ local, records }) => ({ paths: localDeletions(local, records) }),
  'sync/multi-drive': ({ driveIds, maxPasses, reports }) => {
    const scheduler = new SyncScheduler(driveIds, maxPasses);
    const order: string[] = [];
    try {
      for (let id = scheduler.next(); id !== undefined; id = scheduler.next()) {
        const report = (reports as { localChanges: number; failed: boolean }[])[order.length];
        scheduler.report(id, report.localChanges, report.failed);
        order.push(id);
      }
    } finally {
      scheduler.free();
    }
    return { order };
  },
};

/**
 * Cases failing for a reason the spec does not record yet, by fixture file and case name.
 * TODO: remove each entry once the spec (or the app) is fixed.
 */
const pendingSpecFixes: Record<string, Record<string, string>> = {};

function fixtureFiles(): string[] {
  if (!existsSync(FIXTURES)) {
    throw new Error(`${FIXTURES} not found: run "git submodule update --init" to fetch marknotes-spec.`);
  }
  return readdirSync(FIXTURES, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replaceAll('\\', '/').replace(/\.json$/, ''))
    .sort();
}

const files = fixtureFiles();
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('marknotes-spec fixtures', () => {
  it('maps every fixture file to a desktop runner', () => {
    expect(
      files.filter((f) => !(f in runners)),
      'fixture files without a runner',
    ).toEqual([]);
    expect(
      Object.keys(runners).filter((f) => !files.includes(f)),
      'runners without a fixture file',
    ).toEqual([]);
  });

  describe.each(files.filter((f) => f in runners))('%s', (file) => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, `${file}.json`), 'utf8')) as FixtureFile;
    const run = runners[file];

    for (const c of fixture.cases) {
      const divergence = c.knownDivergence?.[APP];
      const pending = pendingSpecFixes[file]?.[c.name];
      if (pending) {
        it.skip(`${c.name} (pending spec fix: ${pending})`, () => {});
      } else if (divergence) {
        // A known divergence must still differ, so a fix is noticed and the spec entry removed.
        it(`${c.name} (known divergence: ${divergence})`, async () => {
          expect(plain(await run(c.input))).not.toStrictEqual(c.expected);
        });
      } else {
        it(c.name, async () => {
          expect(plain(await run(c.input))).toStrictEqual(c.expected);
        });
      }
    }
  });
});
