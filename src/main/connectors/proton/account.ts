import * as openpgp from 'openpgp';
import { RemoteUnavailableError } from '../../../shared/types';
import {
  ProtonKeysJson,
  primaryKey,
  type ProtonAddress,
  type ProtonAddressKey,
  type ProtonUserKey,
} from './keys';
import type { OpenPGPCryptoAdapter } from './openpgpCrypto';
import type { PrivateKey, ProtonDriveAccount, ProtonDriveAccountAddress, PublicKey } from './sdk';
import type { ProtonSession } from './session';

export const NO_KEY_PASSPHRASES_MESSAGE =
  'The Proton session has no key passphrases. Reconnect this drive in Settings to sync with Proton Drive.';

export interface ProtonKeysApi {
  getJson(path: string): Promise<Record<string, unknown>>;
}

/**
 * Gives the Drive SDK the user's addresses and unlocked address keys, ported from the Android
 * ProtonAddressKeys. Keys are unlocked with the key passphrases derived at login (ProtonSession.keyPassphrases).
 */
export class ProtonAccount implements ProtonDriveAccount {
  private addresses: ProtonAddress[] | null = null;
  private userKeys: ProtonUserKey[] | null = null;
  private readonly unlocked = new Map<string, Promise<ProtonDriveAccountAddress>>();
  private readonly publicKeys = new Map<string, PublicKey[]>();

  constructor(
    private readonly api: ProtonKeysApi,
    private readonly session: () => ProtonSession | null,
    private readonly crypto: Pick<OpenPGPCryptoAdapter, 'decryptKey'>,
  ) {}

  async getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
    const all = await this.loadAddresses();
    const address = all.find((a) => a.enabled) ?? all[0];
    if (!address) throw new RemoteUnavailableError('This Proton account has no address.');
    return this.toSdkAddress(address);
  }

  async getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
    const all = await this.loadAddresses();
    const out: ProtonDriveAccountAddress[] = [];
    for (const address of all) {
      try {
        out.push(await this.toSdkAddress(address));
      } catch {
        // Addresses whose keys can't be unlocked are skipped.
      }
    }
    return out;
  }

  async getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
    return this.toSdkAddress(await this.findAddress(emailOrAddressId));
  }

  async hasProtonAccount(email: string): Promise<boolean> {
    return (await this.getPublicKeys(email)).length > 0;
  }

  async getPublicKeys(email: string, forceRefresh = false): Promise<PublicKey[]> {
    const cached = this.publicKeys.get(email);
    if (cached && !forceRefresh) return cached;
    const response = await this.api.getJson(
      `/core/v4/keys/all?Email=${encodeURIComponent(email)}&InternalOnly=0`,
    );
    const keys: PublicKey[] = [];
    for (const armoredKey of ProtonKeysJson.publicKeys(response)) {
      try {
        keys.push(await openpgp.readKey({ armoredKey }));
      } catch {
        // Unparsable keys are ignored.
      }
    }
    this.publicKeys.set(email, keys);
    return keys;
  }

  private async findAddress(emailOrId: string): Promise<ProtonAddress> {
    const matches = (a: ProtonAddress) =>
      a.id === emailOrId || a.email.toLowerCase() === emailOrId.toLowerCase();
    const address =
      (await this.loadAddresses()).find(matches) ?? (await this.loadAddresses(true)).find(matches);
    if (!address) throw new RemoteUnavailableError(`Unknown Proton address ${emailOrId}.`);
    return address;
  }

  private async loadAddresses(reload = false): Promise<ProtonAddress[]> {
    if (!this.addresses || reload) {
      this.addresses = ProtonKeysJson.addresses(await this.api.getJson('/core/v4/addresses'));
    }
    return this.addresses;
  }

  private async loadUserKeys(): Promise<ProtonUserKey[]> {
    if (!this.userKeys) {
      const keys = ProtonKeysJson.userKeys(await this.api.getJson('/core/v4/users'));
      this.userKeys = keys.sort((a, b) => Number(b.primary) - Number(a.primary));
    }
    return this.userKeys;
  }

  private toSdkAddress(address: ProtonAddress): Promise<ProtonDriveAccountAddress> {
    let pending = this.unlocked.get(address.id);
    if (!pending) {
      pending = this.unlockAddress(address);
      pending.catch(() => this.unlocked.delete(address.id));
      this.unlocked.set(address.id, pending);
    }
    return pending;
  }

  private async unlockAddress(address: ProtonAddress): Promise<ProtonDriveAccountAddress> {
    const primary = primaryKey(address);
    const keys: { id: string; key: PrivateKey }[] = [];
    let failure: unknown = null;
    for (const key of address.keys.filter((k) => k.active)) {
      try {
        keys.push({ id: key.id, key: await this.unlockAddressKey(key) });
      } catch (e) {
        failure = e;
      }
    }
    if (keys.length === 0) {
      throw failure ?? new RemoteUnavailableError(`Address ${address.id} has no active key.`);
    }
    const primaryIndex = primary ? keys.findIndex((k) => k.id === primary.id) : -1;
    return {
      email: address.email,
      addressId: address.id,
      primaryKeyIndex: Math.max(primaryIndex, 0),
      keys,
    };
  }

  private async unlockAddressKey(key: ProtonAddressKey): Promise<PrivateKey> {
    const passphrase = await this.addressKeyPassphrase(key);
    try {
      return await this.crypto.decryptKey(key.privateKey, passphrase);
    } catch {
      throw new RemoteUnavailableError(`Couldn't unlock the Proton address key ${key.id}.`);
    }
  }

  /**
   * Modern address keys are locked with a random passphrase encrypted (`token`) to the user key; legacy
   * ones with the mailbox-password-derived passphrase, like user keys.
   */
  private async addressKeyPassphrase(key: ProtonAddressKey): Promise<string> {
    const passphrases = this.session()?.keyPassphrases ?? {};
    if (Object.keys(passphrases).length === 0) throw new RemoteUnavailableError(NO_KEY_PASSPHRASES_MESSAGE);
    let passphrase: string | null;
    if (key.token === null) {
      passphrase =
        passphrases[key.id] ??
        (await this.loadUserKeys()).map((u) => passphrases[u.id]).find((p) => p !== undefined) ??
        null;
    } else {
      passphrase = await this.decryptToken(key.token, passphrases);
    }
    if (passphrase === null) {
      throw new RemoteUnavailableError(
        `Couldn't get the passphrase of the Proton address key ${key.id}. Reconnect this drive in Settings.`,
      );
    }
    return passphrase;
  }

  /** Decrypts an address-key token with the first user key that can be unlocked. */
  private async decryptToken(token: string, passphrases: Record<string, string>): Promise<string | null> {
    for (const userKey of await this.loadUserKeys()) {
      const userPassphrase = passphrases[userKey.id];
      if (userPassphrase === undefined) continue;
      try {
        const decryptionKey = await this.crypto.decryptKey(userKey.privateKey, userPassphrase);
        const { data } = await openpgp.decrypt({
          message: await openpgp.readMessage({ armoredMessage: token }),
          decryptionKeys: decryptionKey,
          format: 'utf8',
        });
        return data;
      } catch {
        // Try the next user key.
      }
    }
    return null;
  }
}
