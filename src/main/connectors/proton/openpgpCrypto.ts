import * as openpgp from 'openpgp';
import type { OpenPGPCrypto, PrivateKey, PublicKey, SessionKey, VERIFICATION_STATUS } from './sdk';

/**
 * Implementation of the Drive SDK's OpenPGPCrypto interface directly on OpenPGP.js v6, mirroring the
 * semantics of the SDK's OpenPGPCryptoWithCryptoProxy + Proton's pmcrypto wrapper (signature contexts,
 * verification status, non-AEAD session keys unless AEAD is enabled). The SDK still performs all the
 * Drive-specific cryptography; this is only the generic OpenPGP layer.
 */

const NOT_SIGNED: VERIFICATION_STATUS = 0;
const SIGNED_AND_VALID: VERIFICATION_STATUS = 1;
const SIGNED_AND_INVALID: VERIFICATION_STATUS = 2;

const CONTEXT_NOTATION_NAME = 'context@proton.ch';
const KEY_GENERATION_OFFSET_MS = -60_000;
const SIGNATURE_VERIFICATION_OFFSET_MS = 60_000;

const BASE_CONFIG: openpgp.PartialConfig = {
  allowInsecureDecryptionWithSigningKeys: true,
  allowInsecureVerificationWithReformattedKeys: true,
  minRSABits: 1023,
  rejectPublicKeyAlgorithms: new Set(),
  rejectCurves: new Set(),
};

type Bytes = Uint8Array<ArrayBuffer>;
type VerifyResult = { verified: VERIFICATION_STATUS; verificationErrors?: Error[] };
type ContextOptions = { value: string; required: boolean };

const asArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);
const verificationDate = () => new Date(Date.now() + SIGNATURE_VERIFICATION_OFFSET_MS);

function toBytes(data: Uint8Array): Bytes {
  return (data.buffer instanceof ArrayBuffer ? data : new Uint8Array(data)) as Bytes;
}

function contextNotation(value: string): openpgp.RawNotation {
  return {
    name: CONTEXT_NOTATION_NAME,
    value: new TextEncoder().encode(value),
    humanReadable: true,
    critical: true,
  };
}

function configFor(
  context: ContextOptions | undefined,
  extra?: openpgp.PartialConfig,
): openpgp.PartialConfig {
  return {
    ...BASE_CONFIG,
    ...extra,
    ...(context ? { knownNotations: [CONTEXT_NOTATION_NAME] } : {}),
  };
}

function isValidSignatureContext(context: ContextOptions, signature: openpgp.Signature): boolean {
  const packet = signature.packets[0] as unknown as { rawNotations?: openpgp.RawNotation[] };
  const notations = (packet?.rawNotations ?? []).filter(({ name }) => name === CONTEXT_NOTATION_NAME);
  if (notations.some(({ value }) => new TextDecoder().decode(value) === context.value)) return true;
  if (notations.length > 0) return false;
  return !context.required;
}

/** pmcrypto's handleVerificationResult. */
async function verificationResult(
  signatures: openpgp.DecryptMessageResult['signatures'] | undefined,
  context: ContextOptions | undefined,
): Promise<VerifyResult> {
  const errors: Error[] = [];
  let status: VERIFICATION_STATUS = NOT_SIGNED;
  if (signatures?.length) {
    status = SIGNED_AND_INVALID;
    for (const info of signatures) {
      const signature = await info.signature;
      const verified = await info.verified.catch((err: unknown) => {
        errors.push(err instanceof Error ? err : new Error(String(err)));
        return false;
      });
      if (verified) {
        if (!context || isValidSignatureContext(context, signature)) {
          status = SIGNED_AND_VALID;
        } else {
          const error = new Error('context verification error');
          error.name = 'SignatureContextError';
          errors.push(error);
        }
      }
    }
  }
  return { verified: status, verificationErrors: status === SIGNED_AND_INVALID ? errors : undefined };
}

function toOpenpgpSessionKey(sessionKey: SessionKey): openpgp.SessionKey {
  return {
    data: sessionKey.data,
    algorithm: sessionKey.algorithm as openpgp.enums.symmetricNames,
    aeadAlgorithm: (sessionKey.aeadAlgorithm ?? undefined) as openpgp.enums.aeadNames | undefined,
  };
}

function fromOpenpgpSessionKey(sessionKey: {
  data: Uint8Array;
  algorithm: string | null;
  aeadAlgorithm?: string | null;
}): SessionKey {
  return {
    data: toBytes(sessionKey.data),
    algorithm: sessionKey.algorithm,
    aeadAlgorithm: sessionKey.aeadAlgorithm ?? null,
  };
}

