import { describe, it, expect } from "vitest";
import { extractProviderAuthFailure } from "../src/summarize.js";

describe("extractProviderAuthFailure", () => {
  describe("without requireStructuralSignal (error path)", () => {
    it("detects a real 401 status code", () => {
      const err = { status: 401, message: "Unauthorized" };
      const result = extractProviderAuthFailure(err);
      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(401);
    });

    it("detects auth-related text in an error object", () => {
      const err = { message: "authentication failed for model xyz" };
      const result = extractProviderAuthFailure(err);
      expect(result).toBeDefined();
    });

    it("returns undefined for unrelated errors", () => {
      const err = { message: "rate limit exceeded", status: 429 };
      expect(extractProviderAuthFailure(err)).toBeUndefined();
    });
  });

  describe("with requireStructuralSignal (success path)", () => {
    it("detects a real 401 in a CompletionResult", () => {
      const result = {
        content: [{ type: "text", text: "Summary of conversation" }],
        error: { statusCode: 401, message: "Unauthorized" },
      };
      const failure = extractProviderAuthFailure(result, {
        requireStructuralSignal: true,
      });
      expect(failure).toBeDefined();
      expect(failure!.statusCode).toBe(401);
    });

    it("detects provider_auth error kind", () => {
      const result = {
        content: [{ type: "text", text: "Summary" }],
        error: { kind: "provider_auth", message: "bad token" },
      };
      const failure = extractProviderAuthFailure(result, {
        requireStructuralSignal: true,
      });
      expect(failure).toBeDefined();
    });

    it("does NOT treat summary text containing 'auth error' as an auth failure", () => {
      const result = {
        content: [
          {
            type: "text",
            text: "The user debugged a provider auth error. OpenRouter fallback failed due to invalid token. Authentication failed on retry.",
          },
        ],
      };
      const failure = extractProviderAuthFailure(result, {
        requireStructuralSignal: true,
      });
      expect(failure).toBeUndefined();
    });

    it("does NOT treat summary mentioning '401' as an auth failure", () => {
      const result = {
        content: [
          {
            type: "text",
            text: "The API returned a 401 unauthorized error when the user tried to call the endpoint.",
          },
        ],
      };
      const failure = extractProviderAuthFailure(result, {
        requireStructuralSignal: true,
      });
      expect(failure).toBeUndefined();
    });

    it("does NOT false-positive on 'missing scope' in summary content", () => {
      const result = {
        content: [
          {
            type: "text",
            text: "The user investigated missing scope errors in their OAuth setup.",
          },
        ],
      };
      const failure = extractProviderAuthFailure(result, {
        requireStructuralSignal: true,
      });
      expect(failure).toBeUndefined();
    });
  });
});
