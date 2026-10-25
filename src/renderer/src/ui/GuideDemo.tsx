import { useRef, useState } from 'react';
import {
  editorText,
  toggleInline,
  cycleHeading,
  toggleLinePrefix,
  toggleCodeBlock,
  insertLink,
  type EditorText,
} from '../../../shared/markdownEditing';
import { renderMarkdown } from './markdown';

export const DEMO_TEXT =
  '# Welcome to MarkNotes\n\nTry **bold**, *italic* and ~~strikethrough~~.\n\n## A small plan\n\n- Write a note\n- Keep it organised\n\n1. Edit the source\n2. Read the preview\n\n- [ ] Try formatting\n- [x] Open the guide\n\n> This note is temporary. Changes are not saved.\n\nUse `inline code`, or a code block:\n\n```javascript\nconst greeting = "Hello, MarkNotes!";\n```\n\n| View | Purpose |\n| --- | --- |\n| Edit | Write Markdown |\n| Preview | Read the result |';

export function GuideDemo() {
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(DEMO_TEXT);
  const [mode, setMode] = useState<'edit' | 'split' | 'preview'>('split');
  const apply = (action: (value: EditorText) => EditorText) => {
    const element = input.current;
    if (!element) return;
    const next = action(editorText(text, element.selectionStart, element.selectionEnd));
    setText(next.text);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  };
  return (
    <section className="guide-demo" data-tour="demo" aria-label="Temporary practice note">
      <h2>Demo - changes are not saved</h2>
      <p>No autosave, note IDs, attachments, note lookup or sync. Closing the guide discards this text.</p>
      <div className="row" role="group" aria-label="Practice view">
        {(['edit', 'split', 'preview'] as const).map((value) => (
          <button key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>
            {value === 'edit' ? 'Edit' : value === 'split' ? 'Split' : 'Preview'}
          </button>
        ))}
      </div>
      {mode !== 'preview' && (
        <>
          <div className="row" role="group" aria-label="Practice formatting">
            <button onClick={() => apply((value) => toggleInline(value, '**'))}>Bold</button>
            <button onClick={() => apply((value) => toggleInline(value, '*'))}>Italic</button>
            <button onClick={() => apply(cycleHeading)}>Heading</button>
            <button onClick={() => apply((value) => toggleLinePrefix(value, 'bullet'))}>Bullet list</button>
            <button onClick={() => apply((value) => toggleLinePrefix(value, 'checkbox'))}>Checkbox</button>
            <button onClick={() => apply(toggleCodeBlock)}>Code block</button>
            <button onClick={() => apply(insertLink)}>Link</button>
          </div>
          <textarea
            ref={input}
            aria-label="Practice Markdown"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              event.preventDefault();
              const element = event.currentTarget;
              const value = event.clipboardData.getData('text/plain');
              const next = text.slice(0, element.selectionStart) + value + text.slice(element.selectionEnd);
              setText(next);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => event.preventDefault()}
          />
        </>
      )}
      {mode !== 'edit' && (
        <div
          className="preview"
          aria-label="Practice preview"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          onAuxClick={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) event.preventDefault();
          }}
        />
      )}
    </section>
  );
}
