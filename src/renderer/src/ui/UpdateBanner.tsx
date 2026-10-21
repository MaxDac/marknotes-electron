import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../preload/api';
import { api, unwrap } from '../data/api';
import { errorMessage } from './context';

/** Offers "Restart to update" once a downloaded update is ready. */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = api().onUpdateStatus(setStatus);
    void unwrap(api().updateStatus()).then(setStatus, () => undefined);
    return unsubscribe;
  }, []);

  if (status?.state !== 'downloaded' || dismissed) return null;
  return (
    <div className="status update-banner" role="status" data-testid="update-banner">
      <span>MarkNotes {status.version} is ready to install.</span>
      {error && <span className="error">{error}</span>}
      <span className="spacer" />
      <button
        className="filled"
        onClick={() => unwrap(api().installUpdate()).catch((e) => setError(errorMessage(e)))}
      >
        Restart to update
      </button>
      <button onClick={() => setDismissed(true)}>Later</button>
    </div>
  );
}
