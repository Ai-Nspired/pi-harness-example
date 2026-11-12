import { strFromU8, unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * Turning an uploaded file into text the model can read. A docket arrives as
 * whatever the court sent — a PDF, a Word file, a plain-text export — and pi
 * takes text, so this is the boundary that has to be honest about what it can
 * read and loud about what it cannot.
 */

/** Files whose bytes are already text, by extension. */
const TEXT_EXTENSION = /\.(txt|md|markdown|csv|tsv|json|jsonl|html?|xml|log|yml|yaml|eml)$/i;

/** A PDF starts with `%PDF-`. */
function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

/** A DOCX is a ZIP, which starts with `PK\x03\x04`. */
function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/**
 * Word records paragraphs in `word/document.xml`; its tags carry the layout, so
 * paragraph ends become newlines and everything else becomes a space.
 */
function documentXmlToText(xml: string): string {
  return xml
    .replace(/<w:p\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Text as UTF-8, refusing bytes that clearly are not text. */
function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const control = [...text.slice(0, 4000)].filter(
    (character) => character.charCodeAt(0) < 9 && character !== "\n" && character !== "\r"
  ).length;
  if (control > 40) {
    throw new Error("that file is not text; upload a PDF, DOCX or TXT");
  }
  return text;
}

/** A filename with any directory the browser sent stripped off. */
export function uploadName(raw: string | null | undefined): string {
  const name = (raw ?? "").split(/[\\/]/).pop()?.trim();
  return name && name.length > 0 ? name.slice(0, 200) : "upload";
}

/** Read one uploaded file as text, by its contents first and its name second. */
export async function extractDocument(
  name: string,
  bytes: Uint8Array
): Promise<string> {
  if (bytes.byteLength === 0) throw new Error("that file is empty");

  if (looksLikePdf(bytes) || /\.pdf$/i.test(name)) {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    const joined = Array.isArray(text) ? text.join("\n\n") : text;
    if (joined.trim().length === 0) {
      throw new Error("that PDF has no text layer, so it is probably a scan");
    }
    return joined.trim();
  }

  if (looksLikeZip(bytes) || /\.docx$/i.test(name)) {
    const files = unzipSync(bytes);
    const document = files["word/document.xml"];
    if (!document) {
      throw new Error("that ZIP is not a Word document; upload PDF, DOCX or TXT");
    }
    const text = documentXmlToText(strFromU8(document));
    if (text.length === 0) throw new Error("that DOCX has no readable text");
    return text;
  }

  if (TEXT_EXTENSION.test(name) || !/\.[a-z0-9]{1,5}$/i.test(name)) {
    return decodeText(bytes);
  }

  // No known extension: accept it only when its bytes read as text.
  return decodeText(bytes);
}
