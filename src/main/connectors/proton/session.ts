/** An authenticated Proton API session, as persisted in the SecretVault (never contains the password). */
export interface ProtonSession {
  uid: string;
  accessToken: string;
  refreshToken: string;
  username: string;
  userId: string;
  /** Passphrases that unlock the user's private keys, by key ID (bcrypt-derived "mailbox passwords"). */
  keyPassphrases: Record<string, string>;
}

export const PROTON_ACCOUNT_PREFIX = 'proton:';

export function accountIdFor(session: Pick<ProtonSession, 'uid' | 'userId'>): string {
  return `${PROTON_ACCOUNT_PREFIX}${session.userId || session.uid}`;
}

export function sessionToJson(session: ProtonSession): string {
  return JSON.stringify({
    uid: session.uid,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    username: session.username,
    userId: session.userId,
    keyPassphrases: session.keyPassphrases,
  });
}

export function sessionFromJson(json: string): ProtonSession | null {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const str = (key: string) => (typeof o[key] === 'string' ? (o[key] as string) : '');
  const keyPassphrases: Record<string, string> = {};
  if (o.keyPassphrases && typeof o.keyPassphrases === 'object') {
    for (const [id, value] of Object.entries(o.keyPassphrases as Record<string, unknown>)) {
      if (typeof value === 'string') keyPassphrases[id] = value;
    }
  }
  const session: ProtonSession = {
    uid: str('uid'),
    accessToken: str('accessToken'),
    refreshToken: str('refreshToken'),
    username: str('username'),
    userId: str('userId'),
    keyPassphrases,
  };
  return session.uid && session.accessToken ? session : null;
}
