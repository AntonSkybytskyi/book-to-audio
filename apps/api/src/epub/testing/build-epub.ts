import JSZip from "jszip";

export type FileMap = Record<string, string | Buffer>;

/**
 * Zips a file map into an EPUB container. `mimetype` goes first and is stored
 * uncompressed, as the EPUB spec requires. Test and fixture use only.
 */
export async function zipEpub(files: FileMap, options: { mimetype?: string | null } = {}) {
  const zip = new JSZip();
  const mimetype = options.mimetype === undefined ? "application/epub+zip" : options.mimetype;
  if (mimetype !== null) zip.file("mimetype", mimetype, { compression: "STORE" });
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

export const xhtml = (body: string, title = "Page") =>
  `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n` +
  `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">` +
  `<head><title>${title}</title></head><body>${body}</body></html>`;

export const CONTAINER_XML =
  `<?xml version="1.0"?>` +
  `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
  `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>` +
  `</rootfiles></container>`;
