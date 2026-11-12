import { describe, expect, it } from "vitest";
import {
  AUDIT_CORS,
  auditError,
  auditSession,
  auditStreamBody,
  lastUserMessage,
  parseAuditRequest
} from "../audit";

const turn = (role: string, content: string) => ({ role, content });

describe("reading the engine's audit body", () => {
  it("accepts the body the engine already sends", () => {
    const parsed = parseAuditRequest({
      messages: [turn("user", "audit this docket")],
      stream: true,
      audit_id: "abc123"
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.messages).toEqual([turn("user", "audit this docket")]);
    expect(parsed.request.audit_id).toBe("abc123");
    expect(parsed.request.stream).toBe(true);
  });

  it("refuses a body with nothing to answer", () => {
    expect(parseAuditRequest({}).ok).toBe(false);
    expect(parseAuditRequest({ messages: [] }).ok).toBe(false);
    expect(parseAuditRequest({ messages: [turn("assistant", "hi")] }).ok).toBe(false);
    expect(parseAuditRequest({ messages: [turn("user", "   ")] }).ok).toBe(false);
    expect(parseAuditRequest(null).ok).toBe(false);
  });

  it("takes a preset only when the caller names one", () => {
    const named = parseAuditRequest({ messages: [turn("user", "x")], preset: " doc " });
    const bare = parseAuditRequest({ messages: [turn("user", "x")] });

    expect(named.ok && named.request.preset).toBe("doc");
    expect(bare.ok && bare.request.preset).toBeUndefined();
  });
});

describe("the audit conversation", () => {
  const messages = [turn("user", "audit this docket"), turn("assistant", "report"), turn("user", "what is the exposure?")];

  it("reads only the newest question, because the rest is in the session", () => {
    expect(lastUserMessage(messages)).toBe("what is the exposure?");
  });

  it("keeps the session when the engine learns the audit id on turn two", async () => {
    // The id only exists after `/store`, so keying on it would forget turn one.
    const first = await auditSession([messages[0]]);
    const second = await auditSession(messages);
    expect(second).toBe(first);
    expect(first.startsWith("audit:")).toBe(true);
  });

  it("separates two different dockets", async () => {
    const one = await auditSession([turn("user", "docket one")]);
    const two = await auditSession([turn("user", "docket two")]);
    expect(one).not.toBe(two);
  });
});

describe("the audit stream", () => {
  it("answers in the shape the engine's reader parses", () => {
    const body = auditStreamBody('He said "no" — a quote.', "@preset/truth");
    const [chunk, done] = body.split("\n\n");

    expect(done.trim()).toBe("data: [DONE]");
    const json = JSON.parse(chunk.replace(/^data: /, ""));
    expect(json.choices[0].delta.content).toBe('He said "no" — a quote.');
    expect(json.model).toBe("@preset/truth");
  });

  it("omits the model rather than inventing one", () => {
    const json = JSON.parse(auditStreamBody("ok").replace(/^data: /, "").split("\n")[0]);
    expect(json).not.toHaveProperty("model");
  });

  it("lets the engine's origin read the answer", () => {
    expect(AUDIT_CORS["access-control-allow-origin"]).toBe("*");
    const response = auditError(502, "audit_failed", "boom");
    expect(response.status).toBe(502);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
