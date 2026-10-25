import { describe, expect, it } from 'vitest';
import { isRemoteImage, renderMarkdown } from '../src/renderer/src/ui/markdown';
import { MARKDOWN_EXAMPLES } from '../src/renderer/src/ui/markdownHelpExamples';

const img = (src: string) => renderMarkdown(`![alt](${src})`);

describe('offline help coverage', () => {
  it('renders every bundled example with the unchanged note renderer', () => {
    for (const example of MARKDOWN_EXAMPLES) {
      expect(renderMarkdown(example.source)).toMatch(/<(p|h1|ul|pre|table)>/);
    }
    expect(renderMarkdown(MARKDOWN_EXAMPLES[0].source)).toContain('<h6>Heading 6</h6>');
    expect(renderMarkdown(MARKDOWN_EXAMPLES[3].source)).toContain('type="checkbox" disabled checked');
    expect(renderMarkdown(MARKDOWN_EXAMPLES[5].source)).toContain('<table>');
    expect(renderMarkdown('~~removed~~')).toContain('<s>removed</s>');
    expect(renderMarkdown('https://example.com')).toContain('href="https://example.com"');
  });

  it('does not promise HTML, math, Mermaid or unlimited highlighting', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toContain('&lt;script&gt;');
    expect(renderMarkdown('$$x$$')).not.toContain('katex');
    expect(renderMarkdown('```mermaid\ngraph TD; A-->B\n```')).not.toContain('<svg');
    expect(renderMarkdown('```not-a-language\n<example>\n```')).toContain('&lt;example&gt;');
    expect(renderMarkdown('- [x] done')).not.toMatch(/<input(?![^>]*disabled)/);
  });
});

describe('markdown images', () => {
  it('keeps web images unloaded until the user asks for them', () => {
    const html = img('https://example.com/pixel.png');
    expect(html).toContain('src=""');
    expect(html).toContain('data-remote-src="https://example.com/pixel.png"');
    expect(html).toContain('class="remote"');
  });

  it('drops non-https and protocol-relative images', () => {
    for (const src of [
      'http://example.com/a.png',
      '//example.com/a.png',
      '\\\\server\\share\\a.png',
      'a.png',
    ]) {
      const html = img(src);
      expect(html).not.toContain('data-remote-src');
      expect(html).not.toMatch(/src="[^"]/);
    }
  });

  it('loads attachments from the note store', () => {
    const html = img(`attachments/${'a'.repeat(64)}.png`);
    expect(html).toContain('data-attachment=');
    expect(html).toContain('src=""');
    expect(html).not.toContain('data-remote-src');
  });

  it('accepts only absolute https URLs as remote images', () => {
    expect(isRemoteImage('https://example.com/a.png')).toBe(true);
    expect(isRemoteImage('HTTPS://example.com/a.png')).toBe(true);
    expect(isRemoteImage('https:///a.png')).toBe(false);
    expect(isRemoteImage('https:\\\\server')).toBe(false);
    expect(isRemoteImage('http://example.com/a.png')).toBe(false);
    expect(isRemoteImage('//example.com/a.png')).toBe(false);
    expect(isRemoteImage('javascript:alert(1)')).toBe(false);
  });
});
