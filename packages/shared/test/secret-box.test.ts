import { describe, expect, it } from 'vitest';
import { createSecretBox, secretsEqual } from '../src/crypto/secret-box.js';

/**
 * What these tests protect: **a stored credential is never readable from
 * storage, and a tampered one fails loudly rather than being typed into a
 * password field.**
 *
 * The second half matters more than it looks. Without authentication, an
 * altered ciphertext decrypts to garbage, the login types that garbage, and the
 * application answers "wrong credentials" — a failure that blames the user's
 * password for what is actually a corrupted record.
 */

const PASSPHRASE = 'a-sufficiently-long-test-key-0123456789';
const PASSWORD = 'sup3r-s3cret-value';

function boxWith(passphrase = PASSPHRASE) {
  const box = createSecretBox(passphrase);
  expect(box.ok).toBe(true);
  if (!box.ok) throw new Error('unreachable');
  return box.value;
}

describe('sealing a credential', () => {
  it('round-trips the exact plaintext', () => {
    const box = boxWith();

    const sealed = box.seal(PASSWORD);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    const opened = box.open(sealed.value);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value).toBe(PASSWORD);
  });

  it('never leaves the plaintext anywhere in what is stored', () => {
    const box = boxWith();
    const sealed = box.seal(PASSWORD);
    if (!sealed.ok) return;

    // This is the whole claim of the feature: a database dump reveals nothing.
    expect(JSON.stringify(sealed.value)).not.toContain(PASSWORD);
    expect(Buffer.from(sealed.value.ciphertext, 'base64').toString('utf8')).not.toContain(
      PASSWORD,
    );
  });

  it('produces a different ciphertext every time', () => {
    // A deterministic ciphertext would tell an observer that two profiles share
    // a password without decrypting either.
    const box = boxWith();
    const first = box.seal(PASSWORD);
    const second = box.seal(PASSWORD);
    if (!first.ok || !second.ok) return;

    expect(first.value.ciphertext).not.toBe(second.value.ciphertext);
    expect(first.value.iv).not.toBe(second.value.iv);
  });

  it('handles a password with multi-byte characters', () => {
    const box = boxWith();
    const unicode = 'mật-khẩu-Ω-🔐';

    const sealed = box.seal(unicode);
    if (!sealed.ok) return;
    const opened = box.open(sealed.value);
    if (!opened.ok) return;

    expect(opened.value).toBe(unicode);
  });

  it('handles an empty value without pretending it succeeded differently', () => {
    const box = boxWith();
    const sealed = box.seal('');
    if (!sealed.ok) return;

    const opened = box.open(sealed.value);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value).toBe('');
  });
});

describe('opening a credential that cannot be trusted', () => {
  it('refuses a tampered ciphertext instead of returning garbage', () => {
    const box = boxWith();
    const sealed = box.seal(PASSWORD);
    if (!sealed.ok) return;

    const bytes = Buffer.from(sealed.value.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;

    const opened = box.open({ ...sealed.value, ciphertext: bytes.toString('base64') });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.code).toBe('INTERNAL_ERROR');
  });

  it('refuses a tampered authentication tag', () => {
    const box = boxWith();
    const sealed = box.seal(PASSWORD);
    if (!sealed.ok) return;

    const tag = Buffer.from(sealed.value.tag, 'base64');
    tag[0] = tag[0]! ^ 0xff;

    expect(box.open({ ...sealed.value, tag: tag.toString('base64') }).ok).toBe(false);
  });

  it('refuses a record sealed with a different key', () => {
    const sealed = boxWith().seal(PASSWORD);
    if (!sealed.ok) return;

    const other = boxWith('a-completely-different-key-9876543210');

    expect(other.open(sealed.value).ok).toBe(false);
  });

  it('gives the same error for a wrong key as for a tampered record', () => {
    // Distinguishing them is an oracle for anyone holding the database.
    const sealed = boxWith().seal(PASSWORD);
    if (!sealed.ok) return;

    const wrongKey = boxWith('a-completely-different-key-9876543210').open(sealed.value);
    const bytes = Buffer.from(sealed.value.ciphertext, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = boxWith().open({ ...sealed.value, ciphertext: bytes.toString('base64') });

    expect(wrongKey.ok).toBe(false);
    expect(tampered.ok).toBe(false);
    if (wrongKey.ok || tampered.ok) return;
    expect(wrongKey.error.message).toBe(tampered.error.message);
  });

  it('refuses a malformed nonce rather than throwing', () => {
    const box = boxWith();
    const sealed = box.seal(PASSWORD);
    if (!sealed.ok) return;

    const opened = box.open({ ...sealed.value, iv: Buffer.alloc(4).toString('base64') });

    expect(opened.ok).toBe(false);
  });

  it('refuses an algorithm it does not implement, naming it', () => {
    const box = boxWith();
    const sealed = box.seal(PASSWORD);
    if (!sealed.ok) return;

    const opened = box.open({
      ...sealed.value,
      algorithm: 'aes-256-cbc' as SealedAlgorithm,
    });

    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.error.message).toContain('aes-256-cbc');
  });
});

type SealedAlgorithm = 'aes-256-gcm';

describe('the key itself', () => {
  it('refuses a passphrase short enough to brute-force', () => {
    // Failing at startup beats discovering it after credentials are stored.
    const box = createSecretBox('short');

    expect(box.ok).toBe(false);
    if (box.ok) return;
    expect(box.error.code).toBe('VALIDATION_FAILED');
    expect(box.error.message).toContain('RUNNER_SECRET_KEY');
  });

  it('refuses whitespace passing for length', () => {
    expect(createSecretBox('              ').ok).toBe(false);
  });
});

describe('comparing secrets', () => {
  it('matches equal values and rejects different ones', () => {
    expect(secretsEqual(PASSWORD, PASSWORD)).toBe(true);
    expect(secretsEqual(PASSWORD, `${PASSWORD}x`)).toBe(false);
    expect(secretsEqual('', '')).toBe(true);
  });
});
