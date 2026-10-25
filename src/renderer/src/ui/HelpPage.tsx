import { useEffect, useRef } from 'react';
import { MarkdownHelp } from './MarkdownHelp';

export function HelpPage(props: { onBack(): void; onReplay(): void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <>
      <div className="topbar">
        <button aria-label="Back" onClick={props.onBack}>
          Back
        </button>
        <h1 ref={heading} tabIndex={-1}>
          Help
        </h1>
        <button className="filled" onClick={props.onReplay}>
          Start guide
        </button>
      </div>
      <div className="page">
        <div className="page-inner">
          <p>Help is available offline. Replay the guide at any time; its practice note is never saved.</p>
          <MarkdownHelp />
        </div>
      </div>
    </>
  );
}
