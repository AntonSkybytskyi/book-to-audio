import {
  isElement,
  parseTree,
  textContent,
  type NodeBudget,
  type XmlElement,
  type XmlNode,
} from "./xml.js";

export interface ExtractedDocument {
  /** Cleaned paragraphs in reading order. None is empty. */
  paragraphs: string[];
  /** Element id (or `<a name>`) to the index of the paragraph that starts there. */
  anchors: Map<string, number>;
  /** Text of the first h1 to h3, else the `<title>`. */
  heading: string | null;
}

// Not read aloud, together with everything inside them.
const SKIPPED = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "img",
  "image",
  "picture",
  "figure",
  "figcaption",
  "table",
  "nav",
  "audio",
  "video",
  "canvas",
  "iframe",
  "object",
  "embed",
  "select",
  "button",
  "input",
  "textarea",
]);

const BLOCKS = new Set([
  "p",
  "div",
  "section",
  "article",
  "aside",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "footer",
  "main",
  "hr",
  "br",
  "address",
  "details",
  "summary",
  "center",
]);

const NOTE_TYPES = new Set([
  "noteref",
  "footnote",
  "footnotes",
  "endnote",
  "endnotes",
  "rearnote",
  "rearnotes",
]);
const NOTE_ROLES = new Set([
  "doc-noteref",
  "doc-footnote",
  "doc-footnotes",
  "doc-endnote",
  "doc-endnotes",
]);
const NOTE_CLASSES = new Set(["noteref", "footnote", "footnoteref", "endnote", "fnref"]);

const tokens = (value: string | undefined) =>
  (value ?? "").toLowerCase().split(/\s+/).filter(Boolean);

/** Footnote content or the marker that points at it. */
function isNote(el: XmlElement): boolean {
  return (
    tokens(el.attrs["epub:type"]).some((t) => NOTE_TYPES.has(t)) ||
    tokens(el.attrs.role).some((t) => NOTE_ROLES.has(t)) ||
    tokens(el.attrs.class).some((t) => NOTE_CLASSES.has(t))
  );
}

const containsLink = (el: XmlElement): boolean =>
  el.children.some((c) => isElement(c) && (c.name === "a" || containsLink(c)));

/** Turns an XHTML content document into paragraphs of plain, speakable text. */
export function extractText(html: string, budget?: NodeBudget): ExtractedDocument {
  const root = parseTree(html, "html", budget);
  const paragraphs: string[] = [];
  const anchors = new Map<string, number>();
  let heading: string | null = null;
  let buffer = "";

  const flush = () => {
    const paragraph = cleanParagraph(buffer);
    buffer = "";
    if (paragraph) paragraphs.push(paragraph);
  };

  const visit = (node: XmlNode) => {
    if (!isElement(node)) {
      buffer += node;
      return;
    }
    const id = node.attrs.id ?? (node.name === "a" ? node.attrs.name : undefined);
    if (id && !anchors.has(id)) anchors.set(id, paragraphs.length);

    if (SKIPPED.has(node.name) || "hidden" in node.attrs || isNote(node)) return;
    if (node.name === "sup" && containsLink(node)) return;

    const block = BLOCKS.has(node.name);
    if (block) flush();
    if (/^h[1-3]$/.test(node.name) && heading === null) {
      const text = cleanParagraph(textContent(node));
      if (text) heading = text;
    }
    node.children.forEach(visit);
    if (block) flush();
  };
  visit(root);
  flush();

  if (heading === null) {
    const title = findTitle(root);
    if (title) heading = title;
  }
  return { paragraphs, anchors, heading };
}

function findTitle(root: XmlElement): string | null {
  // Depth first in document order, with an index based stack (no spreads, linear time).
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    if (node.name === "title") return cleanParagraph(textContent(node)) || null;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child !== undefined && isElement(child)) stack.push(child);
    }
  }
  return null;
}

/**
 * Collapses whitespace, drops invisible characters and `[12]` style note
 * markers, and returns "" for runs with nothing to read (for example `* * *`).
 */
export function cleanParagraph(raw: string): string {
  const text = raw
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
    // Collapse first: a leading `\s*` in the marker pattern is quadratic on long blanks.
    .replace(/\s+/g, " ")
    .replace(/ ?\[\d{1,3}\]/g, "")
    .trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}
