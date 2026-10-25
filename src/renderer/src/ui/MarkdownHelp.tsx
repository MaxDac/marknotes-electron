import { renderMarkdown } from './markdown';
import { MARKDOWN_EXAMPLES } from './markdownHelpExamples';

export function MarkdownHelp() {
  return (
    <article className="markdown-help" aria-labelledby="markdown-help-title">
      <h2 id="markdown-help-title">What is Markdown?</h2>
      <p>
        Markdown is plain text with small formatting markers. Your notes stay readable as .md files. Edit
        shows the source, Preview shows the result, and Split shows both. Changes to real notes autosave on
        this device; syncing to a drive is a separate operation.
      </p>
      <h3>Supported syntax</h3>
      <p>
        Paragraphs, headings, bold, italic, lists (including nested lists), quotes, links, images, inline
        code, fenced or indented code blocks and horizontal rules are supported. Tables, strikethrough and
        task lists are supported too. Bare web URLs automatically become links on Desktop. Task checkboxes in
        Preview are read-only: change [ ] to [x] in the source.
      </p>
      <p>
        The toolbar provides bold, italic, strikethrough, headings, lists, checkboxes, quotes, code, links and
        image insertion. Its Heading button cycles H1, H2 and H3; type ####, ##### or ###### followed by a
        space for H4, H5 or H6. Tables and horizontal rules are typed manually.
      </p>
      {MARKDOWN_EXAMPLES.map((example) => (
        <section key={example.title} className="help-example">
          <h3>{example.title}</h3>
          <pre aria-label={`${example.title} Markdown source`}>
            <code>{example.source}</code>
          </pre>
          <div
            className="preview"
            aria-label={`${example.title} rendered example`}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(example.source) }}
            onAuxClick={(event) => event.preventDefault()}
            onContextMenu={(event) => event.preventDefault()}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('a')) event.preventDefault();
            }}
          />
        </section>
      ))}
      <h3>Code highlighting and limits</h3>
      <p>
        Fenced code blocks can name a language, such as js. Preview highlights languages included in
        highlight.js common; unknown or omitted languages remain plain code. Editor syntax colouring may
        recognise more languages than Preview. This is not full GitHub-flavoured Markdown: embedded raw HTML
        is escaped, and math, Mermaid diagrams, footnotes and emoji shortcodes have no special renderer.
        Ordinary line breaks belong to the same paragraph; use a blank line for a new paragraph or two
        trailing spaces for a hard line break.
      </p>
      <h3>MarkNotes features, separate from Markdown</h3>
      <p>
        Type @ in a real note to choose another note by title, path or ID. It inserts a stable
        <code> [Title](marknotes:&lt;id&gt;)</code> link; Preview opens the note or marks a missing target.
        MarkNotes manages the hidden ID header for you.
      </p>
      <p>
        Insert images with the image button, paste or drop PNG, JPEG, GIF or WebP images. They are stored in
        the attachments folder and synced with your notes. PNG, JPEG and WebP images are resized to at most
        2048 pixels; GIFs are kept unchanged. The Markdown is{' '}
        <code>![Description](attachments/&lt;hash&gt;.png)</code>. Arbitrary relative, file, HTTP and
        protocol-relative image sources are not loaded.
      </p>
      <p>
        HTTPS images from the web stay blocked until you choose Load remote images for that note in the
        current session. Loading them contacts the remote server. Help examples never fetch remote images or
        open websites.
      </p>
      <p>
        Chord sequences are an optional MarkNotes feature, off by default in Settings. Their special front
        matter opens a chord editor; View as text shows the Markdown. They are not a general Markdown
        extension.
      </p>
    </article>
  );
}
