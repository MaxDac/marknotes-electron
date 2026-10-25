import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'highlight.js/styles/github.css';
import './styles.css';
import { App } from './App';
import { installDiagnosticHandlers, recordDiagnostic } from './data/diagnostics';

installDiagnosticHandlers();
createRoot(document.getElementById('root')!, {
  onCaughtError: () => recordDiagnostic('RENDERER_UNCAUGHT'),
  onUncaughtError: () => recordDiagnostic('RENDERER_UNCAUGHT'),
  onRecoverableError: () => recordDiagnostic('UI_FAILED'),
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
