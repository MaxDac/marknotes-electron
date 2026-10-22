import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'marknotes-electron-install-'));
  directories.push(root);
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'node_modules/electron'), { recursive: true });
  await copyFile(
    new URL('../scripts/install-electron.ts', import.meta.url),
    join(root, 'scripts/install-electron.ts'),
  );
  await writeFile(
    join(root, 'node_modules/electron/install.js'),
    `const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, 'runtime');
if (!fs.existsSync(target)) fs.writeFileSync(target, 'installed');
console.log('official installer invoked');
`,
  );
  const install = (env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ['scripts/install-electron.ts'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: '',
        npm_config_omit: '',
        npm_config_include: '',
        ...env,
      },
    });
  return { root, install };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Electron runtime setup', () => {
  it('runs the local official installer and preserves its repeat-install behavior', async () => {
    const { root, install } = await fixture();
    const first = install();
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('official installer invoked');
    const runtime = join(root, 'node_modules/electron/runtime');
    expect(await readFile(runtime, 'utf8')).toBe('installed');
    await writeFile(runtime, 'already installed');
    expect(install().status).toBe(0);
    expect(await readFile(runtime, 'utf8')).toBe('already installed');
  });

  it.each([{ npm_config_omit: 'optional dev' }, { NODE_ENV: 'production' }])(
    'skips production-only setup even when Electron is absent: %j',
    async (env) => {
      const { root, install } = await fixture();
      await rm(join(root, 'node_modules/electron'), { recursive: true });
      const result = install(env);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('development dependencies are omitted');
    },
  );

  it('honors explicit development inclusion over production defaults and omission', async () => {
    const { install } = await fixture();
    const result = install({
      NODE_ENV: 'production',
      npm_config_omit: 'dev',
      npm_config_include: 'dev',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('official installer invoked');
  });

  it('does not invoke a retained Electron package during production-only setup', async () => {
    const { install } = await fixture();
    const result = install({ npm_config_omit: 'dev' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Skipping Electron runtime installation');
    expect(result.stdout).not.toContain('official installer invoked');
  });

  it('reports a missing development dependency instead of silently skipping', async () => {
    const { root, install } = await fixture();
    await rm(join(root, 'node_modules/electron'), { recursive: true });
    const result = install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Missing Electron development dependency');
    expect(result.stderr).toContain('npm ci with --include=dev');
  });

  it('propagates installer failure and includes a recovery command', async () => {
    const { root, install } = await fixture();
    await writeFile(
      join(root, 'node_modules/electron/install.js'),
      "console.error('download failed'); process.exit(7);",
    );
    const result = install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('download failed');
    expect(result.stderr).toContain('Electron runtime installation failed (exit 7)');
    expect(result.stderr).toContain('npm exec -- install-electron');
  });
});
