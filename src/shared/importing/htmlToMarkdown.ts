/**
 * Converts HTML (rich text shared by browsers, mail and office apps, or `.html` files) to Markdown.
 * Images are not downloaded: `<img>` with a web address becomes a link to it, inline data images are dropped.
 * Mirrors Android's `core/importing/HtmlToMarkdown.kt`; parsing uses the inert `DOMParser` (no scripts run and
 * nothing is loaded).
 */
import {
  codeSpan,
  escapeInline,
  escapeLineStart,
  fence,
  HARD_BREAK,
  indentContinuation,
  isBlank,
  link,
  table as markdownTable,
  tidy,
  wrap,
} from './markdownText';

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'center',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'ul',
]);
const BLOCK_SELECTOR = [...BLOCK_TAGS].join(', ');
const LAYOUT_SELECTOR = 'table, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6';
const REMOVED = 'script, style, noscript, template, head, title, meta, link, svg, iframe, object';
const LINK_SCHEMES = ['http://', 'https://', 'mailto:', 'ftp://', 'tel:'];
const WHITESPACE = /[ \t\n\v\f\r\u200B]+/g;
const SPACES = / {2,}/g;
const BOLD = /font-weight\s*:\s*(bold|bolder|[6-9]00)/;
const NOT_BOLD = /font-weight\s*:\s*(normal|lighter|[1-5]00)/;
const ITALIC = /font-style\s*:\s*(italic|oblique)/;
const STRIKE = /text-decoration[a-z-]*\s*:[^;]*line-through/;
const MONOSPACE = /font-family\s*:[^;]*(monospace|courier|consolas|menlo|monaco)/;

export function htmlToMarkdown(html: string): string {
  return render(html, false);
}

/** The readable text of `html`: block structure and list markers are kept, formatting and links aren't. */
export function htmlToPlainText(html: string): string {
  return render(html, true);
}

function render(html: string, plain: boolean): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(REMOVED).forEach((el) => el.remove());
  const text = doc.body ? new HtmlRenderer(plain).blocks(doc.body) : '';
  return tidy(plain ? text.replaceAll(HARD_BREAK, '\n') : text);
}

interface Part {
  text: string;
  isList: boolean;
}

interface Style {
  bold: boolean;
  italic: boolean;
  strike: boolean;
}

const NO_STYLE: Style = { bold: false, italic: false, strike: false };
const tag = (el: Element) => el.localName;
const attr = (el: Element, name: string) => el.getAttribute(name) ?? '';
const collapse = (text: string) => text.replaceAll('\u00A0', ' ').replace(WHITESPACE, ' ');
const singleLine = (text: string) =>
  text.replaceAll(HARD_BREAK, ' ').replaceAll('\n', ' ').replace(SPACES, ' ').trim();

/** Text of all descendants, with `<br>` as a line break. */
function wholeText(node: Node): string {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
      out += (child as CharacterData).data;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      out += tag(child as Element) === 'br' ? '\n' : wholeText(child);
    }
  });
  return out;
}

/** Kotlin's `prependIndent`: blank lines shorter than the indent become the indent. */
function prependIndent(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => (isBlank(line) ? (line.length < indent.length ? indent : line) : indent + line))
    .join('\n');
}

class HtmlRenderer {
  constructor(private readonly plain: boolean) {}

  blocks(parent: Element): string {
    return this.parts(parent)
      .map((p) => p.text)
      .join('\n\n');
  }