/** A session key that ignores the keys' SEIPDv2 (AEAD) preference, like `ignoreSEIPDv2FeatureFlag`. */
function legacySessionKey(): openpgp.SessionKey {
  return { data: crypto.getRandomValues(new Uint8Array(32)), algorithm: 'aes256' };
}

async function generateSessionKeyFor(
  encryptionKeys: PublicKey[],
  enableAead: boolean,
): Promise<openpgp.SessionKey> {
  if (!enableAead) return legacySessionKey();
  return openpgp.generateSessionKey({ encryptionKeys, config: BASE_CONFIG });
}

async function encryptBinary(options: {
  data: Bytes;
  encryptionKeys: PublicKey[];
  sessionKey: SessionKey | undefined;
  signingKeys?: PrivateKey[];
  enableAead: boolean;
  compress?: boolean;
  armored: boolean;
}): Promise<string | Bytes> {
  const sessionKey = options.sessionKey
    ? toOpenpgpSessionKey(options.sessionKey)
    : await generateSessionKeyFor(options.encryptionKeys, options.enableAead);
  const config: openpgp.PartialConfig = {
    ...BASE_CONFIG,
    preferredCompressionAlgorithm: options.compress
      ? openpgp.enums.compression.zlib
      : openpgp.enums.compression.uncompressed,
  };
  const message = await openpgp.createMessage({ binary: options.data });
  if (options.armored) {
    return openpgp.encrypt({
      message,
      encryptionKeys: options.encryptionKeys,
      signingKeys: options.signingKeys ?? [],
      sessionKey,
      format: 'armored',
      config,
    });
  }
  const result = await openpgp.encrypt({
    message,
    encryptionKeys: options.encryptionKeys,
    signingKeys: options.signingKeys ?? [],
    sessionKey,
    format: 'binary',
    config,
  });
  return toBytes(result);
}

async function signDetachedBinary(data: Bytes, signingKeys: PrivateKey[], context?: string): Promise<Bytes> {
  const signature = await openpgp.sign({
    message: await openpgp.createMessage({ binary: data }),
    signingKeys,
    detached: true,
    format: 'binary',
    signatureNotations: context ? [contextNotation(context)] : undefined,
    config: BASE_CONFIG,
  });
  return toBytes(signature);
}

async function decryptInternal(options: {
  message: openpgp.Message<string | Uint8Array>;
  sessionKeys?: SessionKey;
  decryptionKeys?: PrivateKey[];
  passwords?: string[];
  verificationKeys?: PublicKey[];
  signature?: openpgp.Signature;
}): Promise<{ data: Bytes } & VerifyResult> {
  const result = await openpgp.decrypt({
    message: options.message,
    sessionKeys: options.sessionKeys ? toOpenpgpSessionKey(options.sessionKeys) : undefined,
    decryptionKeys: options.decryptionKeys,
    passwords: options.passwords,
    verificationKeys: options.verificationKeys,
    signature: options.signature,
    format: 'binary',
    date: verificationDate(),
    config: BASE_CONFIG,
  });
  const verification = await verificationResult(result.signatures, undefined);
  return { data: toBytes(result.data), ...verification };
}

export class OpenPGPCryptoAdapter implements OpenPGPCrypto {
  generatePassphrase(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  }

  async generateSessionKey(
    encryptionKeys: PublicKey[],
    options: { enableAeadWithEncryptionKeys: boolean },
  ): Promise<SessionKey> {
    return fromOpenpgpSessionKey(
      await generateSessionKeyFor(encryptionKeys, options.enableAeadWithEncryptionKeys),
    );
  }

  async encryptSessionKey(sessionKey: SessionKey, encryptionKeys: PublicKey | PublicKey[]) {
    const keyPacket = await openpgp.encryptSessionKey({
      ...toOpenpgpSessionKey(sessionKey),
      encryptionKeys: asArray(encryptionKeys),
      format: 'binary',
      config: BASE_CONFIG,
    });
    return { keyPacket: toBytes(keyPacket) };
  }

  async encryptSessionKeyWithPassword(sessionKey: SessionKey, password: string) {
    const keyPacket = await openpgp.encryptSessionKey({
      ...toOpenpgpSessionKey(sessionKey),
      passwords: [password],
      format: 'binary',
      config: BASE_CONFIG,
    });
    return { keyPacket: toBytes(keyPacket) };
  }

