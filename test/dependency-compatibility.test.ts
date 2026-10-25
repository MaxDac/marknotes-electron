import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, createReadStream, mkdtempSync, writeFileSync } from 'node:fs';
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeASARs, generateAsarIntegrity } from '@electron/universal/dist/cjs/asar-utils';
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('app-builder-lib'));
const installerRequire = createRequire(require.resolve('electron-winstaller'));
const asar: typeof import('@electron/asar') = builderRequire('@electron/asar');

interface Temp {
  track(enabled: boolean): void;
  mkdirSync(affixes: { dir: string; prefix: string }): string;
  openSync(affixes: { dir: string; prefix: string }): { path: string; fd: number };
  cleanup(): Promise<{ files: number; dirs: number }>;
  cleanup(callback: (error: Error | null, counts: { files: number; dirs: number }) => void): void;
  cleanupSync(): { files: number; dirs: number };
}
const temp: Temp = installerRequire('temp');
const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'marknotes-dependency-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  temp.cleanupSync();
  temp.track(false);
  asar.uncacheAll();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('packaging dependency compatibility', () => {
  // Runs the install scripts in child processes, which is slow under coverage instrumentation.
  it(
    'applies the pinned patch once, tolerates repeat installs and rejects incompatible sources',
    { timeout: 30_000 },
    async () => {
      const root = fixture();
      const manifest: { scripts: { postinstall: string } } = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      );
      await mkdir(join(root, 'scripts'));
      await mkdir(join(root, 'patches'));
      await mkdir(join(root, 'node_modules/temp/lib'), { recursive: true });
      await copyFile(
        new URL('../scripts/apply-dependency-patches.ts', import.meta.url),
        join(root, 'scripts/apply-dependency-patches.ts'),
      );
      await copyFile(
        new URL('../scripts/install-electron.ts', import.meta.url),
        join(root, 'scripts/install-electron.ts'),
      );
      await mkdir(join(root, 'node_modules/electron'));
      await writeFile(
        join(root, 'node_modules/electron/install.js'),
        "console.log('Electron runtime installer invoked');",
      );
      await copyFile(
        new URL('../patches/temp+0.9.4.patch', import.meta.url),
        join(root, 'patches/temp+0.9.4.patch'),
      );
      const source = join(root, 'node_modules/temp/lib/temp.js');
      await copyFile(installerRequire.resolve('temp'), source);
      const tempManifest = join(root, 'node_modules/temp/package.json');
      await writeFile(tempManifest, JSON.stringify({ version: '0.9.4' }));
      const reverse = spawnSync('git', ['apply', '--reverse', 'patches/temp+0.9.4.patch'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(reverse.stderr).toBe('');
      expect(reverse.status).toBe(0);

      const install = () =>
        spawnSync(manifest.scripts.postinstall, {
          cwd: root,
          encoding: 'utf8',
          shell: true,
          env: { ...process.env, NODE_ENV: '', npm_config_omit: '' },
        });
      const first = install();
      expect(first.stderr).toBe('');
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('Applied temp');
      expect(first.stdout).toContain('Electron runtime installer invoked');
      const second = install();
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('already applied');
      await writeFile(source, 'incompatible source');
      const broken = install();
      expect(broken.status).not.toBe(0);
      expect(broken.stderr).toContain('Cannot apply temp compatibility patch');
      expect(broken.stdout).not.toContain('Electron runtime installer invoked');
      await writeFile(tempManifest, JSON.stringify({ version: '1.0.0' }));
      expect(install().stderr).toContain('requires exactly temp 0.9.4');
      await rm(join(root, 'node_modules/temp'), { recursive: true });
      await rm(join(root, 'node_modules/electron'), { recursive: true });
      const runtimeOnly = spawnSync(manifest.scripts.postinstall, {
        cwd: root,
        encoding: 'utf8',
        shell: true,
        env: { ...process.env, npm_config_omit: 'dev', npm_config_include: '' },
      });
      expect(runtimeOnly.status).toBe(0);
      expect(runtimeOnly.stdout).toContain('development dependencies are omitted');
      expect(runtimeOnly.stdout).toContain('Skipping Electron runtime installation');
      const missing = install();
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain('Missing temp build dependency');
    },
  );

  it('supports electron-builder stream packaging and electron-winstaller extraction', async () => {
    const root = fixture();
    const source = join(root, 'package.json');
    const content = JSON.stringify({ name: 'fixture', version: '1.0.0' });
    await writeFile(source, content);
    const archive = join(root, 'app.asar');
    await asar.createPackageFromStreams(archive, [
      {
        path: 'package.json',
        type: 'file',
        unpacked: false,
        stat: await stat(source),
        streamGenerator: () => createReadStream(source),
      },
    ]);
    const installerAsar: typeof import('@electron/asar') = installerRequire('@electron/asar');
    expect(installerAsar.extractFile(archive, 'package.json').toString()).toBe(content);
    expect(asar.getRawHeader(archive).header.files).toHaveProperty('package.json');
  });

  // The macOS universal merger assumes POSIX archive paths and is not supported on Windows.
  it.skipIf(process.platform === 'win32')(
    'supports the existing universal merger, unpacked files and header integrity',
    async () => {
      const root = fixture();
      const source = join(root, 'source');
      await mkdir(source);
      await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
      await writeFile(join(source, 'fixture.node'), 'identical unpacked fixture');
      const x64AsarPath = join(root, 'x64.asar');
      const arm64AsarPath = join(root, 'arm64.asar');
      const outputAsarPath = join(root, 'universal.asar');
      await asar.createPackageWithOptions(source, x64AsarPath, { unpack: '*.node' });
      await writeFile(join(source, 'arm64.txt'), 'architecture-specific fixture');
      await asar.createPackageWithOptions(source, arm64AsarPath, { unpack: '*.node' });
      await mergeASARs({ x64AsarPath, arm64AsarPath, outputAsarPath, singleArchFiles: 'arm64.txt' });
      expect(asar.extractFile(outputAsarPath, 'arm64.txt').toString()).toBe('architecture-specific fixture');
      expect(asar.statFile(outputAsarPath, 'fixture.node')).toHaveProperty('unpacked', true);
      expect(generateAsarIntegrity(outputAsarPath)).toEqual({
        algorithm: 'SHA256',
        hash: createHash('sha256').update(asar.getRawHeader(outputAsarPath).headerString).digest('hex'),
      });
      const extracted = join(root, 'extracted');
      asar.extractAll(outputAsarPath, extracted);
      expect(await readFile(join(extracted, 'fixture.node'), 'utf8')).toBe('identical unpacked fixture');
    },
  );

  it.each(['sync', 'promise', 'callback'] as const)(
    'preserves temp %s cleanup with modern rimraf',
    async (mode) => {
      temp.track(true);
      const root = fixture();
      const directory = temp.mkdirSync({ dir: root, prefix: 'directory-' });
      await mkdir(join(directory, 'nested'));
      await writeFile(join(directory, 'nested', 'file'), 'contents');
      const file = temp.openSync({ dir: root, prefix: 'file-' });
      writeFileSync(file.fd, 'contents');
      closeSync(file.fd);
      const counts =
        mode === 'sync'
          ? temp.cleanupSync()
          : mode === 'promise'
            ? await temp.cleanup()
            : await new Promise<{ files: number; dirs: number }>((resolve, reject) => {
                temp.cleanup((error, result) => (error ? reject(error) : resolve(result)));
              });
      expect(counts).toEqual({ files: 1, dirs: 1 });
      await expect(access(directory)).rejects.toHaveProperty('code', 'ENOENT');
      await expect(access(file.path)).rejects.toHaveProperty('code', 'ENOENT');
    },
  );
});

describe('real updater cached-metadata comparison', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  async function downloaded(isSaveCache = false) {
    const root = fixture();
    const helper = new DownloadedUpdateHelper(root);
    await mkdir(helper.cacheDirForPendingUpdate);
    const file = join(helper.cacheDirForPendingUpdate, 'installer.exe');
    await writeFile(file, 'downloaded update fixture');
    const sha512 = createHash('sha512')
      .update(await readFile(file))
      .digest('base64');
    const info = {
      version: '1.2.3',
      path: 'installer.exe',
      sha512,
      releaseDate: '2026-01-01T00:00:00.000Z',
      files: [{ url: 'installer.exe', sha512, size: 25 }],
      releaseNotes: [{ version: '1.2.3', note: 'Fixture release' }],
    };
    const fileInfo = { url: new URL('https://example.invalid/installer.exe'), info: info.files[0] };
    await helper.setDownloadedFile(file, null, info, fileInfo, 'installer.exe', isSaveCache);
    return { root, helper, file, info, fileInfo };
  }

  it('reuses equal nested metadata regardless of property insertion order', async () => {
    const { helper, file, info, fileInfo } = await downloaded();
    const reordered = {
      releaseNotes: structuredClone(info.releaseNotes),
      files: structuredClone(info.files),
      releaseDate: info.releaseDate,
      version: info.version,
      sha512: info.sha512,
      path: info.path,
    };
    expect(
      await helper.validateDownloadedPath(
        file,
        reordered,
        { url: fileInfo.url, info: structuredClone(fileInfo.info) },
        logger,
      ),
    ).toBe(file);
    expect(
      await helper.validateDownloadedPath(file, { ...info, version: '1.2.4' }, fileInfo, logger),
    ).toBeNull();
    expect(
      await helper.validateDownloadedPath(
        file,
        { ...info, releaseNotes: [{ version: '1.2.3', note: 'Different notes' }] },
        fileInfo,
        logger,
      ),
    ).toBeNull();
    expect(
      await helper.validateDownloadedPath(
        file,
        info,
        { ...fileInfo, info: { ...fileInfo.info, sha512: 'changed checksum' } },
        logger,
      ),
    ).toBeNull();
    await rm(file);
    expect(await helper.validateDownloadedPath(file, info, fileInfo, logger)).toBeNull();
  });

  it('retains SHA-512 verification across app launches', async () => {
    const { root, file, info, fileInfo } = await downloaded(true);
    const restarted = new DownloadedUpdateHelper(root);
    expect(await restarted.validateDownloadedPath(file, info, fileInfo, logger)).toBe(file);
    await writeFile(file, 'tampered download');
    expect(
      await new DownloadedUpdateHelper(root).validateDownloadedPath(file, info, fileInfo, logger),
    ).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sha512 checksum'));
  });
});
