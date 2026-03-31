import { describe, it, expect } from "vitest";
import {
  canonicalize,
  generateNodeKeyPair,
  signPayload,
  verifyPayloadSignature,
} from "@/lib/federation-crypto";

// ---------------------------------------------------------------------------
// canonicalize
// ---------------------------------------------------------------------------

describe("canonicalize", () => {
  it("sorts object keys alphabetically", () => {
    const result = canonicalize({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it("handles nested objects with recursive key sorting", () => {
    const result = canonicalize({ b: { z: 1, a: 2 }, a: 1 });
    expect(result).toBe('{"a":1,"b":{"a":2,"z":1}}');
  });

  it("handles arrays preserving element order", () => {
    const result = canonicalize([3, 1, 2]);
    expect(result).toBe("[3,1,2]");
  });

  it("handles arrays of objects", () => {
    const result = canonicalize([{ b: 2, a: 1 }]);
    expect(result).toBe('[{"a":1,"b":2}]');
  });

  it("handles null", () => {
    expect(canonicalize(null)).toBe("null");
  });

  it("handles undefined", () => {
    expect(canonicalize(undefined)).toBe("null");
  });

  it("handles boolean values", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });

  it("handles number values", () => {
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(3.14)).toBe("3.14");
    expect(canonicalize(-0)).toBe("0");
  });

  it("handles string values with proper JSON escaping", () => {
    expect(canonicalize("hello")).toBe('"hello"');
    expect(canonicalize('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("omits undefined object values", () => {
    const result = canonicalize({ a: 1, b: undefined, c: 3 });
    expect(result).toBe('{"a":1,"c":3}');
  });

  it("preserves null object values", () => {
    const result = canonicalize({ a: null, b: 1 });
    expect(result).toBe('{"a":null,"b":1}');
  });

  it("handles empty object", () => {
    expect(canonicalize({})).toBe("{}");
  });

  it("handles empty array", () => {
    expect(canonicalize([])).toBe("[]");
  });

  it("handles deeply nested structures", () => {
    const result = canonicalize({
      z: { y: { x: { w: "deep" } } },
      a: [1, { c: 3, b: 2 }],
    });
    expect(result).toBe('{"a":[1,{"b":2,"c":3}],"z":{"y":{"x":{"w":"deep"}}}}');
  });

  it("produces deterministic output regardless of insertion order", () => {
    const obj1: Record<string, unknown> = {};
    obj1.first = 1;
    obj1.second = 2;

    const obj2: Record<string, unknown> = {};
    obj2.second = 2;
    obj2.first = 1;

    expect(canonicalize(obj1)).toBe(canonicalize(obj2));
  });
});

// ---------------------------------------------------------------------------
// generateNodeKeyPair
// ---------------------------------------------------------------------------

describe("generateNodeKeyPair", () => {
  it("returns PEM-encoded public and private keys", () => {
    const { publicKey, privateKey } = generateNodeKeyPair();

    expect(publicKey).toContain("-----BEGIN PUBLIC KEY-----");
    expect(publicKey).toContain("-----END PUBLIC KEY-----");
    expect(privateKey).toContain("-----BEGIN PRIVATE KEY-----");
    expect(privateKey).toContain("-----END PRIVATE KEY-----");
  });

  it("generates unique key pairs on each call", () => {
    const pair1 = generateNodeKeyPair();
    const pair2 = generateNodeKeyPair();

    expect(pair1.publicKey).not.toBe(pair2.publicKey);
    expect(pair1.privateKey).not.toBe(pair2.privateKey);
  });

  it("generates keys that can be used for sign/verify", () => {
    const { publicKey, privateKey } = generateNodeKeyPair();
    const payload = { test: "data" };

    const signature = signPayload(payload, privateKey);
    const valid = verifyPayloadSignature(payload, signature, publicKey);

    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// signPayload + verifyPayloadSignature roundtrip
// ---------------------------------------------------------------------------

describe("signPayload and verifyPayloadSignature", () => {
  const { publicKey, privateKey } = generateNodeKeyPair();

  it("produces a valid base64-encoded signature", () => {
    const payload = { entity: "agent", action: "upsert", id: "abc-123" };
    const signature = signPayload(payload, privateKey);

    // Base64 string check
    expect(typeof signature).toBe("string");
    expect(signature.length).toBeGreaterThan(0);
    expect(() => Buffer.from(signature, "base64")).not.toThrow();
  });

  it("roundtrips: sign then verify succeeds", () => {
    const payload = { name: "Test Agent", type: "person", visibility: "public" };
    const signature = signPayload(payload, privateKey);
    const valid = verifyPayloadSignature(payload, signature, publicKey);

    expect(valid).toBe(true);
  });

  it("verifies complex nested payloads", () => {
    const payload = {
      id: "uuid-here",
      name: "Complex Agent",
      metadata: { tags: ["a", "b"], nested: { deep: true } },
      pathIds: ["p1", "p2", "p3"],
      visibility: "locale",
    };

    const signature = signPayload(payload, privateKey);
    expect(verifyPayloadSignature(payload, signature, publicKey)).toBe(true);
  });

  it("verifies payloads with null values", () => {
    const payload = { id: "123", description: null, image: null };
    const signature = signPayload(payload, privateKey);
    expect(verifyPayloadSignature(payload, signature, publicKey)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tampered payload detection
// ---------------------------------------------------------------------------

describe("tampered payload detection", () => {
  const { publicKey, privateKey } = generateNodeKeyPair();

  it("rejects when payload is modified after signing", () => {
    const original = { name: "Original", type: "person" };
    const signature = signPayload(original, privateKey);

    const tampered = { name: "Tampered", type: "person" };
    const valid = verifyPayloadSignature(tampered, signature, publicKey);

    expect(valid).toBe(false);
  });

  it("rejects when a field is added after signing", () => {
    const original = { name: "Agent" };
    const signature = signPayload(original, privateKey);

    const tampered = { name: "Agent", extra: "injected" };
    const valid = verifyPayloadSignature(tampered, signature, publicKey);

    expect(valid).toBe(false);
  });

  it("rejects when a field is removed after signing", () => {
    const original = { name: "Agent", type: "person" };
    const signature = signPayload(original, privateKey);

    const tampered = { name: "Agent" };
    const valid = verifyPayloadSignature(tampered, signature, publicKey);

    expect(valid).toBe(false);
  });

  it("rejects when nested data is modified", () => {
    const original = { metadata: { role: "admin" } };
    const signature = signPayload(original, privateKey);

    const tampered = { metadata: { role: "user" } };
    const valid = verifyPayloadSignature(tampered, signature, publicKey);

    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invalid signature rejection
// ---------------------------------------------------------------------------

describe("invalid signature rejection", () => {
  const { publicKey, privateKey } = generateNodeKeyPair();

  it("rejects a garbage signature string", () => {
    const payload = { name: "Test" };
    const valid = verifyPayloadSignature(payload, "not-a-real-signature", publicKey);

    expect(valid).toBe(false);
  });

  it("rejects an empty signature", () => {
    const payload = { name: "Test" };
    const valid = verifyPayloadSignature(payload, "", publicKey);

    expect(valid).toBe(false);
  });

  it("rejects a truncated signature", () => {
    const payload = { name: "Test" };
    const signature = signPayload(payload, privateKey);
    const truncated = signature.slice(0, Math.floor(signature.length / 2));

    const valid = verifyPayloadSignature(payload, truncated, publicKey);
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wrong key rejection
// ---------------------------------------------------------------------------

describe("wrong key rejection", () => {
  it("rejects when verified with a different node's public key", () => {
    const nodeA = generateNodeKeyPair();
    const nodeB = generateNodeKeyPair();

    const payload = { name: "Federated Agent", type: "person" };
    const signature = signPayload(payload, nodeA.privateKey);

    // Verify with nodeB's public key should fail
    const valid = verifyPayloadSignature(payload, signature, nodeB.publicKey);
    expect(valid).toBe(false);
  });

  it("rejects when an invalid PEM key is provided", () => {
    const payload = { name: "Test" };
    const valid = verifyPayloadSignature(payload, "c2lnbmF0dXJl", "not-a-pem-key");

    expect(valid).toBe(false);
  });
});
