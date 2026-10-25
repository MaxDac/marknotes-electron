import { useEffect, useState } from 'react';
import type { CaptureProtectionStatus } from '../../../preload/api';
import { api, unwrap } from '../data/api';
import { errorMessage } from './context';

export function CaptureProtectionSettings() {
  const [status, setStatus] = useState<CaptureProtectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const update = (value: CaptureProtectionStatus) => {
      if (active) setStatus(value);
    };
    const unsubscribe = api().onCaptureProtection(update);
    void unwrap(api().captureProtection()).then(update, (e) => {
      if (active) setError(errorMessage(e));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const change = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await unwrap(api().setCaptureProtection(enabled)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>Screenshots and screen sharing</h3>
      <label className="row">
        <input
          type="checkbox"
          role="switch"
          aria-label="Protect notes from screen capture"
          checked={status?.enabled ?? false}
          disabled={!status?.supported || status.forced || busy}
          onChange={(event) => void change(event.target.checked)}
        />
        Protect notes from screen capture
      </label>
      <p className="small">
        Requests native capture protection for every MarkNotes window on Windows and macOS. This is
        best-effort: some capture tools can bypass it, including ScreenCaptureKit on newer macOS versions.
        Linux is not supported. This device-only preference is kept separately from your notes.
      </p>
      {status?.supported && status.forced && (
        <p className="small">Capture protection is required while the app lock is enabled.</p>
      )}
      {status && !status.supported && (
        <p className="notice">Capture protection is not available on this platform.</p>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
