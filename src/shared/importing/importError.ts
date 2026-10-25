/** A problem with the imported content, with a message meant for the user. */
export class ImportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImportError';
  }
}

/**
 * Stores an image found in an imported document and returns its attachment path, or null to leave the image out.
 * Mirrors Android's `ImageSink`, asynchronous because images are processed off the main thread.
 */
export type ImageSink = (bytes: Uint8Array, extension: string, fileName: string) => Promise<string | null>;

export const NO_IMAGES: ImageSink = () => Promise.resolve(null);
