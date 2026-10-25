import { describe, expect, it } from "vitest";
import {
  mobileHistorySearchOutcomeSchema,
  mobileHistorySearchRequestSchema,
} from "../src/mobile-history-search.js";

const request = {
  zcode_type: "mobile-history-search-request" as const,
  requestId: "request-1",
  context: {
    backendId: "backend-1",
    connectionGeneration: 2,
    workspaceKey: "identity-1",
    requestId: "request-1",
  },
  queryGeneration: 4,
  scopeSignature: '["identity-1"]',
  query: "  needle  ",
  includeArchived: false,
  limit: 50,
};

describe("mobile history search contract", () => {
  it("accepts a bounded single-workspace request and trims query", () => {
    expect(mobileHistorySearchRequestSchema.parse(request).query).toBe("needle");
  });

  it("rejects empty, overlong, and unsupported result limits", () => {
    expect(mobileHistorySearchRequestSchema.safeParse({ ...request, query: "  " }).success).toBe(
      false,
    );
    expect(
      mobileHistorySearchRequestSchema.safeParse({ ...request, query: "x".repeat(257) }).success,
    ).toBe(false);
    expect(mobileHistorySearchRequestSchema.safeParse({ ...request, limit: 75 }).success).toBe(
      false,
    );
  });

  it("requires items only for successful outcomes", () => {
    expect(
      mobileHistorySearchOutcomeSchema.safeParse({
        zcode_type: "mobile-history-search-outcome",
        requestId: request.requestId,
        context: request.context,
        queryGeneration: request.queryGeneration,
        scopeSignature: request.scopeSignature,
        status: "ok",
        items: [],
      }).success,
    ).toBe(true);
    expect(
      mobileHistorySearchOutcomeSchema.safeParse({
        zcode_type: "mobile-history-search-outcome",
        requestId: request.requestId,
        context: request.context,
        queryGeneration: request.queryGeneration,
        scopeSignature: request.scopeSignature,
        status: "offline",
        items: [],
      }).success,
    ).toBe(false);
  });
});
