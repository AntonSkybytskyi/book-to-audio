import { resolveHref } from "./paths.js";
import {
  childElements,
  findElement,
  findElements,
  parseTree,
  textContent,
  type NodeBudget,
  type XmlElement,
} from "./xml.js";

export interface TocEntry {
  title: string;
  /** Entry name of the target document. */
  path: string;
  fragment: string | null;
}

/** EPUB 3 navigation document: the `<nav epub:type="toc">` list, flattened in reading order. */
export function parseNav(xhtml: string, navPath: string, budget?: NodeBudget): TocEntry[] {
  const root = parseTree(xhtml, "html", budget);
  const navs = findElements(root, "nav");
  const toc =
    navs.find((nav) => (nav.attrs["epub:type"] ?? "").split(/\s+/).includes("toc")) ?? navs[0];
  const list = toc && findElement(toc, "ol");
  if (!list) return [];

  const entries: TocEntry[] = [];
  const walkList = (ol: XmlElement) => {
    for (const li of childElements(ol, "li")) {
      const label = childElements(li).find((el) => el.name === "a" || el.name === "span");
      const target = label?.name === "a" ? resolveHref(navPath, label.attrs.href ?? "") : null;
      if (label && target) {
        entries.push({ title: textContent(label), path: target.path, fragment: target.fragment });
      }
      for (const nested of childElements(li, "ol")) walkList(nested);
    }
  };
  walkList(list);
  return entries;
}

/** EPUB 2 NCX: `navMap/navPoint` tree, flattened in document order. */
export function parseNcx(xml: string, ncxPath: string, budget?: NodeBudget): TocEntry[] {
  const navMap = findElement(parseTree(xml, "xml", budget), "navmap");
  if (!navMap) return [];

  const entries: TocEntry[] = [];
  const walk = (parent: XmlElement) => {
    for (const point of childElements(parent, "navpoint")) {
      const label = childElements(point, "navlabel")[0];
      const content = childElements(point, "content")[0];
      const target = content ? resolveHref(ncxPath, content.attrs.src ?? "") : null;
      if (target) {
        entries.push({
          title: label ? textContent(label) : "",
          path: target.path,
          fragment: target.fragment,
        });
      }
      walk(point);
    }
  };
  walk(navMap);
  return entries;
}
