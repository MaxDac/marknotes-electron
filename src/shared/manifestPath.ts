/**
 * Where drives keep the sync manifest. The manifest itself is built by the shared sync core (`@marknotes/sync`);
 * these constants let the drive stores in the main process find it without loading the core.
 */
export const MANIFEST_DIRECTORY = '.marknotes';
export const MANIFEST_PATH = `${MANIFEST_DIRECTORY}/manifest.json`;