  async generateKey(passphrase: string, options: { enableAead: boolean }) {
    const { privateKey } = await openpgp.generateKey({
      userIDs: [{ name: 'Drive key' }],
      type: 'ecc',
      curve: 'ed25519Legacy',
      date: new Date(Date.now() + KEY_GENERATION_OFFSET_MS),
      format: 'object',
      config: { ...BASE_CONFIG, aeadProtect: options.enableAead },
    });
    const encrypted = await openpgp.encryptKey({ privateKey, passphrase, config: BASE_CONFIG });
    return { privateKey, armoredKey: encrypted.armor() };
  }

  async encryptArmored(
    data: Bytes,
    encryptionKeys: PublicKey[],
    sessionKey: SessionKey | undefined,
    options: { enableAeadWithEncryptionKeys: boolean },
  ) {
    const armoredData = (await encryptBinary({
      data,
      encryptionKeys,
      sessionKey,
      enableAead: options.enableAeadWithEncryptionKeys,
      armored: true,
    })) as string;
    return { armoredData };
  }

  async encryptAndSign(
    data: Bytes,
    sessionKey: SessionKey,
    encryptionKeys: PublicKey[],
    signingKey: PrivateKey,
    options: { enableAeadWithEncryptionKeys: boolean },
  ) {
    const encryptedData = (await encryptBinary({
      data,
      encryptionKeys,
      sessionKey,
      signingKeys: [signingKey],
      enableAead: options.enableAeadWithEncryptionKeys,
      armored: false,
    })) as Bytes;
    return { encryptedData };
  }

  async encryptAndSignArmored(
    data: Bytes,
    sessionKey: SessionKey | undefined,
    encryptionKeys: PublicKey[],
    signingKey: PrivateKey,
    options: { compress?: boolean; enableAeadWithEncryptionKeys: boolean },
  ) {
    const armoredData = (await encryptBinary({
      data,
      encryptionKeys,
      sessionKey,
      signingKeys: [signingKey],
      enableAead: options.enableAeadWithEncryptionKeys,
      compress: options.compress ?? false,
      armored: true,
    })) as string;
    return { armoredData };
  }

  async encryptAndSignDetached(
    data: Bytes,
    sessionKey: SessionKey,
    encryptionKeys: PublicKey[],
    signingKey: PrivateKey,
    options: { enableAeadWithEncryptionKeys: boolean },
  ) {
    const signature = await signDetachedBinary(data, [signingKey]);
    const encryptedData = (await encryptBinary({
      data,
      encryptionKeys,
      sessionKey,
      enableAead: options.enableAeadWithEncryptionKeys,
      armored: false,
    })) as Bytes;
    return { encryptedData, signature };
  }

  async encryptAndSignDetachedArmored(
    data: Bytes,
    sessionKey: SessionKey,
    encryptionKeys: PublicKey[],
    signingKey: PrivateKey,
    options: { enableAeadWithEncryptionKeys: boolean },
  ) {
    const signature = await signDetachedBinary(data, [signingKey]);
    const armoredData = (await encryptBinary({
      data,
      encryptionKeys,
      sessionKey,
      enableAead: options.enableAeadWithEncryptionKeys,
      armored: true,
    })) as string;
    return { armoredData, armoredSignature: openpgp.armor(openpgp.enums.armor.signature, signature) };
  }

  async sign(data: Bytes, signingKey: PrivateKey, signatureContext: string) {
    return { signature: await signDetachedBinary(data, asArray(signingKey), signatureContext) };
  }

