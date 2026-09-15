import type { Result } from '@runner/shared';

/**
 * Outbound HTTP the Runner makes on its own behalf.
 *
 * It exists for exactly one reason: an `apiLogin` token source has to call the
 * application's login endpoint, and that call must not be a bare `fetch` buried
 * in a module. Behind a port it can be faked in a test without a network, given
 * a timeout and a size limit in one place, and audited — which matters here
 * more than usual, because the request body carries a credential.
 *
 * Deliberately smaller than an HTTP client: no redirect policy, no retries, no
 * streaming. A login endpoint that needs any of those is better served by a
 * profile using `FORM_LOGIN` against the real UI.
 */

export interface HttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Decoded as UTF-8 text. Callers parse; the port does not guess. */
  readonly body: string;
}

export interface HttpClientPort {
  /**
   * Sends one request.
   *
   * A non-2xx status is returned as a *result*, not an error: "the login
   * endpoint said 401" is an answer the caller has to report precisely, and
   * collapsing it into a transport failure would lose the distinction between
   * wrong credentials and an unreachable host.
   */
  send(request: HttpRequest): Promise<Result<HttpResponse>>;
}
