import { describe, expect, it } from "vitest";
import {
  AGENT_ERRORS,
  AGENT_NAME,
  AGENT_PROTOCOL_VERSION,
  agentCard,
  failureBody,
  outgoingHeaders,
  parseAgentRequest,
  PROTOCOL_HEADERS,
  responseHeaders,
  successBody
} from "../agent-protocol";

const noHeaders = new Headers();

describe("the agent protocol", () => {
  it("reads the envelope, taking the sender name and id from headers", () => {
    const headers = new Headers({
      [PROTOCOL_HEADERS.from]: "truth",
      [PROTOCOL_HEADERS.requestId]: "req-1"
    });

    const parsed = parseAgentRequest({ message: "  audit this docket " }, headers);

    expect(parsed).toMatchObject({
      ok: true,
      message: "audit this docket",
      session: "assistant",
      requestId: "req-1",
      from: "truth",
      version: AGENT_PROTOCOL_VERSION,
      plain: false
    });
  });

  it("still accepts a plain body written before the convention", () => {
    const parsed = parseAgentRequest({ message: "hello", preset: "truth" }, noHeaders);

    expect(parsed).toMatchObject({ ok: true, preset: "truth", from: "unknown" });
    if (parsed.ok) expect(parsed.requestId.length).toBeGreaterThan(0);
  });

  it("refuses an empty message, a newer version, and a non-object body", () => {
    const empty = parseAgentRequest({ message: "   " }, noHeaders);
    expect(empty).toMatchObject({ ok: false, code: AGENT_ERRORS.invalidRequest });

    const newer = parseAgentRequest(
      { message: "hi", version: AGENT_PROTOCOL_VERSION + 1 },
      noHeaders
    );
    expect(newer).toMatchObject({ ok: false, code: AGENT_ERRORS.unsupportedVersion });

    const nope = parseAgentRequest(null, noHeaders);
    expect(nope).toMatchObject({ ok: false, code: AGENT_ERRORS.invalidRequest });
  });

  it("answers with one shape, success or failure, and names itself", () => {
    const ok = successBody({
      requestId: "req-2",
      session: "assistant",
      text: "done",
      model: "@preset/truth"
    });
    expect(ok).toMatchObject({
      version: AGENT_PROTOCOL_VERSION,
      request_id: "req-2",
      from: AGENT_NAME,
      ok: true,
      text: "done",
      model: "@preset/truth"
    });

    const failed = failureBody("req-3", AGENT_ERRORS.unknownPreset, "no such preset");
    expect(failed).toMatchObject({
      ok: false,
      from: AGENT_NAME,
      error: { code: AGENT_ERRORS.unknownPreset, message: "no such preset" }
    });

    expect(responseHeaders("req-3")[PROTOCOL_HEADERS.requestId]).toBe("req-3");
    expect(responseHeaders("req-3")[PROTOCOL_HEADERS.version]).toBe(
      String(AGENT_PROTOCOL_VERSION)
    );
  });

  it("sends its own name and the version on every outgoing call", () => {
    const headers = outgoingHeaders("req-4");

    expect(headers[PROTOCOL_HEADERS.from]).toBe(AGENT_NAME);
    expect(headers[PROTOCOL_HEADERS.version]).toBe(String(AGENT_PROTOCOL_VERSION));
    expect(headers[PROTOCOL_HEADERS.requestId]).toBe("req-4");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("describes itself well enough for a caller to configure from the card", () => {
    const card = agentCard("https://harness.example");

    expect(card.name).toBe(AGENT_NAME);
    expect(card.version).toBe(AGENT_PROTOCOL_VERSION);
    expect(card.endpoints.message.path).toBe("/api/assistant");
    expect(Object.values(card.error_codes)).toEqual(
      expect.arrayContaining([AGENT_ERRORS.invalidRequest, AGENT_ERRORS.unknownPreset])
    );
  });
});