  async signArmored(data: Bytes, signingKey: PrivateKey | PrivateKey[]) {
    const signature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: data }),
      signingKeys: asArray(signingKey),
      detached: true,
      format: 'armored',
      config: BASE_CONFIG,
    });
    return { signature };
  }

  async verify(
    data: Bytes,
    signature: Bytes,
    verificationKeys: PublicKey | PublicKey[],
    signatureContext?: string,
  ): Promise<VerifyResult> {
    return this.verifySignature(
      data,
      await openpgp.readSignature({ binarySignature: signature }),
      verificationKeys,
      signatureContext,
    );
  }

  async verifyArmored(
    data: Bytes,
    armoredSignature: string,
    verificationKeys: PublicKey | PublicKey[],
    signatureContext?: string,
  ): Promise<VerifyResult> {
    return this.verifySignature(
      data,
      await openpgp.readSignature({ armoredSignature }),
      verificationKeys,
      signatureContext,
    );
  }

  private async verifySignature(
    data: Bytes,
    signature: openpgp.Signature,
    verificationKeys: PublicKey | PublicKey[],
    signatureContext?: string,
  ): Promise<VerifyResult> {
    const context = signatureContext ? { value: signatureContext, required: true } : undefined;
    const result = await openpgp.verify({
      message: await openpgp.createMessage({ binary: data }),
      signature,
      verificationKeys: asArray(verificationKeys),
      date: verificationDate(),
      config: configFor(context),
    });
    return verificationResult(result.signatures, context);
  }

  async decryptSessionKey(data: Bytes, decryptionKeys: PrivateKey | PrivateKey[]): Promise<SessionKey> {
    const message = await openpgp.readMessage({ binaryMessage: data });
    const sessionKey = await this.decryptSessionKeyOf(message, decryptionKeys);
    // Encrypted OpenPGP v6 session keys used for AEAD do not store algorithm information.
    if (sessionKey.algorithm === null) {
      sessionKey.algorithm = 'aes256';
      sessionKey.aeadAlgorithm = 'gcm';
    }
    return sessionKey;
  }

  async decryptArmoredSessionKey(armoredData: string, decryptionKeys: PrivateKey | PrivateKey[]) {
    const message = await openpgp.readMessage({ armoredMessage: armoredData });
    return this.decryptSessionKeyOf(message, decryptionKeys);
  }

  private async decryptSessionKeyOf(
    message: openpgp.Message<string | Uint8Array>,
    decryptionKeys: PrivateKey | PrivateKey[],
  ): Promise<SessionKey> {
    const sessionKeys = await openpgp.decryptSessionKeys({
      message,
      decryptionKeys: asArray(decryptionKeys),
      date: verificationDate(),
      config: BASE_CONFIG,
    });
    if (!sessionKeys.length) throw new Error('Could not decrypt session key');
    return fromOpenpgpSessionKey(sessionKeys[0]);
  }

  async decryptKey(armoredKey: string, passphrase: string): Promise<PrivateKey> {
    const privateKey = await openpgp.readPrivateKey({ armoredKey, config: BASE_CONFIG });
    return openpgp.decryptKey({ privateKey, passphrase, config: BASE_CONFIG });
  }

  async decryptAndVerify(data: Bytes, sessionKey: SessionKey, verificationKeys: PublicKey | PublicKey[]) {
    return decryptInternal({
      message: await openpgp.readMessage({ binaryMessage: data }),
      sessionKeys: sessionKey,
      verificationKeys: asArray(verificationKeys),
    });
  }

  async decryptAndVerifyDetached(
    data: Bytes,
    signature: Bytes | undefined,
    sessionKey: SessionKey,
    verificationKeys?: PublicKey | PublicKey[],
  ) {
    return decryptInternal({
      message: await openpgp.readMessage({ binaryMessage: data }),
      sessionKeys: sessionKey,
      verificationKeys: verificationKeys ? asArray(verificationKeys) : undefined,
      signature: signature ? await openpgp.readSignature({ binarySignature: signature }) : undefined,
    });
  }

  async decryptArmored(armoredData: string, decryptionKeys: PrivateKey | PrivateKey[]): Promise<Bytes> {
    const { data } = await decryptInternal({
      message: await openpgp.readMessage({ armoredMessage: armoredData }),
      decryptionKeys: asArray(decryptionKeys),
    });
    return data;
  }

  async decryptArmoredAndVerify(
    armoredData: string,
    decryptionKeys: PrivateKey | PrivateKey[],
    verificationKeys: PublicKey | PublicKey[],
  ) {
    return decryptInternal({
      message: await openpgp.readMessage({ armoredMessage: armoredData }),
      decryptionKeys: asArray(decryptionKeys),
      verificationKeys: asArray(verificationKeys),
    });
  }

  async decryptArmoredAndVerifyDetached(
    armoredData: string,
    armoredSignature: string | undefined,
    sessionKey: SessionKey,
    verificationKeys: PublicKey | PublicKey[],
  ) {
    const result = await decryptInternal({
      message: await openpgp.readMessage({ armoredMessage: armoredData }),
      sessionKeys: sessionKey,
      verificationKeys: asArray(verificationKeys),
      signature: armoredSignature ? await openpgp.readSignature({ armoredSignature }) : undefined,
    });
    return {
      ...result,
      verificationErrors: armoredSignature ? result.verificationErrors : [new Error('Signature is missing')],
    };
  }

  async decryptArmoredWithPassword(armoredData: string, password: string): Promise<Bytes> {
    const { data } = await decryptInternal({
      message: await openpgp.readMessage({ armoredMessage: armoredData }),
      passwords: [password],
    });
    return data;
  }
}
