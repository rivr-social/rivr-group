/**
 * Tests for the email service module (src/lib/email.ts).
 *
 * We mock nodemailer entirely so no real SMTP connection is needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before the module under test is imported
// ---------------------------------------------------------------------------

const mockSendMail = vi.fn();
const mockVerify = vi.fn();

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: mockSendMail,
      verify: mockVerify,
    })),
  },
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn((key: string) => {
    const values: Record<string, string> = {
      SMTP_HOST: "localhost",
      SMTP_PORT: "1025",
      SMTP_USER: "",
      SMTP_PASS: "",
      SMTP_FROM: "noreply@test.local",
      SMTP_SECURE: "false",
    };
    return values[key] ?? "";
  }),
}));

// Import after mocks
import { sendEmail, sendBulkEmail, verifyEmailTransport, _resetTransporter } from "@/lib/email";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetTransporter();
  mockSendMail.mockReset();
  mockVerify.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// sendEmail
// ---------------------------------------------------------------------------

describe("sendEmail", () => {
  it("returns success with messageId when sendMail succeeds", async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: "<abc@test>" });

    const result = await sendEmail({
      to: "alice@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("<abc@test>");
    expect(result.error).toBeUndefined();

    expect(mockSendMail).toHaveBeenCalledOnce();
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "noreply@test.local",
        to: "alice@example.com",
        subject: "Hello",
        html: "<p>hi</p>",
      })
    );
  });

  it("passes optional text and replyTo fields", async () => {
    mockSendMail.mockResolvedValueOnce({ messageId: "<def@test>" });

    await sendEmail({
      to: "bob@example.com",
      subject: "Test",
      html: "<p>body</p>",
      text: "body",
      replyTo: "reply@example.com",
    });

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "body",
        replyTo: "reply@example.com",
      })
    );
  });

  it("returns failure with error message when sendMail throws", async () => {
    mockSendMail.mockRejectedValueOnce(new Error("SMTP down"));

    const result = await sendEmail({
      to: "fail@example.com",
      subject: "Nope",
      html: "<p>fail</p>",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("SMTP down");
    expect(result.messageId).toBeUndefined();
  });

  it("handles non-Error throwables gracefully", async () => {
    mockSendMail.mockRejectedValueOnce("string error");

    const result = await sendEmail({
      to: "fail@example.com",
      subject: "Nope",
      html: "<p>fail</p>",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("string error");
  });
});

// ---------------------------------------------------------------------------
// sendBulkEmail
// ---------------------------------------------------------------------------

describe("sendBulkEmail", () => {
  it("sends to all recipients and returns per-recipient results", async () => {
    let callCount = 0;
    mockSendMail.mockImplementation(async () => {
      callCount++;
      return { messageId: `<msg-${callCount}@test>` };
    });

    const recipients = ["a@test.com", "b@test.com", "c@test.com"];
    const results = await sendBulkEmail(
      recipients,
      "Bulk Subject",
      "<p>bulk</p>",
      "bulk"
    );

    expect(results.size).toBe(3);
    for (const email of recipients) {
      const r = results.get(email);
      expect(r?.success).toBe(true);
      expect(r?.messageId).toBeDefined();
    }
  });

  it("captures per-recipient failures without throwing", async () => {
    mockSendMail
      .mockResolvedValueOnce({ messageId: "<ok@test>" })
      .mockRejectedValueOnce(new Error("bounce"))
      .mockResolvedValueOnce({ messageId: "<ok2@test>" });

    const results = await sendBulkEmail(
      ["a@test.com", "b@test.com", "c@test.com"],
      "Subject",
      "<p>body</p>"
    );

    expect(results.get("a@test.com")?.success).toBe(true);
    expect(results.get("b@test.com")?.success).toBe(false);
    expect(results.get("b@test.com")?.error).toBe("bounce");
    expect(results.get("c@test.com")?.success).toBe(true);
  });

  it("handles empty recipients list", async () => {
    const results = await sendBulkEmail([], "Subject", "<p>body</p>");
    expect(results.size).toBe(0);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// verifyEmailTransport
// ---------------------------------------------------------------------------

describe("verifyEmailTransport", () => {
  it("returns true when SMTP connection is valid", async () => {
    mockVerify.mockResolvedValueOnce(true);
    const ok = await verifyEmailTransport();
    expect(ok).toBe(true);
  });

  it("returns false when SMTP connection fails", async () => {
    mockVerify.mockRejectedValueOnce(new Error("no connection"));
    const ok = await verifyEmailTransport();
    expect(ok).toBe(false);
  });
});
