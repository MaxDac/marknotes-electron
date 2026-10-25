import type { DiagnosticCode } from '../../../shared/diagnostics';
import { api } from './api';

function unavailable() {
  let alert = document.getElementById('diagnostics-unavailable');
  if (!alert) {
    alert = document.createElement('div');
    alert.id = 'diagnostics-unavailable';
    alert.className = 'error';
    alert.setAttribute('role', 'alert');
    document.body.prepend(alert);
  }
  alert.textContent = 'Could not save local diagnostics. No report was sent.';
}

export function recordDiagnostic(code: DiagnosticCode): void {
  void api()
    .recordDiagnostic(code)
    .then((result) => {
      if (!result.ok) unavailable();
    }, unavailable);
}

export function installDiagnosticHandlers() {
  window.addEventListener('error', () => recordDiagnostic('RENDERER_UNCAUGHT'));
  window.addEventListener('unhandledrejection', () => recordDiagnostic('RENDERER_REJECTION'));
}
