import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

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

export const renderMarkdown = (text: string) => md.render(text);
