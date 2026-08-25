/**
 * Representative fixture module for the AST-guided read benchmark: a realistic
 * service with interfaces, a class, functions, a type alias, and an enum, so
 * the outline has a meaningful symbol index to walk.
 */

export interface AuthOptions {
  /** JWT issuer to trust. */
  issuer: string
  /** Audience claim to require. */
  audience: string
  /** Allowed signing algorithms, in preference order. */
  algorithms: string[]
  /** Token time-to-live in seconds. */
  ttlSeconds: number
  /** Whether to require a nonce claim. */
  requireNonce: boolean
  /** Clock skew tolerance in seconds. */
  clockSkewSeconds: number
  /** Optional rotating-key cache size. */
  keyCacheSize?: number
  /** Optional header name carrying the token. */
  headerName?: string
}

export type Role = 'admin' | 'editor' | 'viewer' | 'auditor'

export enum AuthResult {
  Granted = 'granted',
  Denied = 'denied',
  Challenge = 'challenge',
  Expired = 'expired',
}

const DEFAULT_OPTIONS: AuthOptions = {
  issuer: 'econym',
  audience: 'econym-api',
  algorithms: ['RS256', 'ES256'],
  ttlSeconds: 3600,
  requireNonce: false,
  clockSkewSeconds: 30,
}

export class Authenticator {
  private readonly keys = new Map<string, Uint8Array>()
  private readonly options: AuthOptions

  constructor(options: Partial<AuthOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  addKey(id: string, key: Uint8Array): void {
    if (id.length === 0) throw new Error('key id must not be empty')
    this.keys.set(id, key)
  }

  removeKey(id: string): boolean {
    return this.keys.delete(id)
  }

  listKeyIds(): string[] {
    return [...this.keys.keys()]
  }

  verifyToken(token: string): AuthResult {
    if (!token) return AuthResult.Denied
    const header = this.decodeHeader(token)
    if (header === undefined) return AuthResult.Denied
    const key = this.keys.get(header.kid ?? '')
    if (key === undefined) return AuthResult.Challenge
    const payload = this.decodePayload(token)
    if (payload === undefined) return AuthResult.Denied
    if (this.isExpired(payload.exp)) return AuthResult.Expired
    if (!this.issuerMatches(payload.iss)) return AuthResult.Denied
    if (!this.audienceMatches(payload.aud)) return AuthResult.Denied
    return AuthResult.Granted
  }

  private decodeHeader(token: string): { kid?: string; alg?: string } | undefined {
    const part = token.split('.')[0]
    if (part === undefined) return undefined
    try {
      return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    } catch {
      return undefined
    }
  }

  private decodePayload(token: string): { iss?: string; aud?: string; exp?: number } | undefined {
    const part = token.split('.')[1]
    if (part === undefined) return undefined
    try {
      return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    } catch {
      return undefined
    }
  }

  private isExpired(exp: number | undefined): boolean {
    if (exp === undefined) return false
    return Date.now() / 1000 > exp + this.options.clockSkewSeconds
  }

  private issuerMatches(iss: string | undefined): boolean {
    return iss === this.options.issuer
  }

  private audienceMatches(aud: string | undefined): boolean {
    return aud === this.options.audience
  }
}

export function issueToken(options: { issuer: string; audience: string; role: Role }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: options.issuer,
    aud: options.audience,
    role: options.role,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url')
  return `${header}.${payload}.signature`
}

export function authorize(auth: Authenticator, token: string, required: Role): boolean {
  const result = auth.verifyToken(token)
  if (result !== AuthResult.Granted) return false
  const role = readRole(token)
  return roleRank(role) >= roleRank(required)
}

export function readRole(token: string): Role {
  const part = token.split('.')[1]
  if (part === undefined) return 'viewer'
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return (payload.role as Role) ?? 'viewer'
  } catch {
    return 'viewer'
  }
}

export function roleRank(role: Role): number {
  switch (role) {
    case 'admin':
      return 4
    case 'editor':
      return 3
    case 'auditor':
      return 2
    case 'viewer':
      return 1
  }
}

export async function authenticateMiddleware(
  auth: Authenticator,
  token: string | undefined,
  required: Role,
): Promise<{ ok: boolean; result: AuthResult; role?: Role }> {
  if (token === undefined) return { ok: false, result: AuthResult.Challenge }
  const result = auth.verifyToken(token)
  if (result !== AuthResult.Granted) return { ok: false, result }
  const role = readRole(token)
  if (roleRank(role) < roleRank(required)) return { ok: false, result: AuthResult.Denied, role }
  return { ok: true, result, role }
}
