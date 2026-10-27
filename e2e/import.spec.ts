import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { expect, test, type LaunchedApp } from './fixtures';
import type * as Converters from './importConverters';
import { docx, docxImage, importPdf, importPng, p, zip } from './importFixtures';

declare global {
  var MarkNotesImport: typeof Converters;
}

async function withApp(launch: () => Promise<LaunchedApp>, run: (page: Page) => Promise<void>) {
  const { page } = await launch();
  await run(page);
}

/** The converters bundled as a script, to run them where DOMParser and DecompressionStream exist. */
async function converters(): Promise<string> {
  const output = (await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('importConverters.ts', import.meta.url)),
        formats: ['iife'],
        name: 'MarkNotesImport',
      },
    },
  })) as Rolldown.RolldownOutput[];
  return `${output[0].output[0].code}\nglobalThis.MarkNotesImport = MarkNotesImport;`;
}

const html = (page: Page, source: string) => page.evaluate((s) => MarkNotesImport.htmlToMarkdown(s), source);

const word = (page: Page, bytes: Buffer, plain = false) =>
  page.evaluate(
    async ([data, plain]) => {
      const saved: number[][] = [];
      try {
        const bytes = new Uint8Array(data);
        const markdown = plain
          ? await MarkNotesImport.docxToPlainText(bytes)
          : await MarkNotesImport.docxToMarkdown(bytes, async (image, extension) => {
              saved.push([...image]);
              return `attachments/hash.${extension}`;
            });
        return { markdown, saved };
      } catch (e) {
        return { error: e instanceof MarkNotesImport.ImportError ? 'ImportError' : String(e) };
      }
    },
    [[...bytes], plain] as const,
  );

