/**
 * Tests for email template generators (src/lib/email-templates.ts).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn((key: string) => {
    if (key === "NEXTAUTH_URL") return "https://app.rivr.local";
    return "";
  }),
}));

import {
  verificationEmail,
  passwordResetEmail,
  loginNotificationEmail,
  groupBroadcastEmail,
  systemNotificationEmail,
} from "@/lib/email-templates";

// ---------------------------------------------------------------------------
// verificationEmail
// ---------------------------------------------------------------------------

describe("verificationEmail", () => {
  it("includes the user name and a properly encoded verification URL", () => {
    const result = verificationEmail("Alice", "abc123token");

    expect(result.subject).toContain("Verify");
    expect(result.subject).toContain("Rivr");
    expect(result.html).toContain("Alice");
    expect(result.html).toContain("https://app.rivr.local/api/auth/verify-email?token=abc123token");
    expect(result.text).toContain("abc123token");
  });

  it("returns subject, html, and text fields", () => {
    const result = verificationEmail("Bob", "tok");
    expect(result).toHaveProperty("subject");
    expect(result).toHaveProperty("html");
    expect(result).toHaveProperty("text");
  });

  it("encodes special characters in the token", () => {
    const result = verificationEmail("Test", "a&b=c");
    expect(result.html).toContain(encodeURIComponent("a&b=c"));
  });
});

// ---------------------------------------------------------------------------
// passwordResetEmail
// ---------------------------------------------------------------------------

describe("passwordResetEmail", () => {
  it("includes the user name and a properly encoded reset URL", () => {
    const result = passwordResetEmail("Charlie", "resettoken");

    expect(result.subject).toContain("Reset");
    expect(result.html).toContain("Charlie");
    expect(result.html).toContain("https://app.rivr.local/auth/reset-password?token=resettoken");
    expect(result.html).toContain("1 hour");
    expect(result.text).toContain("resettoken");
  });
});

// ---------------------------------------------------------------------------
// loginNotificationEmail
// ---------------------------------------------------------------------------

describe("loginNotificationEmail", () => {
  it("includes IP address and user agent in the email body", () => {
    const result = loginNotificationEmail("Dana", "192.168.1.1", "Mozilla/5.0");

    expect(result.subject).toContain("login");
    expect(result.html).toContain("192.168.1.1");
    expect(result.html).toContain("Mozilla/5.0");
    expect(result.html).toContain("Dana");
    expect(result.text).toContain("192.168.1.1");
  });

  it("includes a timestamp in ISO format", () => {
    const result = loginNotificationEmail("Test", "1.2.3.4", "Agent");
    // The timestamp should contain a T (ISO 8601 delimiter)
    expect(result.html).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// groupBroadcastEmail
// ---------------------------------------------------------------------------

describe("groupBroadcastEmail", () => {
  it("includes group name, sender, subject, and body", () => {
    const result = groupBroadcastEmail(
      "Garden Club",
      "Eve",
      "Weekend Meetup",
      "Meet at the park at 10am."
    );

    expect(result.subject).toBe("[Garden Club] Weekend Meetup");
    expect(result.html).toContain("Eve");
    expect(result.html).toContain("Garden Club");
    expect(result.html).toContain("Weekend Meetup");
    expect(result.html).toContain("Meet at the park at 10am.");
    expect(result.text).toContain("[Garden Club]");
    expect(result.text).toContain("Eve");
  });

  it("includes unsubscribe notice", () => {
    const result = groupBroadcastEmail("Test Group", "Sender", "Subject", "Body");
    expect(result.html).toContain("notification preferences");
    expect(result.text).toContain("member of Test Group");
  });
});

// ---------------------------------------------------------------------------
// systemNotificationEmail
// ---------------------------------------------------------------------------

describe("systemNotificationEmail", () => {
  it("includes the title and body content", () => {
    const result = systemNotificationEmail(
      "Frank",
      "System Update",
      "The system will undergo maintenance tonight."
    );

    expect(result.subject).toContain("System Update");
    expect(result.subject).toContain("Rivr");
    expect(result.html).toContain("Frank");
    expect(result.html).toContain("maintenance tonight");
    expect(result.text).toContain("Frank");
    expect(result.text).toContain("maintenance tonight");
  });
});

// ---------------------------------------------------------------------------
// Shared HTML structure
// ---------------------------------------------------------------------------

describe("shared layout", () => {
  it("wraps all templates in proper HTML structure", () => {
    const templates = [
      verificationEmail("A", "t"),
      passwordResetEmail("B", "t"),
      loginNotificationEmail("C", "1.2.3.4", "agent"),
      groupBroadcastEmail("G", "S", "Sub", "Body"),
      systemNotificationEmail("D", "Title", "Content"),
    ];

    for (const tpl of templates) {
      expect(tpl.html).toContain("<!DOCTYPE html>");
      expect(tpl.html).toContain("</html>");
      expect(tpl.html).toContain('class="container"');
      expect(tpl.html).toContain('class="card"');
      expect(tpl.html).toContain("All rights reserved");
    }
  });
});
