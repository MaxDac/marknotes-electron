import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
import { attachmentFromSrc } from '../../../shared/attachments';
import { noteIdFromHref } from '../../../shared/noteLinks';

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Only absolute `https:` URLs can be loaded as remote images, and only after the user asks for it. */
export const isRemoteImage = (src: string) => /^https:\/\/[^/\\]/i.test(src);

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre><code class="hljs language-${escape(lang)}">${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        // fall through to plain rendering
      }
    }
    return `<pre><code class="hljs">${escape(code)}</code></pre>`;
  },
});

/** GitHub-style task lists: `- [ ] todo` / `- [x] done` render as read-only checkboxes. */
md.core.ruler.after('inline', 'task-lists', (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (
      inline.type !== 'inline' ||
      tokens[i - 1].type !== 'paragraph_open' ||
      tokens[i - 2].type !== 'list_item_open'
    )
      continue;
    const match = /^\[([ xX])\]\s/.exec(inline.content);
    const first = inline.children?.[0];
    if (!match || !first || first.type !== 'text') continue;
    first.content = first.content.substring(match[0].length);
    const checkbox = new state.Token('html_inline', '', 0);
    checkbox.content = `<input type="checkbox" disabled${match[1] === ' ' ? '' : ' checked'}>`;
    inline.children!.unshift(checkbox);
    tokens[i - 2].attrJoin('class', 'task');
  }
});

/**
 * Images stored as attachments get a data-attachment attribute; the preview loads them from the note store.
 * Web images (`https:` only) are not loaded: their address moves to data-remote-src until the user chooses to load
 * them, so a note cannot reveal when it is read. Any other source (`http:`, `//host`, `file:`, relative paths…) is
 * dropped.
 */
const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = String(token.attrGet('src') ?? '');
  const attachment = attachmentFromSrc(src);
  token.attrSet('src', '');
  if (attachment) token.attrSet('data-attachment', attachment);
  else if (isRemoteImage(src)) {
    token.attrSet('data-remote-src', src);
    token.attrJoin('class', 'remote');
  } else token.attrJoin('class', 'blocked');
  return defaultImage(tokens, idx, options, env, self);
};

/** `marknotes:<id>` links get a data-note-id attribute so the preview can resolve them. */
md.core.ruler.push('note-links', (state) => {
  for (const block of state.tokens) {
    for (const token of block.children ?? []) {
      if (token.type !== 'link_open') continue;
      const id = noteIdFromHref(String(token.attrGet('href') ?? ''));
      if (id) {
        token.attrSet('data-note-id', id);
        token.attrJoin('class', 'note-link');
      }
    }
  }
});

export const renderMarkdown = (text: string) => md.render(text);
