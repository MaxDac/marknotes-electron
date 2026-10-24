import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Dialog(props: { title: string; children?: ReactNode; actions: ReactNode; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog" role="dialog" aria-label={props.title}>
        <h3>{props.title}</h3>
        <div className="body">{props.children}</div>
        <div className="actions">{props.actions}</div>
      </div>
    </div>
  );
}

/** Asks for a name; `onSubmit` may throw to show a validation error. */
export function NameDialog(props: {
  title: string;
  initial?: string;
  confirm: string;
  onSubmit(name: string): Promise<void>;
  onClose(): void;
}) {
  const [value, setValue] = useState(props.initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const submit = async () => {
    try {
      await props.onSubmit(value);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      actions={
        <>
          <button onClick={props.onClose}>Cancel</button>
          <button className="filled" disabled={value.trim() === ''} onClick={() => void submit()}>
            {props.confirm}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="name-input">Name</label>
        <input
          id="name-input"
          ref={input}
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim() !== '') void submit();
          }}
        />
      </div>
      {error && <div className="error">{error}</div>}
    </Dialog>
  );
}

export function ConfirmDialog(props: {
  title: string;
  message: string;
  confirm: string;
  danger?: boolean;
  /** Extra content below the message, such as an option. */
  children?: ReactNode;
  onConfirm(): void;
  onClose(): void;
}) {
  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      actions={
        <>
          <button onClick={props.onClose}>Cancel</button>
          <button
            className={props.danger ? 'danger' : 'filled'}
            onClick={() => {
              props.onConfirm();
              props.onClose();
            }}
          >
            {props.confirm}
          </button>
        </>
      }
    >
      <p>{props.message}</p>
      {props.children}
    </Dialog>
  );
}
