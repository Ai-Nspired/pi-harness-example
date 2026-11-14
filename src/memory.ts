import { Type } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

/** The three tables a note can be filed in, and what each is called. */
export type NoteKind = "preference" | "non_preference" | "hate";

const TABLE: Record<NoteKind, string> = {
  preference: "preferences",
  non_preference: "non_preferences",
  hate: "hates"
};

const LABEL: Record<NoteKind, string> = {
  preference: "preference",
  non_preference: "not a preference",
  hate: "hate"
};

/** Rows read from each table for one prompt. */
const MAX_ROWS = 60;
/** The section stops growing here. */
const MAX_SECTION_CHARS = 8_000;
/** One captured message is cut here, so a pasted docket cannot flood the table. */
const MAX_MESSAGE_CHARS = 8_000;

/**
 * The text of a user input, which pi types as a user message's content: a
 * string, or parts that each may carry `text`.
 */
export function textOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * Record what the owner sent, as sent, before the model sees it. Called by the
 * host on every message: nothing here waits for the model to decide that
 * something was worth keeping.
 */
export async function recordMessage(db: D1Database, text: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed === "") return;
  await db
    .prepare("INSERT INTO messages (text, created_at) VALUES (?, ?)")
    .bind(trimmed.slice(0, MAX_MESSAGE_CHARS), new Date().toISOString())
    .run();
}

type FiledRow = { kind: NoteKind; text: string; created_at: string };
type SaidRow = { text: string; created_at: string };

/** The newest rows across the three tables, newest first. */
async function readFiled(db: D1Database): Promise<FiledRow[]> {
  const { results } = await db
    .prepare(
      `SELECT 'preference' AS kind, text, created_at FROM preferences
       UNION ALL SELECT 'non_preference' AS kind, text, created_at FROM non_preferences
       UNION ALL SELECT 'hate' AS kind, text, created_at FROM hates
       ORDER BY created_at DESC LIMIT ?`
    )
    .bind(MAX_ROWS * 3)
    .all<FiledRow>();
  return Array.isArray(results) ? results : [];
}

/** The newest owner messages, newest first. */
async function readSaid(db: D1Database): Promise<SaidRow[]> {
  const { results } = await db
    .prepare("SELECT text, created_at FROM messages ORDER BY id DESC LIMIT ?")
    .bind(MAX_ROWS)
    .all<SaidRow>();
  return Array.isArray(results) ? results : [];
}

/** What every request starts with: what the owner said, and what was filed. */
function renderSection(filed: readonly FiledRow[], said: readonly SaidRow[]): string | undefined {
  const rows = [
    ...filed.map((row) => ({ at: row.created_at, label: LABEL[row.kind], text: row.text })),
    ...said.map((row) => ({ at: row.created_at, label: "said", text: row.text }))
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (rows.length === 0) return undefined;

  const lines: string[] = ["What the owner has said and what has been filed, newest first."];
  let used = 0;
  let dropped = 0;
  for (const row of rows) {
    const line = `- ${row.label}${row.at ? ` (${row.at.slice(0, 10)})` : ""}: ${row.text}`;
    if (used + line.length > MAX_SECTION_CHARS) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (dropped > 0) lines.push(`(${dropped} older row${dropped === 1 ? "" : "s"} not shown here.)`);
  return lines.join("\n");
}

const RememberParameters = Type.Object({
  kind: Type.Union(
    [Type.Literal("preference"), Type.Literal("non_preference"), Type.Literal("hate")],
    {
      description:
        "preference: something the owner wants. non_preference: something the owner does not want, or a correction. hate: something the owner hates."
    }
  ),
  note: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: "The note, in the owner's own terms. One note per call."
  })
});

/**
 * Memory as a pi-durable extension. The host records every message the owner
 * sends; the model may file a note into one of the three tables. The section
 * reads all four, so a model that files nothing still leaves the owner's own
 * words in front of every later request.
 */
export function createMemoryExtension(db: D1Database): Extension {
  const remember: ToolRegistration<typeof RememberParameters> = {
    name: "remember",
    description:
      "File a note into preferences, non_preferences or hates. The owner's messages are already " +
      "recorded by the harness, so this adds a judgement about one of them; it does not decide " +
      "whether something is kept.",
    parameters: RememberParameters,
    // The same note filed twice leaves two rows, so an interrupted call is
    // reported as interrupted rather than silently rerun.
    replay: "unsafe",
    async execute({ kind, note }) {
      const text = note.trim();
      if (text === "") {
        return {
          output: [{ type: "text" as const, text: "The note was empty, so nothing was filed." }],
          isError: true
        };
      }
      const table = TABLE[kind];
      try {
        await db
          .prepare(`INSERT INTO ${table} (text, created_at) VALUES (?, ?)`)
          .bind(text, new Date().toISOString())
          .run();
      } catch (error) {
        return {
          output: [
            {
              type: "text" as const,
              text: `Could not file that in ${table}: ${error instanceof Error ? error.message : String(error)}`
            }
          ],
          isError: true
        };
      }
      return { output: [{ type: "text" as const, text: `Filed in ${table}.` }] };
    }
  };

  return {
    name: "memory",
    tools: [remember],
    sections: [
      {
        key: "memory",
        tag: false,
        async render() {
          try {
            const [filed, said] = await Promise.all([readFiled(db), readSaid(db)]);
            return renderSection(filed, said);
          } catch {
            // A missing table must not break a request.
            return undefined;
          }
        }
      }
    ]
  };
}
