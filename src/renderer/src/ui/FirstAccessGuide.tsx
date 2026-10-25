import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useEffect, useRef, useState } from 'react';
import { handleOnboarding } from '../data/onboarding';
import { api } from '../data/api';
import { errorMessage, useApp } from './context';
import { GuideDemo } from './GuideDemo';

const STEPS = [
  {
    title: 'Welcome to MarkNotes',
    description:
      'Notes work offline and autosave on this device. Saving is not syncing: add a drive in Settings to keep another copy. Skip at any time; replay from Help.',
  },
  {
    title: 'Create and organise',
    element: '[data-tour="new-note"]',
    description:
      'New note creates a Markdown note in the current folder. New folder helps organise your notes. Nothing in this guide creates a real note.',
  },
  {
    title: 'Your folders and notes',
    element: '[data-tour="folders"]',
    description:
      'Choose a folder in the sidebar, then select a note in the list. Its editor opens beside the list. The empty list is normal on a new installation.',
  },
  {
    title: 'Import documents',
    element: '[data-tour="import"]',
    description:
      'Import text, Markdown, HTML, Word, PDF text or images. Review the title, folder, conversion and preview before saving. Conversion happens locally.',
  },
  {
    title: 'Try Markdown safely',
    element: '[data-tour="demo"]',
    description:
      'Practice below: select text and try the formatting buttons or switch Edit, Split and Preview. This temporary demo never autosaves or syncs. Type @ in a real note to link notes; insert images there to create shared attachments. Those actions are not connected in this demo.',
  },
  {
    title: 'Optional drive sync',
    element: '[data-tour="settings"]',
    description:
      'Settings lets you connect drives, choose appearance and enable optional chord sequences. Without a drive, notes stay on this device. With a drive, sync runs on launch or Sync now, and optionally when reconnected; there is no background polling.',
  },
  {
    title: 'Help is always here',
    element: '[data-tour="help"]',
    description:
      'Help contains an offline Markdown guide, supported syntax and limits. Start guide replays this walkthrough without changing your notes. Finish returns to your workspace.',
  },
] as const;

export function FirstAccessGuide(props: { onDone(): void; onInterrupted(): void; connected: boolean }) {
  const { settings } = useApp();
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(false);
  const savingRef = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const finishRef = useRef<() => void>(() => undefined);

  finishRef.current = () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    void handleOnboarding(settings).then(
      () => {
        if (alive.current) props.onDone();
      },
      (reason: unknown) => {
        if (!alive.current) return;
        savingRef.current = false;
        setSaving(false);
        setError(`Could not save guide preference: ${errorMessage(reason)}. Try Skip or Finish again.`);
      },
    );
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const current = STEPS[step];
    const element = 'element' in current ? document.querySelector(current.element) : undefined;
    if ('element' in current && (!element || element.getClientRects().length === 0)) {
      setError('The guide target is unavailable. Return to your workspace and replay from Help.');
      return;
    }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const guide = driver({
      animate: !reducedMotion.matches,
      smoothScroll: false,
      allowKeyboardControl: false,
      overlayClickBehavior: 'close',
      popoverClass: 'marknotes-guide',
      onDestroyStarted: () => finishRef.current(),
    });
    const refresh = () => {
      guide.setConfig({ ...guide.getConfig(), animate: !reducedMotion.matches });
      guide.refresh();
    };
    let focusFrame: number | undefined;
    reducedMotion.addEventListener('change', refresh);
    guide.highlight({
      element: element ?? undefined,
      popover: {
        title: `${step + 1} of ${STEPS.length}: ${current.title}`,
        description:
          current.description +
          (step === 5 && props.connected
            ? ' You have a connected drive; Sync now is available in the notes toolbar.'
            : ''),
        side: step === 4 ? 'top' : 'bottom',
        showButtons: ['previous', 'next', 'close'],
        disableButtons: step === 0 ? ['previous'] : [],
        nextBtnText: step === STEPS.length - 1 ? 'Finish' : 'Next',
        prevBtnText: 'Back',
        onNextClick: () => {
          if (savingRef.current) return;
          if (step === STEPS.length - 1) finishRef.current();
          else setStep(step + 1);
        },
        onPrevClick: () => {
          if (!savingRef.current) setStep(Math.max(0, step - 1));
        },
        onCloseClick: () => finishRef.current(),
        onPopoverRender: (popover) => {
          popover.wrapper.setAttribute('role', 'region');
          popover.wrapper.removeAttribute('aria-modal');
          popover.wrapper.removeAttribute('aria-labelledby');
          popover.wrapper.setAttribute('aria-label', current.title);
          root.current?.append(popover.wrapper);
          popover.closeButton.setAttribute('aria-label', 'Close guide');
          const skip = document.createElement('button');
          skip.textContent = 'Skip';
          skip.type = 'button';
          skip.addEventListener('click', () => finishRef.current());
          popover.footerButtons.prepend(skip);
          focusFrame = requestAnimationFrame(() => popover.nextButton.focus());
        },
      },
    });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        finishRef.current();
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        !target?.closest('textarea, input, [contenteditable="true"]') &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      ) {
        event.preventDefault();
        document
          .querySelector<HTMLButtonElement>(
            event.key === 'ArrowLeft' ? '.driver-popover-prev-btn' : '.driver-popover-next-btn',
          )
          ?.click();
      }
      if (event.key !== 'Tab') return;
      event.stopImmediatePropagation();
      const focusable = [
        ...document.querySelectorAll<HTMLElement>(
          '.marknotes-guide button:not(:disabled), .guide-demo button:not(:disabled), .guide-demo textarea, .guide-error button',
        ),
      ].filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const at = focusable.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      focusable[(at + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length].focus();
    };
    window.addEventListener('keydown', keyboard, true);
    return () => {
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      reducedMotion.removeEventListener('change', refresh);
      window.removeEventListener('keydown', keyboard, true);
      guide.destroy();
    };
  }, [step, props.connected]);

  useEffect(() => api().onLocked(props.onInterrupted), [props.onInterrupted]);

  return (
    <div
      ref={root}
      className="guide-root"
      data-testid="first-access-guide"
      role="dialog"
      aria-modal="true"
      aria-label="First access guide"
      aria-busy={saving}
    >
      {saving && (
        <div className="guide-error" role="status">
          Saving guide preference...
        </div>
      )}
      {step === 4 && <GuideDemo />}
      {error && (
        <div className="guide-error" role="alert">
          {error}
          <button onClick={props.onInterrupted}>Return to workspace</button>
        </div>
      )}
    </div>
  );
}
