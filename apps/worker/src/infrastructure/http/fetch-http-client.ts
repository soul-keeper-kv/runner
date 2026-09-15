import type { HttpClientPort, HttpRequest, HttpResponse } from '@runner/application';
import { RunnerErrors, err, ok, type Logger, type Result } from '@runner/shared';

/**
 * `HttpClientPort` over Node's fetch.
 *
 * The only outbound HTTP the Runner makes on its own behalf: exchanging
 * credentials for a token at an application's login endpoint. Everything else
 * goes through a browser.
 *
 * Three limits are deliberate rather than configurable. A login endpoint that
 * needs more than this is better handled by a `FORM_LOGIN` profile driving the
 * real UI, where the Runner already has a browser and evidence.
 */

/** A login endpoint that has not answered by now is not going to. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Enough for a token response, small enough that a misconfigured URL pointing
 * at a large page cannot exhaust memory.
 */
const MAX_BODY_BYTES = 256 * 1024;

export class FetchHttpClient implements HttpClientPort {
  constructor(private readonly logger: Logger) {}

  async send(request: HttpRequest): Promise<Result<HttpResponse>> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const response = await fetch(request.url, {
        method: request.method,
        ...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
        // A login endpoint answering with a redirect to an HTML page is a
        // misconfiguration, and following it would hand the caller a page to
        // parse for a token. Better to report the 3xx.
        redirect: 'manual',
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        // Deliberately not filtered: a caller may need `www-authenticate` to
        // explain a refusal. Nothing here is logged.
        headers[name.toLowerCase()] = value;
      });

      const body = await readBounded(response);

      /*
       * The URL is logged, the body and headers are not.
       *
       * A login request's body *is* the credential, and its response is the
       * token. Both would otherwise sit in a log file that outlives the run.
       */
      this.logger.debug('Outbound request completed', {
        url: safeUrl(request.url),
        method: request.method,
        status: response.status,
      });

      return ok({ status: response.status, headers, body });
    } catch (cause) {
      if (controller.signal.aborted) {
        return err(
          RunnerErrors.internal(
            `The request to ${safeUrl(request.url)} timed out after ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
          ),
        );
      }

      // The cause message can name the host but never the payload.
      return err(
        RunnerErrors.internal(
          `Could not reach ${safeUrl(request.url)}: ${cause instanceof Error ? cause.message : 'unknown error'}.`,
        ),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Reads at most `MAX_BODY_BYTES`.
 *
 * A token endpoint returns a few hundred bytes; a URL typed wrong can return a
 * whole application. Truncating is safe because the caller reads a documented
 * JSON path — a body that needed more than this was not a token response.
 */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;

    chunks.push(value);
    total += value.byteLength;
    if (total >= MAX_BODY_BYTES) {
      await reader.cancel();
      break;
    }
  }

  return Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY_BYTES);
}

/**
 * The URL without its query string.
 *
 * A token is sometimes passed as a query parameter, and a logged URL is the
 * easiest way for one to escape into a log file.
 */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(malformed url)';
  }
}
