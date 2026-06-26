import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/lib/crypto/secret-box";

/**
 * Tests for connector secret encryption-at-rest. We pin an explicit
 * CONNECTOR_ENCRYPTION_KEY for deterministic round-trips and to exercise the
 * primary key path (rather than the scrypt/AUTH_SECRET fallback).
 */
describe("secret-box", () => {
  const previousKey = process.env.CONNECTOR_ENCRYPTION_KEY;

  beforeAll(() => {
    // 32 zero bytes, base64-encoded — valid AES-256 key material for tests.
    process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = previousKey;
  });

  it("round-trips a secret through encrypt → decrypt", () => {
    const secret = "ya29.a0AfH-very-secret-oauth-token";
    const sealed = encryptSecret(secret);
    expect(sealed).not.toBeNull();
    expect(sealed).not.toBe(secret);
    expect(isEncryptedSecret(sealed)).toBe(true);
    expect(decryptSecret(sealed)).toBe(secret);
  });

  it("produces the self-describing enc:v1 envelope", () => {
    const sealed = encryptSecret("hello");
    expect(sealed?.startsWith("enc:v1:")).toBe(true);
    // enc:v1:iv:tag:ciphertext → 5 colon-delimited parts.
    expect(sealed?.split(":").length).toBe(5);
  });

  it("uses a fresh IV per call so identical plaintext yields different ciphertext", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same-value");
    expect(decryptSecret(b)).toBe("same-value");
  });

  it("treats non-enveloped values as legacy plaintext on read", () => {
    expect(decryptSecret("legacy-plaintext-token")).toBe("legacy-plaintext-token");
    expect(isEncryptedSecret("legacy-plaintext-token")).toBe(false);
  });

  it("never double-wraps an already-encrypted value", () => {
    const once = encryptSecret("token");
    const twice = encryptSecret(once);
    expect(twice).toBe(once);
    expect(decryptSecret(twice)).toBe("token");
  });

  it("returns null for empty/null/undefined inputs", () => {
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret(undefined)).toBeNull();
    expect(encryptSecret("")).toBeNull();
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret(undefined)).toBeNull();
    expect(decryptSecret("")).toBeNull();
  });

  it("throws on a malformed envelope", () => {
    expect(() => decryptSecret("enc:v1:onlytwo")).toThrow(/Malformed encrypted secret envelope/);
  });

  it("fails authentication when ciphertext is tampered with", () => {
    const sealed = encryptSecret("integrity-protected")!;
    const parts = sealed.split(":");
    // Flip the final ciphertext segment to a different valid base64url payload.
    parts[4] = Buffer.from("tampered-bytes").toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
});
