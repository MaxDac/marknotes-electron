import { useState } from 'react';
import type { DiagnosticDraft } from '../../../shared/diagnostics';
import { api, unwrap } from '../data/api';
import { Dialog } from './Dialog';

export function DiagnosticsSettings() {
  const [draft, setDraft] = useState<DiagnosticDraft | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch {
      setMessage('Could not complete the diagnostics action. No report was sent automatically.');
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setDraft(null);
    setConsent(false);
  };
  return (
    <>
      <h2>Local diagnostics</h2>
      <p className="small">
        Error categories and codes are saved on this device for up to seven days, capped at 5 MiB including
        export snapshots. Logs never include note content, paths, identifiers, credentials or raw errors.
        Nothing is sent automatically.
      </p>
      <div className="row">
        <button
          className="outlined"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await unwrap(api().clearDiagnostics());
              close();
              setMessage('Local logs and export snapshots cleared.');
            })
          }
        >
          Clear logs
        </button>
        <button
          className="outlined"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await unwrap(api().exportDiagnostics());
              setMessage(
                'Offline export opened in its local folder. This snapshot is subject to log retention and replaced by the next export. Copies you make elsewhere are not managed by MarkNotes.',
              );
            })
          }
        >
          Export logs
        </button>
        <button
          className="outlined"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setConsent(false);
              setDraft(await unwrap(api().diagnosticsDraft()));
            })
          }
        >
          Report a problem
        </button>
      </div>
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      {draft && (
        <Dialog
          title="Review diagnostic report"
          onClose={close}
          actions={
            <>
              <button onClick={close}>Cancel</button>
              <button
                className="filled"
                disabled={!consent || busy}
                onClick={() =>
                  void run(async () => {
                    await unwrap(api().openDiagnosticsDraft(draft, consent));
                    close();
                  })
                }
              >
                Open GitHub draft
              </button>
            </>
          }
        >
          <p>
            Opening this draft already sends the logs below to GitHub before you submit an issue and can leave
            them in browser history. You submit the issue yourself in the browser.
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{draft.body}</pre>
          <label className="row">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            I reviewed this excerpt and consent to sending it to GitHub.
          </label>
          {message && (
            <p className="error" role="alert">
              {message}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
