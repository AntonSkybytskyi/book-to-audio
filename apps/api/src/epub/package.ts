import type { Archive } from "./archive.js";
import { EpubError } from "./errors.js";
import { resolveHref } from "./paths.js";
import {
  childElements,
  findElement,
  findElements,
  parseTree,
  textContent,
  type NodeBudget,
} from "./xml.js";

export interface ManifestItem {
  id: string;
  /** Entry name inside the archive. */
  path: string;
  mediaType: string;
  properties: string[];
}

export interface PackageDocument {
  opfPath: string;
  title: string | null;
  author: string | null;
  language: string | null;
  /** Spine items in reading order that resolve to a manifest entry. */
  spine: ManifestItem[];
  /** EPUB 3 navigation document. */
  nav: ManifestItem | null;
  /** EPUB 2 NCX. */
  ncx: ManifestItem | null;
  cover: ManifestItem | null;
}

const NOT_EPUB = "This file is not a valid EPUB.";

/** Reads `META-INF/container.xml` and the package document it points to. */
export async function readPackage(archive: Archive, budget?: NodeBudget): Promise<PackageDocument> {
  const containerXml = await archive.readText("META-INF/container.xml");
  if (containerXml === null) {
    throw new EpubError("not_epub", `${NOT_EPUB} It has no META-INF/container.xml.`);
  }
  const rootfile = findElements(parseTree(containerXml, "xml", budget), "rootfile").find(
    (el) => el.attrs["full-path"],
  );
  const opfPath = rootfile && resolveHref("container.xml", rootfile.attrs["full-path"] ?? "");
  if (!opfPath) throw new EpubError("not_epub", `${NOT_EPUB} Its package document is missing.`);

  const opfXml = await archive.readText(opfPath.path);
  if (opfXml === null)
    throw new EpubError("not_epub", `${NOT_EPUB} Its package document is missing.`);
  const opf = parseTree(opfXml, "xml", budget);

  const manifest = new Map<string, ManifestItem>();
  for (const el of findElements(opf, "item")) {
    const { id, href } = el.attrs;
    const resolved = id && href ? resolveHref(opfPath.path, href) : null;
    if (!id || !resolved) continue;
    manifest.set(id, {
      id,
      path: resolved.path,
      mediaType: (el.attrs["media-type"] ?? "").toLowerCase(),
      properties: (el.attrs.properties ?? "").split(/\s+/).filter(Boolean),
    });
  }

  const spineEl = findElement(opf, "spine");
  const spine = childElements(spineEl ?? opf, "itemref")
    .map((ref) => manifest.get(ref.attrs.idref ?? ""))
    .filter((item): item is ManifestItem => item !== undefined);

  const items = [...manifest.values()];
  const ncxId = spineEl?.attrs.toc;
  const ncx =
    (ncxId ? manifest.get(ncxId) : undefined) ??
    items.find((i) => i.mediaType === "application/x-dtbncx+xml") ??
    null;

  const metadata = findElement(opf, "metadata");
  const dc = (name: string) =>
    metadata
      ? findElements(metadata, name)
          .map(textContent)
          .filter((text) => text.length > 0)
      : [];

  return {
    opfPath: opfPath.path,
    title: dc("title")[0] ?? null,
    author: dc("creator").join(", ") || null,
    language: dc("language")[0] ?? null,
    spine,
    nav: items.find((i) => i.properties.includes("nav")) ?? null,
    ncx,
    cover: findCover(opf, manifest),
  };
}

function findCover(opf: ReturnType<typeof parseTree>, manifest: Map<string, ManifestItem>) {
  const items = [...manifest.values()];
  const isImage = (item: ManifestItem | undefined): item is ManifestItem =>
    item !== undefined && item.mediaType.startsWith("image/");

  const epub3 = items.find((i) => i.properties.includes("cover-image"));
  if (isImage(epub3)) return epub3;

  // EPUB 2: <meta name="cover" content="manifest-id"/>
  const meta = findElements(opf, "meta").find((el) => el.attrs.name === "cover");
  const epub2 = meta?.attrs.content ? manifest.get(meta.attrs.content) : undefined;
  if (isImage(epub2)) return epub2;

  return items.find((i) => isImage(i) && /^cover(-?image)?$/i.test(i.id)) ?? null;
}
