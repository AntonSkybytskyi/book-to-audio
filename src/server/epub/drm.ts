import type { Archive } from "./archive.js";
import { EpubError } from "./errors.js";
import { findElements, parseTree, type NodeBudget } from "./xml.js";

// Font obfuscation is not DRM: the IDPF and Adobe schemes only scramble the
// first bytes of embedded fonts and are used by ordinary books.
const FONT_OBFUSCATION = new Set([
  "http://www.idpf.org/2008/embedding",
  "http://ns.adobe.com/pdf/enc#RC",
]);

const DRM_MESSAGE =
  "This EPUB is protected by DRM, so its text cannot be read. Only DRM-free books are supported.";

/** Throws a `drm` error when the book is encrypted or carries a rights file. */
export async function assertNoDrm(archive: Archive, budget?: NodeBudget): Promise<void> {
  if (archive.has("META-INF/rights.xml")) throw new EpubError("drm", DRM_MESSAGE);

  const xml = await archive.readText("META-INF/encryption.xml");
  if (xml === null) return;

  const encrypted = findElements(parseTree(xml, "xml", budget), "encrypteddata");
  const protectsContent = encrypted.some((data) => {
    const method = findElements(data, "encryptionmethod")[0];
    return !FONT_OBFUSCATION.has(method?.attrs.algorithm ?? "");
  });
  if (protectsContent) throw new EpubError("drm", DRM_MESSAGE);
}
