/** A user (account) private key, armored and locked with the key passphrase. */
export interface ProtonUserKey {
  id: string;
  privateKey: string;
  primary: boolean;
  active: boolean;
}

export const FLAG_NOT_COMPROMISED = 1;
export const FLAG_NOT_OBSOLETE = 2;

/**
 * An address private key. Modern accounts lock it with a passphrase carried in `token`, encrypted to the
 * user key; legacy accounts lock it with the key-salt passphrase, like user keys.
 */
export interface ProtonAddressKey {
  id: string;
  privateKey: string;
  token: string | null;
  primary: boolean;
  active: boolean;
  flags: number;
}

export interface ProtonAddress {
  id: string;
  email: string;
  order: number;
  enabled: boolean;
  keys: ProtonAddressKey[];
}

export const canVerify = (key: ProtonAddressKey) => (key.flags & FLAG_NOT_COMPROMISED) !== 0;
export const canEncrypt = (key: ProtonAddressKey) => (key.flags & FLAG_NOT_OBSOLETE) !== 0;

export function primaryKey(address: ProtonAddress): ProtonAddressKey | null {
  return address.keys.find((k) => k.primary && k.active) ?? address.keys.find((k) => k.active) ?? null;
}

type Json = Record<string, unknown>;

const asObject = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function str(obj: Json, key: string): string | null {
  const v = obj[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function int(obj: Json, key: string): number | null {
  const v = obj[key];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return null;
}

/** Parses the Proton key endpoints (`core/v4/users`, `core/v4/addresses`, `core/v4/keys/all`). */
export const ProtonKeysJson = {
  userKeys(response: Json): ProtonUserKey[] {
    const user = asObject(response.User);
    if (!user) return [];
    const out: ProtonUserKey[] = [];
    for (const element of asArray(user.Keys)) {
      const key = asObject(element);
      if (!key) continue;
      const id = str(key, 'ID');
      const privateKey = str(key, 'PrivateKey');
      if (id === null || privateKey === null) continue;
      out.push({
        id,
        privateKey,
        primary: int(key, 'Primary') === 1,
        active: (int(key, 'Active') ?? 1) === 1,
      });
    }
    return out;
  },

  addresses(response: Json): ProtonAddress[] {
    const out: ProtonAddress[] = [];
    for (const element of asArray(response.Addresses)) {
      const address = asObject(element);
      if (!address) continue;
      const id = str(address, 'ID');
      if (id === null) continue;
      const keys: ProtonAddressKey[] = [];
      for (const keyElement of asArray(address.Keys)) {
        const key = asObject(keyElement);
        if (!key) continue;
        const keyId = str(key, 'ID');
        const privateKey = str(key, 'PrivateKey');
        if (keyId === null || privateKey === null) continue;
        const token = str(key, 'Token');
        keys.push({
          id: keyId,
          privateKey,
          token: token && token.trim() ? token : null,
          primary: int(key, 'Primary') === 1,
          active: (int(key, 'Active') ?? 1) === 1,
          flags: int(key, 'Flags') ?? FLAG_NOT_COMPROMISED | FLAG_NOT_OBSOLETE,
        });
      }
      out.push({
        id,
        email: str(address, 'Email') ?? '',
        order: int(address, 'Order') ?? Number.MAX_SAFE_INTEGER,
        enabled: int(address, 'Status') === 1,
        keys,
      });
    }
    return out.sort((a, b) => a.order - b.order);
  },

  /** Armored public keys of an email address, verified keys first. */
  publicKeys(response: Json): string[] {
    const groups = [asObject(response.Address), asObject(response.Unverified)].filter(
      (g): g is Json => g !== null,
    );
    const keys = groups.length === 0 ? asArray(response.Keys) : groups.flatMap((g) => asArray(g.Keys));
    return keys.flatMap((k) => {
      const obj = asObject(k);
      const publicKey = obj && str(obj, 'PublicKey');
      return publicKey !== null && publicKey !== undefined ? [publicKey] : [];
    });
  },
};
