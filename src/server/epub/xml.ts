import { Parser } from "htmlparser2";
import { EpubError } from "./errors.js";

export interface XmlElement {
  /** Lower-case local name, without any namespace prefix. */
  name: string;
  /** Lower-case attribute names, prefixes kept (`epub:type`, `xml:lang`). */
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

export const isElement = (node: XmlNode): node is XmlElement => typeof node !== "string";

// Deeper nesting is flattened into the deepest kept element, so the recursive
// walkers over the tree cannot be pushed past the call stack by a hostile file.
const MAX_DEPTH = 256;

// Real books nest a few dozen levels. The HTML parser keeps its open tags in an
// array it shifts on every open, so hundreds of thousands of levels take minutes.
const MAX_NESTING = 2000;

/**
 * Counts the nodes built from one book, so a few kilobytes of `<i/>` repeated
 * cannot grow into gigabytes of objects. Throws `unsafe_archive` over the caps.
 */
export class NodeBudget {
  private total = 0;

  constructor(
    private readonly perDocument = 500_000,
    private readonly perBook = 5_000_000,
  ) {}

  /** Starts counting a new document; call the result once per node. */
  document(): () => void {
    let inDocument = 0;
    return () => {
      if (++inDocument > this.perDocument || ++this.total > this.perBook) {
        throw new EpubError("unsafe_archive", "This EPUB was rejected because it is too complex.");
      }
    };
  }
}

/**
 * Parses XML (OPF, NCX, container) or tolerant XHTML/HTML into a small tree.
 * htmlparser2 only decodes the predefined and numeric entities and ignores
 * DOCTYPE declarations, so external entities are never resolved.
 */
export function parseTree(
  source: string,
  mode: "xml" | "html",
  budget: NodeBudget = new NodeBudget(),
): XmlElement {
  const count = budget.document();
  const root: XmlElement = { name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let overflow = 0;

  const parser = new Parser(
    {
      onopentag(rawName, rawAttrs) {
        count();
        if (stack.length + overflow > MAX_NESTING) {
          throw new EpubError(
            "unsafe_archive",
            "This EPUB was rejected because it is nested too deeply.",
          );
        }
        if (stack.length > MAX_DEPTH) {
          overflow++;
          return;
        }
        const attrs: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawAttrs)) attrs[key.toLowerCase()] = value;
        const element: XmlElement = { name: localName(rawName), attrs, children: [] };
        stack.at(-1)?.children.push(element);
        stack.push(element);
      },
      onclosetag() {
        if (overflow > 0) overflow--;
        else if (stack.length > 1) stack.pop();
      },
      ontext(text) {
        const children = stack.at(-1)?.children;
        if (!children) return;
        // Entities arrive as separate runs; merge them into one string node.
        const last = children.at(-1);
        if (typeof last === "string") children[children.length - 1] = last + text;
        else {
          count();
          children.push(text);
        }
      },
    },
    mode === "xml"
      ? { xmlMode: true, decodeEntities: true }
      : { xmlMode: false, decodeEntities: true, recognizeSelfClosing: true },
  );
  parser.write(source);
  parser.end();
  return root;
}

function localName(name: string): string {
  const colon = name.indexOf(":");
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

/** Direct child elements, optionally filtered by local name. */
export function childElements(element: XmlElement, name?: string): XmlElement[] {
  return element.children.filter(
    (c): c is XmlElement => isElement(c) && (!name || c.name === name),
  );
}

/** First descendant element with this local name, depth first. */
export function findElement(element: XmlElement, name: string): XmlElement | null {
  for (const child of element.children) {
    if (!isElement(child)) continue;
    if (child.name === name) return child;
    const found = findElement(child, name);
    if (found) return found;
  }
  return null;
}

/** Every descendant element with this local name, in document order. */
export function findElements(element: XmlElement, name: string, out: XmlElement[] = []) {
  for (const child of element.children) {
    if (!isElement(child)) continue;
    if (child.name === name) out.push(child);
    findElements(child, name, out);
  }
  return out;
}

/** All text below an element, whitespace collapsed. */
export function textContent(element: XmlElement): string {
  const parts: string[] = [];
  const visit = (node: XmlNode) => {
    if (isElement(node)) node.children.forEach(visit);
    else parts.push(node);
  };
  element.children.forEach(visit);
  return parts.join("").replace(/\s+/g, " ").trim();
}