  private parts(parent: Element): Part[] {
    const result: Part[] = [];
    let inline = '';
    const flush = () => {
      const text = this.paragraphs(inline);
      if (text !== null) result.push({ text, isList: false });
      inline = '';
    };
    parent.childNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (BLOCK_TAGS.has(tag(el)) || el.querySelector(BLOCK_SELECTOR) !== null) {
          flush();
          result.push(...this.block(el));
          return;
        }
      }
      inline += this.inline(node, NO_STYLE);
    });
    flush();
    return result;
  }

  private block(el: Element): Part[] {
    const name = tag(el);
    switch (name) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const text = singleLine(this.inlineChildren(el, NO_STYLE));
        if (text === '') return [];
        if (this.plain) return [{ text, isList: false }];
        return [{ text: `${'#'.repeat(Number(name[1]))} ${text}`, isList: false }];
      }
      case 'p':
        return this.optional(this.paragraphs(this.inlineChildren(el, NO_STYLE)), false);
      case 'ul':
      case 'ol': {
        const text = this.list(el);
        return isBlank(text) ? [] : [{ text, isList: true }];
      }
      case 'li':
        return [{ text: this.listItem(el, '- '), isList: true }];
      case 'dt':
        return this.optional(this.paragraphs(this.inlineChildren(el, { ...NO_STYLE, bold: true })), false);
      case 'blockquote': {
        const inner = this.blocks(el);
        if (isBlank(inner)) return [];
        if (this.plain) return [{ text: inner, isList: false }];
        const quoted = inner
          .split('\n')
          .map((l) => (isBlank(l) ? '>' : `> ${l}`))
          .join('\n');
        return [{ text: quoted, isList: false }];
      }
      case 'pre': {
        const code = wholeText(el).trimEnd().replace(/^\n+/, '');
        if (isBlank(code)) return [];
        if (this.plain) return [{ text: code, isList: false }];
        return [{ text: fence(code, this.language(el)), isList: false }];
      }
      case 'table':
        return this.table(el);
      case 'hr':
        return this.plain ? [] : [{ text: '---', isList: false }];
      default:
        return this.parts(el);
    }
  }

  private optional(text: string | null, isList: boolean): Part[] {
    return text === null ? [] : [{ text, isList }];
  }

  private list(el: Element): string {
    const ordered = tag(el) === 'ol';
    const start = attr(el, 'start').trim();
    let number = /^[+-]?\d{1,9}$/.test(start) ? parseInt(start, 10) : 1;
    const items: string[] = [];
    let lastMarkerWidth = 2;
    for (const child of Array.from(el.children)) {
      const name = tag(child);
      if (name === 'li') {
        const marker = ordered ? `${number}. ` : '- ';
        items.push(this.listItem(child, marker));
        lastMarkerWidth = marker.length;
        number++;
      } else if (name === 'ul' || name === 'ol') {
        // Invalid but common: a nested list directly inside the parent list.
        const nested = this.list(child);
        if (isBlank(nested)) continue;
        if (items.length === 0) items.push(nested);
        else items[items.length - 1] += `\n${prependIndent(nested, ' '.repeat(lastMarkerWidth))}`;
      }
    }
    return items.join('\n');
  }

  private listItem(li: Element, marker: string): string {
    const children = Array.from(li.children);
    const first = children[0];
    const checkbox =
      children.find(isCheckbox) ??
      (first && ['p', 'label', 'span'].includes(tag(first))
        ? Array.from(first.children).find(isCheckbox)
        : undefined);
    const task = !checkbox || this.plain ? '' : checkbox.hasAttribute('checked') ? '[x] ' : '[ ] ';
    let content = '';
    this.parts(li).forEach((part, i) => {
      if (i > 0) content += part.isList ? '\n' : '\n\n';
      content += part.text;
    });
    return marker + task + indentContinuation(content, ' '.repeat(marker.length));
  }

  private table(el: Element): Part[] {
    const rows = rowsOf(el);
    const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const layout =
      columns <= 1 || rows.some((row) => row.some((c) => c.querySelector(LAYOUT_SELECTOR) !== null));
    if (layout) return rows.flat().flatMap((cell) => this.parts(cell));
    if (this.plain) {
      const text = rows.map((row) => row.map((c) => singleLine(this.blocks(c))).join('\t')).join('\n');
      return [{ text, isList: false }];
    }
    const cells = rows.map((row) => row.map((c) => singleLine(this.blocks(c))));
    return [{ text: markdownTable(cells), isList: false }];
  }

  private language(pre: Element): string {
    const classes = [...Array.from(pre.classList), ...Array.from(pre.querySelector('code')?.classList ?? [])];
    for (const name of classes) {
      const stripped = name.replace(/^language-/, '').replace(/^lang-/, '');
      if (stripped !== name && !isBlank(stripped)) return stripped;
    }
    return '';
  }

  private inlineChildren(el: Element, style: Style): string {
    let out = '';
    el.childNodes.forEach((node) => {
      out += this.inline(node, style);
    });
    return out;
  }

  private inline(node: Node, style: Style): string {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
      const text = collapse((node as CharacterData).data);
      return this.plain ? text : escapeInline(text);
    }
    if (node.nodeType === Node.ELEMENT_NODE) return this.inlineElement(node as Element, style);
    return '';
  }

  private inlineElement(el: Element, style: Style): string {
    const css = attr(el, 'style').toLowerCase();
    switch (tag(el)) {
      case 'br':
        return HARD_BREAK;
      case 'img':
        return this.image(el);
      case 'a':
        return this.anchor(el, style);
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        return this.code(el);
      case 'strong':
      case 'b':
        return NOT_BOLD.test(css) ? this.styled(el, style, css) : this.emphasis(el, style, { bold: true });
      case 'em':
      case 'i':
      case 'cite':
      case 'dfn':
      case 'var':
        return this.emphasis(el, style, { italic: true });
      case 's':
      case 'strike':
      case 'del':
        return this.emphasis(el, style, { strike: true });
      case 'input':
        return '';
      default: {
        const text = this.styled(el, style, css);
        return BLOCK_TAGS.has(tag(el)) ? ` ${text} ` : text;
      }
    }
  }

  /** Applies the formatting Google Docs and others express with CSS instead of tags. */
  private styled(el: Element, style: Style, css: string): string {
    if (css === '') return this.inlineChildren(el, style);
    if (MONOSPACE.test(css)) return this.code(el);
    return this.emphasis(el, style, {
      bold: BOLD.test(css),
      italic: ITALIC.test(css),
      strike: STRIKE.test(css),
    });
  }

  private emphasis(el: Element, style: Style, add: Partial<Style>): string {
    const bold = add.bold ?? false;
    const italic = add.italic ?? false;
    const strike = add.strike ?? false;
    let text = this.inlineChildren(el, {
      bold: style.bold || bold,
      italic: style.italic || italic,
      strike: style.strike || strike,
    });
    if (this.plain || text.includes(HARD_BREAK)) return text;
    if (strike && !style.strike) text = wrap(text, '~~');
    if (italic && !style.italic) text = wrap(text, '*');
    if (bold && !style.bold) text = wrap(text, '**');
    return text;
  }

  private code(el: Element): string {
    const text = collapse(wholeText(el));
    return this.plain ? text : codeSpan(text);
  }

  private anchor(el: Element, style: Style): string {
    const label = this.inlineChildren(el, style);
    // The raw attribute: the parsed document would resolve relative links against the app's own address.
    const href = attr(el, 'href').trim();
    const lower = href.toLowerCase();
    if (this.plain || isBlank(label) || !LINK_SCHEMES.some((s) => lower.startsWith(s))) return label;
    const lead = /^\s*/.exec(label)![0];
    const trail = /\s*$/.exec(label)![0];
    const text = label.trim();
    const result =
      text === escapeInline(href) && !href.includes(' ')
        ? `<${href}>`
        : link(text.replaceAll(HARD_BREAK, ' '), href);
    return lead + result + trail;
  }

  private image(el: Element): string {
    const src = attr(el, 'src').trim();
    const alt = collapse(attr(el, 'alt')).trim();
    if (this.plain) return alt;
    const lower = src.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) return '';
    return link(escapeInline(alt || 'Image'), src);
  }

  /** Splits inline content on empty hard-broken lines into paragraphs and escapes line starts. */
  private paragraphs(inline: string): string | null {
    const groups: string[][] = [[]];
    for (const raw of inline.split('\n')) {
      const line = raw.trim();
      const content = (line.endsWith('\\') ? line.slice(0, -1) : line).trim();
      if (content === '') {
        if (groups[groups.length - 1].length > 0) groups.push([]);
      } else {
        groups[groups.length - 1].push(line.endsWith('\\') ? `${content}\\` : content);
      }
    }
    const text = groups
      .filter((g) => g.length > 0)
      .map((lines) =>
        lines
          .map((line, i) => {
            const clean =
              i === lines.length - 1 ? (line.endsWith('\\') ? line.slice(0, -1) : line).trimEnd() : line;
            return this.plain ? clean : escapeLineStart(clean);
          })
          .join('\n'),
      )
      .join('\n\n');
    return isBlank(text) ? null : text;
  }
}

function isCheckbox(el: Element): boolean {
  return tag(el) === 'input' && attr(el, 'type').toLowerCase() === 'checkbox';
}

function rowsOf(table: Element): Element[][] {
  const rows: Element[] = [];
  for (const child of Array.from(table.children)) {
    const name = tag(child);
    if (name === 'tr') rows.push(child);
    else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
      rows.push(...Array.from(child.children).filter((r) => tag(r) === 'tr'));
    }
  }
  return rows
    .map((row) => Array.from(row.children).filter((c) => tag(c) === 'td' || tag(c) === 'th'))
    .filter((r) => r.length > 0);
}
