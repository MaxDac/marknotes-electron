import { useMemo } from 'react';
import { api } from '../data/api';
import { renderMarkdown } from './markdown';

export function Preview(props: { text: string }) {
  const html = useMemo(() => renderMarkdown(props.text), [props.text]);
  return (
    <div
      className="preview"
      data-testid="markdown-preview"
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest('a');
        if (!link) return;
        e.preventDefault();
        const href = link.getAttribute('href') ?? '';
        if (/^https?:\/\//i.test(href)) void api().openExternal(href);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
