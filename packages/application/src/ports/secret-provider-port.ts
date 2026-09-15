import type { Result } from '@runner/shared';

/**
 * Credential access (blueprint section 50).
 *
 * Two rules are encoded in this shape. Test IR carries a *profile reference*,
 * never a password; and a resolved credential is scoped to one execution, so a
 * worker holds only what the current run needs.
 */

export interface ExecutionProfile {
  readonly ref: string;
  readonly workspaceRef: string;
  readonly displayName: string;
  /** How the Runner authenticates this profile. */
  readonly strategy: 'FORM_LOGIN' | 'API_TOKEN' | 'COOKIE' | 'STORAGE_STATE' | 'OAUTH' | 'SSO';
  /** Opaque secret identifiers, resolved separately and never logged. */
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly loginUrl?: string;
  /** Element intents used by a UI login flow, resolved via the Registry. */
  readonly formFields?: Readonly<Record<string, string>>;

  /**
   * Where a token has to end up for the application to consider the browser
   * signed in.
   *
   * There is no single right answer, which is why this is a list rather than a
   * mode. An SPA usually reads a token from `localStorage` and attaches the
   * header itself; a server-rendered app reads a cookie; an API-first app wants
   * the header on the request. Guessing wrong produces the worst failure this
   * whole feature can produce: a login that reports success while every page
   * still renders the sign-in screen.
   *
   * Several placements may apply at once — a token in storage *and* a header is
   * a common pairing while an app migrates.
   */
  readonly tokenPlacements?: readonly TokenPlacement[];

  /**
   * Headers added to every request this profile's browser makes.
   *
   * Free-form on purpose: an internal application often needs a tenant id, an
   * API version or a feature flag alongside authentication, and enumerating
   * those in the Runner would mean a redeploy per application.
   *
   * A value may name a secret through `secretRefs`, so a header carrying a
   * credential is stored the same way a password is.
   */
  readonly extraHeaders?: readonly ProfileHeader[];

  /** How the Runner obtains a token, when the strategy needs one. */
  readonly tokenSource?: TokenSource;
}

/**
 * One place a token is written before the application is loaded.
 *
 * `origin` matters for storage and cookies: browsers scope both, so writing a
 * token without saying where it belongs writes it nowhere useful.
 */
export type TokenPlacement =
  | {
      readonly kind: 'header';
      /** Defaults to `Authorization`. */
      readonly name?: string;
      /** Defaults to `Bearer `, so the value is `Bearer <token>`. */
      readonly prefix?: string;
    }
  | {
      readonly kind: 'localStorage' | 'sessionStorage';
      /** The key the application reads, e.g. `access_token`. */
      readonly key: string;
      /**
       * Wraps the token in JSON before writing it.
       *
       * Many apps store `{"token":"…","expiresAt":…}` rather than a bare
       * string, and a bare string in that slot is read as a malformed session.
       */
      readonly jsonTemplate?: string;
      /** Where the storage belongs. Defaults to the profile's own origin. */
      readonly origin?: string;
    }
  | {
      readonly kind: 'cookie';
      readonly name: string;
      readonly domain?: string;
      readonly path?: string;
      readonly httpOnly?: boolean;
      readonly secure?: boolean;
      readonly sameSite?: 'Strict' | 'Lax' | 'None';
    };

export interface ProfileHeader {
  readonly name: string;
  /** A literal value, or absent when `secretRef` supplies it. */
  readonly value?: string;
  /** Names an entry in `secretRefs`, so the value can be a stored credential. */
  readonly secretRef?: string;
}

/**
 * Where a token comes from.
 *
 * `static` is a token pasted into the profile: simple, and expires whenever the
 * issuer says so. `apiLogin` exchanges credentials for one, which is what
 * "API_TOKEN" usually means in practice and the only form that can refresh
 * itself without a human.
 */
export type TokenSource =
  | { readonly kind: 'static'; /** Names the entry in `secretRefs`. */ readonly secretRef: string }
  | {
      readonly kind: 'apiLogin';
      readonly url: string;
      readonly method?: 'POST' | 'PUT' | 'GET';
      /**
       * Request body, with `{{secretRef}}` placeholders substituted from the
       * resolved secrets.
       *
       * A template rather than named fields because login payloads differ
       * wildly — nested objects, extra constants, a tenant alongside the
       * credentials — and a fixed shape would fit almost none of them.
       */
      readonly bodyTemplate?: string;
      readonly contentType?: string;
      readonly headers?: readonly ProfileHeader[];
      /**
       * Dotted path to the token in the response, e.g. `data.access_token`.
       *
       * Required: picking the first string that looks like a JWT would silently
       * choose a refresh token about as often as an access token.
       */
      readonly tokenPath: string;
      /** Dotted path to an expiry, so a stale token is replaced rather than used. */
      readonly expiresInPath?: string;
    };

export interface ResolvedSecret {
  readonly ref: string;
  readonly value: string;
}

export interface SecretProviderPort {
  getProfile(workspaceRef: string, profileRef: string): Promise<Result<ExecutionProfile>>;
  /** Resolves only the secrets named by a profile, for one execution. */
  resolveSecrets(
    profile: ExecutionProfile,
    executionId: string,
  ): Promise<Result<Record<string, ResolvedSecret>>>;
}
