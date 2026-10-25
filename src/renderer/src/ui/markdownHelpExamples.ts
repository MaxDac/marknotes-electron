export const MARKDOWN_EXAMPLES = [
  {
    title: 'Headings',
    source: '# Heading 1\n## Heading 2\n### Heading 3\n#### Heading 4\n##### Heading 5\n###### Heading 6',
  },
  { title: 'Emphasis', source: '**Bold**, *italic* and ~~strikethrough~~.' },
  {
    title: 'Lists and quotes',
    source: '- A bullet\n  - Nested item\n\n1. First\n2. Second\n\n> A quotation',
  },
  { title: 'Tasks (read-only in preview)', source: '- [ ] To do\n- [x] Done' },
  { title: 'Code', source: 'Inline `code`.\n\n```js\nconst answer = 42;\n```' },
  { title: 'Tables', source: '| Name | Value |\n| --- | --- |\n| Example | 42 |' },
  {
    title: 'Links and rules',
    source: '[Example website](https://example.com)\n\nhttps://example.com\n\n---',
  },
] as const;
