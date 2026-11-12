/**
 * The Truth Engine's audit contract.
 *
 * The engine at i.nspired.cc/engine and the single-file version in
 * `theofficialaicounsel` both talk to `orproxy`'s `/v1/audit`: an
 * OpenAI-shaped stream of `choices[0].delta.content` chunks, plus
 * `/v1/audit/store` and `/v1/audit/<id>` for the saved record. Answering the
 * same shape here is what lets the engine ask `op` instead of the 70B Llama
 * that orproxy was sending its audits to. Nothing in the engine has to change
 * but its base URL.
 */

/** One turn, as the engine sends it. */
export type AuditMessage = {
  readonly role: string;
  readonly content: string;
};

export type AuditRequest = {
  readonly messages: readonly AuditMessage[];
  readonly stream: boolean;
  /** Correlation id for the saved record, when the engine already has one. */
  readonly audit_id?: string;
  /** Preset to run the audit on. The engine does not send one; default `truth`. */
  readonly preset?: string;
};

export type ParsedAudit =
  | { readonly ok: true; readonly request: AuditRequest }
  | { readonly ok: false; readonly message: string };

/** The preset an audit runs on unless the caller names another. */
export const AUDIT_PRESET = "truth";

/**
 * Read the engine's body. Only `messages` matters: the same thing the engine
 * has always posted, so an existing caller needs no change.
 */
export function parseAuditRequest(body: unknown): ParsedAudit {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Send a JSON object with `messages`" };
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.messages)) {
    return { ok: false, message: "`messages` must be an array" };
  }
  const messages: AuditMessage[] = [];
  for (const item of record.messages) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, message: "Every message must be an object" };
    }
    const entry = item as Record<string, unknown>;
    const role = typeof entry.role === "string" ? entry.role.trim() : "";
    const content = typeof entry.content === "string" ? entry.content : "";
    if (!role || !content.trim()) {
      return { ok: false, message: "Every message needs a `role` and non-empty `content`" };
    }
    messages.push({ role, content });
  }
  if (!messages.some((message) => message.role === "user")) {
    return { ok: false, message: "At least one message must be from the user" };
  }

  const auditId =
    typeof record.audit_id === "string" && record.audit_id.trim()
      ? record.audit_id.trim()
      : undefined;
  const preset =
    typeof record.preset === "string" && record.preset.trim()
      ? record.preset.trim()
      : undefined;

  return {
    ok: true,
    request: {
      messages,
      stream: record.stream !== false,
      ...(auditId === undefined ? {} : { audit_id: auditId }),
      ...(preset === undefined ? {} : { preset })
    }
  };
}

/** The newest thing the person asked; earlier turns live in the session. */
export function lastUserMessage(messages: readonly AuditMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].content;
  }
  return "";
}

/**
 * The conversation this audit belongs to, as a pi session name.
 *
 * It is derived from the **first** user message, never from `audit_id`: the
 * engine only learns the audit id after it has stored the first answer, so
 * keying on the id would start a fresh session on turn two and forget the
 * docket that was just read. The id is correlation, not identity.
 */
export async function auditSession(messages: readonly AuditMessage[]): Promise<string> {
  const first = messages.find((message) => message.role === "user")?.content ?? "";
  const bytes = new TextEncoder().encode(first.trim().toLowerCase());
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(hash).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `audit:${hex}`;
}

/**
 * One stream chunk in the shape the engine's reader already parses. The answer
 * arrives whole because the harness answers whole; a single delta is honest
 * about that, and `[DONE]` is what the reader stops on.
 */
export function auditStreamBody(text: string, model?: string): string {
  const chunk = {
    ...(model === undefined ? {} : { model }),
    choices: [{ delta: { content: text } }]
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

/**
 * The engine runs on its own origin and posts here, so every audit response
 * needs CORS. These mirror what orproxy answers today.
 */
export const AUDIT_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Content-Type, Authorization, X-Admin-Secret, x-admin-key",
  "access-control-allow-methods": "POST, GET, PUT, DELETE, OPTIONS",
  "access-control-max-age": "86400"
};

/** An error the engine can show: it reads `error` and `code` off the body. */
export function auditError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: message, code },
    { status, headers: { ...AUDIT_CORS, "cache-control": "no-store" } }
  );
}
