import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const includeDev = process.env.npm_config_include?.split(/[\s,]+/).includes('dev');
const omitDev =
  !includeDev &&
  (process.env.npm_config_omit?.split(/[\s,]+/).includes('dev') || process.env.NODE_ENV === 'production');

if (omitDev) {
  console.log('Skipping Electron runtime installation: development dependencies are omitted.');
} else {
  const installer = fileURLToPath(new URL('../node_modules/electron/install.js', import.meta.url));
  if (!existsSync(installer)) {
    throw new Error('Missing Electron development dependency. Run npm ci with --include=dev.');
  }
  const result = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Electron runtime installation failed (${result.signal ?? `exit ${result.status}`}). Run npm exec -- install-electron to retry.`,
    );
  }
}
