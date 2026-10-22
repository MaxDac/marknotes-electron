# Note format

MarkNotes Desktop, the Android app ([MaxDac/MarkNotes](https://github.com/MaxDac/MarkNotes)) and marknotes-web share
the same folder of files on every linked drive. This document describes the parts of that format beyond plain
markdown, so all three apps read and write compatible files.

## Note ids (front-matter)

Every note is a `.md` file. Its stable id lives in a YAML front-matter block at the very top of the file:

```markdown
---
id: k7f3q2xa
---

# My note
```

- The id is 8 random characters from the alphabet `0123456789abcdefghjkmnpqrstvwxyz` (Crockford base32, lowercase,
  without `i`, `l`, `o`, `u`).
- An id is assigned when a note is created. Notes without an id (written before this feature, or by other tools)
  get one lazily the first time they are opened in the editor or listed in the `@` popup. The id is written back
  through the normal save path, so it syncs like any other edit.
- Any other front-matter keys are preserved verbatim. When the id is added it becomes the first key.
- The front-matter is hidden in the editor and in the preview: the user edits only the body and the header is
  re-attached on save.
- Duplicate ids (for example a copied file) resolve to the first note by sorted path. When an app detects a duplicate
  locally it assigns a new id to the later note.

## Note links

A link to another note uses the `marknotes:` scheme with the target id:

```markdown
[Roadmap](marknotes:k7f3q2xa)
```

The link text is the note title at the time the link was inserted. In the preview, clicking the link opens the note
with that id, wherever it has been moved or renamed. Links to an id that no note has are styled as broken and show
"Note not found".

In the editor, typing `@` at the start of a line or after whitespace opens a popup listing every note with its title,
full path (`folder/subfolder/title`) and id (with a copy button). Text typed after `@` filters by id prefix or by a
case-insensitive substring of the title or path. Enter or a click inserts the link in place of `@query`.

## Images

Images are stored in the `attachments/` folder at the root of the notes folder:

```
attachments/<sha256-hex>.<ext>
```

- `<sha256-hex>` is the lowercase SHA-256 of the final file bytes; `<ext>` is `png`, `jpg`, `gif` or `webp`. No other
  types are accepted.
- Images are downscaled so the longest side is at most 2048 px, keeping their format. GIFs are stored unchanged.
  Images larger than 10 MB after processing are rejected.
- A note embeds an image with:

  ```markdown
  ![original file name without extension](attachments/<sha256-hex>.<ext>)
  ```

  The path is always resolved from the root of the notes folder, whatever folder the note is in.

- `attachments/` is hidden from the note tree, and no folder named `attachments` can be created at the root.
- **Settings → Clean unused images** scans every note for `attachments/...` references and deletes the image files
  no note references. It never runs automatically.

## Attachment sync

Files under `attachments/` are synced to every linked drive (Proton Drive, Dropbox, OneDrive) like notes:

- they are listed in `.marknotes/manifest.json` with their `sha256`, and the manifest stays `format: 1`;
- they are binary and immutable (the name is the hash), so they are only uploaded, downloaded and deleted. They are
  never three-way merged and never produce a conflict;
- deletions propagate like note deletions;
- files in `attachments/` that do not match the `<sha256-hex>.<ext>` pattern are ignored.
