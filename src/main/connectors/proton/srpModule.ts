import { randomBytes } from 'node:crypto';
import type { SRPModule, SRPVerifier } from './sdk';
import {
  decodeBase64,
  decodeModulus,
  encodeBase64,
  generateProofs,
  hashPassword,
  mailboxPassword,
} from './srp';

/** The Drive SDK's SRP module, backed by the ported Proton SRP implementation. */
export class ProtonSrpModule implements SRPModule {
  async getSrp(version: number, modulus: string, serverEphemeral: string, salt: string, password: string) {
    const modulusBytes = decodeModulus(modulus);
    const hashed = await hashPassword(version, password, salt, modulusBytes);
    const proofs = generateProofs(modulusBytes, decodeBase64(serverEphemeral), hashed);
    return {
      clientEphemeral: encodeBase64(proofs.clientEphemeral),
      clientProof: encodeBase64(proofs.clientProof),
      expectedServerProof: encodeBase64(proofs.expectedServerProof),
    };
  }

  async getSrpVerifier(): Promise<SRPVerifier> {
    // Only needed to create password-protected public links, which MarkNotes doesn't do.
    throw new Error('Creating SRP verifiers is not supported');
  }

  computeKeyPassword(password: string, salt: string): Promise<string> {
    return mailboxPassword(password, salt);
  }

  generateKeySalt(): string {
    return encodeBase64(randomBytes(16));
  }
}