// Android's HtmlToMarkdownTest, DocxToMarkdownTest and the HTML case of ImportConverterTest, in the renderer.
test('converts HTML and Word documents like the Android app', async ({ launch }) => {
  const script = await converters();
  await withApp(launch, async (page) => {
    await page.evaluate(script);

    expect(
      await html(
        page,
        '<h1>Title</h1><p>Some <b>bold</b>, <em>italic</em>, <del>gone</del> and <code>a_b</code>.</p>' +
          '<h3>Sub <i>part</i></h3>',
      ),
    ).toBe('# Title\n\nSome **bold**, *italic*, ~~gone~~ and `a_b`.\n\n### Sub *part*\n');
    expect(await html(page, '<p>a<b> bold </b>b</p>')).toBe('a **bold** b\n');
    expect(
      await html(
        page,
        '<p><a href="https://example.com/a b">Example</a> <a href="https://x.io">https://x.io</a> ' +
          '<img src="https://img.io/p.png" alt="Pic"><img src="data:image/png;base64,AAAA" alt="inline"></p>',
      ),
    ).toBe('[Example](https://example.com/a%20b) <https://x.io> [Pic](https://img.io/p.png)\n');
    expect(await html(page, '<a href="javascript:alert(1)">a</a>')).toBe('a\n');
    expect(
      await html(
        page,
        '<ul><li>One<ul><li>Nested</li></ul></li><li><p>Two</p></li></ul>' +
          '<ol start="3"><li>Three</li><li><input type="checkbox" checked> Done</li></ol>',
      ),
    ).toBe('- One\n  - Nested\n- Two\n\n3. Three\n4. [x] Done\n');
    expect(
      await html(
        page,
        '<blockquote><p>Quoted</p><p>Again</p></blockquote><hr>' +
          '<pre><code class="language-kotlin">val x = 1\n  println(x)</code></pre>',
      ),
    ).toBe('> Quoted\n>\n> Again\n\n---\n\n```kotlin\nval x = 1\n  println(x)\n```\n');
    expect(
      await html(
        page,
        '<table><tr><th>Name</th><th>Qty</th></tr><tr><td>A|B</td><td><p>2</p></td></tr></table>',
      ),
    ).toBe('| Name | Qty |\n| --- | --- |\n| A\\|B | 2 |\n');
    expect(await html(page, '<table><tr><td><h2>Newsletter</h2><p>Hello</p></td></tr></table>')).toBe(
      '## Newsletter\n\nHello\n',
    );
    expect(await html(page, '<p>Line one<br>Line two<br><br>Next</p>')).toBe(
      'Line one\\\nLine two\n\nNext\n',
    );
    expect(await html(page, '<p># not a heading *x* [y]</p>')).toBe('\\# not a heading \\*x\\* \\[y\\]\n');
    expect(await html(page, '<p>1. Not a list</p>')).toBe('1\\. Not a list\n');
    expect(
      await html(
        page,
        '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">' +
          '<h2><span style="font-weight:400">Plan</span></h2>' +
          '<p><span style="font-weight:700">Bold</span><span> and </span>' +
          '<span style="font-style:italic">italic</span></p></b>',
      ),
    ).toBe('## Plan\n\n**Bold** and *italic*\n');
    expect(await html(page, '<style>p{}</style><script>alert(1)</script><p>Text</p>')).toBe('Text\n');
    expect(
      await page.evaluate(() =>
        MarkNotesImport.htmlToPlainText(
          '<h1>Title</h1><p>Some <b>bold</b> <a href="https://x.io">link</a></p><ul><li>a</li></ul>',
        ),
      ),
    ).toBe('Title\n\nSome bold link\n\n- a\n');
    expect(
      await page.evaluate(async () => {
        const convert = (text: string | undefined, autoFormat: boolean) =>
          MarkNotesImport.convertImport(
            { kind: 'html', html: '<p><b>Hi</b></p>', text },
            autoFormat,
            async () => null,
          );
        return [
          await convert('Hi there', false),
          await convert('Hi there', true),
          await convert(undefined, false),
        ];
      }),
    ).toEqual(['Hi there\n', '**Hi**\n', 'Hi\n']);

    const structure =
      p('Report', 'Heading1') +
      p('Section', 'Titre2') +
      p('Derived', 'MyHeading') +
      p('Apple', undefined, [1, 0]) +
      p('Green', undefined, [1, 1]) +
      p('Step', undefined, [2, 0]) +
      p('Step', undefined, [2, 0]) +
      p('Wise words', 'Quote') +
      p('val x = 1', 'Code') +
      p('x * 2', 'Code') +
      p('End');
    expect((await word(page, docx(structure))).markdown).toBe(
      '# Report\n\n## Section\n\n# Derived\n\n- Apple\n    - Green\n1. Step\n2. Step\n\n> Wise words\n\n' +
        '```\nval x = 1\nx * 2\n```\n\nEnd\n',
    );
    const runs =
      '<w:p>' +
      '<w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve"> and </w:t></w:r>' +
      '<w:r><w:rPr><w:i/><w:b w:val="0"/></w:rPr><w:t>italic</w:t></w:r>' +
      '<w:r><w:rPr><w:strike/></w:rPr><w:t xml:space="preserve"> old</w:t></w:r>' +
      '<w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:r>' +
      '<w:r><w:br/><w:t>2*3 </w:t></w:r>' +
      '<w:hyperlink r:id="rId1"><w:r><w:t>site</w:t></w:r></w:hyperlink>' +
      '<w:hyperlink w:anchor="x"><w:r><w:t> here</w:t></w:r></w:hyperlink>' +
      '</w:p>';
    expect((await word(page, docx(runs))).markdown).toBe(
      '**Bold** and *italic* ~~old~~\\\n2\\*3 [site](https://example.com) here\n',
    );
    const table =
      `<w:tbl><w:tr><w:tc>${p('Name')}</w:tc><w:tc>${p('Qty')}</w:tc></w:tr>` +
      `<w:tr><w:tc>${p('Pen')}</w:tc><w:tc>${p('2')}</w:tc></w:tr></w:tbl>`;
    expect(await word(page, docx(table + docxImage))).toEqual({
      markdown: '| Name | Qty |\n| --- | --- |\n| Pen | 2 |\n\n![image1](attachments/hash.png)\n',
      saved: [[1, 2, 3]],
    });
    expect((await word(page, docx(table + docxImage), true)).markdown).toBe('Name\tQty\nPen\t2\n');
    expect(
      (await word(page, docx(p('Report', 'Heading1') + p('Apple', undefined, [1, 0])), true)).markdown,
    ).toBe('Report\n\nApple\n');
    expect((await word(page, Buffer.from('not a zip'))).error).toBe('ImportError');
    expect((await word(page, zip({ 'other.txt': '' }))).error).toBe('ImportError');
    const evil = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`;
    expect((await word(page, docx('', undefined, { 'word/document.xml': evil }))).error).toBe('ImportError');
  });
});

const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Import note' });

async function openImport(page: Page) {
  await page.getByRole('button', { name: 'Import…', exact: true }).click();
  return dialogOf(page);
}

test('imports typed and pasted text with a title, a folder and optional formatting', async ({ launch }) => {
  test.slow();
  await withApp(launch, async (page) => {
    await page.getByRole('button', { name: 'New folder' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Imports');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    let dialog = await openImport(page);
    await dialog.getByLabel('Text').fill('Shopping\n\n\u2022 Milk\n\u2022 Bread');
    await dialog.getByRole('button', { name: 'Next' }).click();
    const preview = dialog.getByTestId('markdown-preview');
    await expect(preview.locator('li')).toHaveText(['Milk', 'Bread']);
    await expect(dialog.getByLabel('Title')).toHaveValue('Shopping');
    const autoFormat = dialog.getByRole('switch', { name: /Auto-format as Markdown/ });
    await autoFormat.uncheck();
    await expect(preview.locator('li')).toHaveCount(0);
    await dialog.getByRole('radio', { name: 'Markdown' }).click();
    await expect(dialog.getByTestId('import-source')).toHaveText('Shopping\n\n\u2022 Milk\n\u2022 Bread\n');
    await autoFormat.check();
    await expect(dialog.getByTestId('import-source')).toHaveText('# Shopping\n\n- Milk\n- Bread\n');
    await dialog.getByLabel('Title').fill('Groceries');
    await dialog.getByLabel('Folder').selectOption('Imports');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('note-title')).toHaveText('Groceries');
    await expect(page.getByTestId('editor-field')).toContainText('- Milk');

    // HTML pasted into the empty text box is converted, and an existing name gets a number.
    dialog = await openImport(page);
    await dialog.getByLabel('Text').evaluate((element) => {
      const data = new DataTransfer();
      data.setData(
        'text/html',
        '<h1>Groceries</h1><p><strong>Eggs</strong> too</p><script>alert(1)</script>',
      );
      data.setData('text/plain', 'Groceries\nEggs too');
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await expect(dialog.getByTestId('markdown-preview').locator('strong')).toHaveText('Eggs');
    await expect(dialog.getByTestId('markdown-preview')).not.toContainText('alert');
    await expect(dialog.getByLabel('Folder')).toHaveValue('Imports');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('note-title')).toHaveText('Groceries 2');
    await expect(page.getByTestId('editor-field')).toContainText('**Eggs** too');

    // Cancelling writes nothing.
    dialog = await openImport(page);
    await dialog.getByLabel('Files').setInputFiles({
      name: 'article.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<h1>Article</h1><p>Body</p>'),
    });
    await expect(dialog.getByTestId('markdown-preview').locator('h1')).toHaveText('Article');
    await expect(dialog.getByLabel('Title')).toHaveValue('Article');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    // The tree also lists the Imports folder, so count notes only.
    await expect(page.locator('[data-testid="entry"][data-kind]')).toHaveCount(2);
    await expect(page.getByTestId('entry').filter({ hasText: 'Groceries 2' })).toHaveCount(1);
  });
});

test('imports dropped Markdown as it is and reports unsupported files', async ({ launch }) => {
  test.slow();
  await withApp(launch, async (page) => {
    await page.locator('.topbar').evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(['# Dropped\n\n**Kept Markdown**\n'], 'source.md', { type: 'text/markdown' }),
      );
      element.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    const dialog = dialogOf(page);
    await expect(dialog.getByTestId('markdown-preview').locator('strong')).toHaveText('Kept Markdown');
    await expect(dialog.getByRole('switch', { name: /Auto-format as Markdown/ })).toBeDisabled();
    await expect(dialog.getByLabel('Title')).toHaveValue('Dropped');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('note-title')).toHaveText('Dropped');
    await expect(page.getByTestId('editor-field')).toContainText('**Kept Markdown**');

    await openImport(page);
    await dialog.getByLabel('Files').setInputFiles({
      name: 'archive.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('invalid'),
    });
    await expect(dialog.getByRole('alert')).toHaveText(
      'MarkNotes can import text, HTML, Markdown, Word (.docx) and PDF files.',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByTestId('entry')).toHaveCount(1);
  });
});

test('imports Word images as attachments, PDF text and images, and reports unreadable PDFs', async ({
  launch,
}) => {
  test.slow();
  await withApp(launch, async (page) => {
    let dialog = await openImport(page);
    await dialog.getByLabel('Files').setInputFiles({
      name: 'Word.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: docx(p('Word document', 'Heading1') + p('Body text') + docxImage, importPng),
    });
    const preview = dialog.getByTestId('markdown-preview');
    await expect(preview.locator('h1')).toHaveText('Word document');
    const image = preview.locator('img[data-attachment]');
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await expect(dialog.getByLabel('Title')).toHaveValue('Word document');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('note-title')).toHaveText('Word document');
    await expect(page.getByTestId('editor-field')).toContainText(
      /!\[image1\]\(attachments\/[0-9a-f]{64}\.png\)/,
    );
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect
      .poll(() =>
        page
          .getByTestId('markdown-preview')
          .locator('img[data-attachment]')
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(1);

    dialog = await openImport(page);
    await dialog
      .getByLabel('Files')
      .setInputFiles({ name: 'Report.pdf', mimeType: 'application/pdf', buffer: importPdf() });
    await expect(dialog.getByTestId('markdown-preview')).toContainText('PDF imported text.');
    await expect(dialog.getByLabel('Title')).toHaveValue('Report');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('note-title')).toHaveText('Report');

    dialog = await openImport(page);
    await dialog
      .getByLabel('Files')
      .setInputFiles({ name: 'Scan.pdf', mimeType: 'application/pdf', buffer: importPdf(false) });
    await expect(dialog.getByRole('alert')).toHaveText(
      'This PDF has no text to import (it may be a scanned image).',
    );
    await dialog
      .getByLabel('Files')
      .setInputFiles({ name: 'Broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
    await expect(dialog.getByRole('alert')).toContainText('Could not read the PDF');
    await dialog
      .getByLabel('Files')
      .setInputFiles({ name: 'Pixel.png', mimeType: 'image/png', buffer: importPng });
    await expect(dialog.getByTestId('markdown-preview').locator('img[data-attachment]')).toBeVisible();
    await expect(dialog.getByRole('switch', { name: /Auto-format as Markdown/ })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByTestId('entry')).toHaveText([/Report/, /Word document/]);
  });
});
