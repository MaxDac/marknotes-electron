import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tempManifest = new URL('../node_modules/temp/package.json', import.meta.url);
const patch = 'patches/temp+0.9.4.patch';

if (!existsSync(tempManifest)) {
  if (process.env.npm_config_omit?.split(/\s+/).includes('dev') || process.env.NODE_ENV === 'production') {
    console.log('Skipping build-only temp patch: development dependencies are omitted.');
  } else {
    throw new Error('Missing temp build dependency. Run npm ci with development dependencies included.');
  }
} else {
  const manifest: unknown = JSON.parse(readFileSync(tempManifest, 'utf8'));
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    manifest.version !== '0.9.4'
  ) {
    throw new Error('The temp compatibility patch requires exactly temp 0.9.4.');
  }

  function apply(args: string[]) {
    const result = spawnSync('git', ['apply', ...args, patch], { cwd: root, encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  }

  if (apply(['--check', '--reverse']).status === 0) {
    console.log('temp 0.9.4 compatibility patch is already applied.');
  } else {
    const check = apply(['--check']);
    if (check.status !== 0) throw new Error(`Cannot apply temp compatibility patch:\n${check.stderr}`);
    const result = apply([]);
    if (result.status !== 0) throw new Error(`Failed to apply temp compatibility patch:\n${result.stderr}`);
    console.log('Applied temp 0.9.4 compatibility patch for rimraf 6.');
  }
}
