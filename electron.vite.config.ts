import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const secrets = {
  __DROPBOX_APP_KEY__: JSON.stringify(process.env.DROPBOX_APP_KEY ?? ''),
  __MSAL_CLIENT_ID__: JSON.stringify(process.env.MSAL_CLIENT_ID ?? ''),
};

export default defineConfig({
  main: {
    define: secrets,
    build: {
      // The Proton packages ship TypeScript sources, so they must be bundled.
      externalizeDeps: { exclude: ['@protontech/drive-sdk', '@protontech/crypto'] },
    },
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    plugins: [react()],
  },
});
