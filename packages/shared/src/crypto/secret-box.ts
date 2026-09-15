import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { RunnerErrors } from '../errors/error-factories.js';
import { err, ok, type Result } from '../result/result.js';

/**
 * Authenticated encryption for credentials the Runner has to store
 * (blueprint section 50).
 *
 * The Runner's original rule was that a credential exists only in the
 * environment of the worker that needs it. Storing a profile through the API
 * relaxes that deliberately — a user editing profiles in a browser is worth the
 * trade — so the rule becomes: **a stored credential is never stored readable,
 * and never leaves the Runner.**
 *
 * AES-256-GCM rather than AES-CBC, because GCM authenticates. Without a tag, a
 * tampered ciphertext decrypts into garbage that the login would type into a
 * password field, which fails as "wrong credentials" — the hardest possible
 * thing to diagnose. A modified record now fails loudly as a decryption error.
 *
 * The key comes from `RUNNER_SECRET_KEY` and never from the database: a dump of
 * the database alone reveals nothing. Losing the key means losing every stored
 * credential, which is the intended direction — they can be re-entered, and a
 * recoverable-without-the-key design would defeat the point.
 */

/** GCM's standard 96-bit nonce. Longer or shorter weakens it. */
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
/** Fixed, because a per-record salt would have to be stored next to it anyway. */
const KEY_SALT = 'runner-service.secret-box.v1';

/** What is written to storage. No field of this is sensitive on its own. */
export interface SealedSecret {
  /** Base64 ciphertext. */
  readonly ciphertext: string;
  /** Base64 nonce, unique per encryption. */
  readonly iv: string;
  /** Base64 GCM authentication tag. */
  readonly tag: string;
  /** So a future algorithm change can still read what this one wrote. */
  readonly algorithm: 'aes-256-gcm';
}

export interface SecretBox {
  seal(plaintext: string): Result<SealedSecret>;
  open(sealed: SealedSecret): Result<string>;
}

/**
 * Derives the key once, so every seal/open is a cheap operation.
 *
 * scrypt rather than using the passphrase directly: an operator will set
 * `RUNNER_SECRET_KEY` to something human-chosen, and feeding that straight into
 * AES as 32 raw bytes would silently truncate or pad it.
 */
export function createSecretBox(passphrase: string): Result<SecretBox> {
  if (passphrase.trim().length < 16) {
    // Short enough to brute-force is the same as unencrypted, and failing at
    // startup beats discovering it after credentials have been stored.
    return err(
      RunnerErrors.validationFailed(
        'RUNNER_SECRET_KEY must be at least 16 characters. Generate one with `openssl rand -base64 32`.',
      ),
    );
  }

  const key = scryptSync(passphrase, KEY_SALT, KEY_BYTES);

  return ok({
    seal(plaintext: string): Result<SealedSecret> {
      try {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

        return ok({
          ciphertext: ciphertext.toString('base64'),
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          algorithm: 'aes-256-gcm',
        });
      } catch (cause) {
        // Never include the plaintext, not even in a wrapped cause.
        return err(RunnerErrors.internal('Could not encrypt a credential.', cause));
      }
    },

    open(sealed: SealedSecret): Result<string> {
      if (sealed.algorithm !== 'aes-256-gcm') {
        return err(
          RunnerErrors.internal(
            `Stored credential uses unsupported algorithm "${String(sealed.algorithm)}".`,
          ),
        );
      }

      try {
        const iv = Buffer.from(sealed.iv, 'base64');
        const tag = Buffer.from(sealed.tag, 'base64');

        if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
          return err(RunnerErrors.internal('Stored credential is malformed.'));
        }

        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);

        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
          decipher.final(),
        ]);
        return ok(plaintext.toString('utf8'));
      } catch {
        /*
         * The cause is deliberately dropped.
         *
         * A GCM failure means the wrong key or a tampered record, and the
         * library's message distinguishes those — which is exactly the oracle
         * an attacker with database access wants. One opaque error for both.
         */
        return err(
          RunnerErrors.internal(
            'Could not decrypt a stored credential: the key is wrong, or the record was altered.',
          ),
        );
      }
    },
  });
}

/**
 * Compares two secrets without leaking their length difference through timing.
 *
 * Used where the Runner checks a value it was given against one it holds.
 */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
