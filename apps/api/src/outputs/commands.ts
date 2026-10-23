/** Arguments of the ffmpeg and ffprobe runs that make the downloads. Always passed as an array, never through a shell. */

// No reading from the terminal, and only plain files: a playlist or a URL inside a file cannot make ffmpeg fetch anything.
const QUIET = [
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-nostats",
  "-protocol_whitelist",
  "file",
];
const PROBE = ["-v", "error", "-protocol_whitelist", "file"];

export interface M4bArgs {
  listPath: string;
  metadataPath: string;
  /** A JPEG or PNG file, or null for a book with no cover. */
  coverPath: string | null;
  bitrate: string;
  outputPath: string;
}

/**
 * Decodes the chapter files in `listPath` one after the other and encodes them as mono AAC in an
 * M4A-brand MP4 (`-f ipod`, which Apple Books and other players treat as an audiobook), with the
 * chapters and tags of the ffmetadata file and, if there is one, the cover as an attached picture.
 * `-progress pipe:1` reports how much has been encoded.
 */
export function buildM4bArgs(input: M4bArgs): string[] {
  const hasCover = input.coverPath !== null;
  const metadataInput = hasCover ? 2 : 1;
  return [
    ...QUIET,
    "-progress",
    "pipe:1",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    input.listPath,
    // The cover is a JPEG that was made here; it is read as a JPEG and nothing else.
    ...(hasCover ? ["-f", "jpeg_pipe", "-i", input.coverPath as string] : []),
    "-f",
    "ffmetadata",
    "-i",
    input.metadataPath,
    "-map",
    "0:a",
    ...(hasCover ? ["-map", "1:v"] : []),
    "-map_metadata",
    String(metadataInput),
    "-map_chapters",
    String(metadataInput),
    "-c:a",
    "aac",
    "-b:a",
    input.bitrate,
    "-ac",
    "1",
    ...(hasCover ? ["-c:v", "copy", "-disposition:v:0", "attached_pic"] : []),
    "-f",
    "ipod",
    "-movflags",
    "+faststart",
    "-y",
    input.outputPath,
  ];
}

export interface TagArgs {
  inputPath: string;
  outputPath: string;
  title: string;
  artist: string | null;
  album: string;
  track: number;
}

/**
 * Copies a chapter's Opus packets into a new WebM with the tags set, and no other tags: nothing
 * is decoded or encoded, so the audio is byte for byte what the player got. Tag values are single
 * arguments, so no escaping is needed.
 */
export function buildTagArgs(input: TagArgs): string[] {
  return [
    ...QUIET,
    "-i",
    input.inputPath,
    "-map",
    "0:a",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-c",
    "copy",
    "-metadata",
    `title=${input.title}`,
    ...(input.artist ? ["-metadata", `artist=${input.artist}`] : []),
    "-metadata",
    `album=${input.album}`,
    "-metadata",
    `track=${input.track}`,
    "-f",
    "webm",
    "-y",
    input.outputPath,
  ];
}

/** Reads the length and the audio stream of a file as JSON. */
export const buildProbeArgs = (filePath: string): string[] => [
  ...PROBE,
  "-show_entries",
  "format=duration:stream=codec_type,codec_name,channels",
  "-of",
  "json",
  filePath,
];

/**
 * The start and length of the audio packets from `fromSeconds` on, one `pts,duration,` line each.
 * The last line says where the audio really ends. Starting near the end keeps this short for a long
 * chapter; a file too short to seek in is simply read from the start.
 */
export const buildPacketsArgs = (filePath: string, fromSeconds: number): string[] => [
  ...PROBE,
  "-read_intervals",
  `${Math.max(0, fromSeconds).toFixed(3)}%`,
  "-select_streams",
  "a:0",
  "-show_entries",
  "packet=pts_time,duration_time",
  "-of",
  "csv=p=0",
  filePath,
];

/** Where the audio ends according to the last line of `buildPacketsArgs` output, in seconds, or null if it is not a packet line. */
export function packetLineEnd(line: string): number | null {
  const [pts, duration] = line.split(",").map(Number);
  return pts !== undefined && duration !== undefined && Number.isFinite(pts + duration)
    ? pts + duration
    : null;
}

/** Most pixels ffmpeg may decode for a cover; the same cap `image.ts` checks the header against. */
const COVER_MAX_PIXELS = "50000000";

/**
 * Turns a cover into a JPEG of one frame, at most 1400 px wide, in a pixel format every player
 * reads. `inputFormat` is the one demuxer that may read the file (`image.ts` found out which),
 * so a file that only claims to be a picture is not opened as a video or a playlist; the size cap
 * is checked by the decoder as well.
 */
export const buildCoverConvertArgs = (
  inputFormat: string,
  inputPath: string,
  outputPath: string,
): string[] => [
  ...QUIET,
  "-f",
  inputFormat,
  "-max_pixels",
  COVER_MAX_PIXELS,
  "-i",
  inputPath,
  "-frames:v",
  "1",
  "-vf",
  "scale='min(1400,iw)':-2",
  "-pix_fmt",
  "yuvj420p",
  "-q:v",
  "2",
  "-f",
  "mjpeg",
  "-y",
  outputPath,
];

/**
 * Reads ffmpeg's `-progress` report as it streams in (a chunk can end in the middle of a line) and
 * says how many seconds have been encoded so far.
 */
export class ProgressReader {
  private pending = "";
  /** Seconds encoded so far; 0 until ffmpeg says. */
  seconds = 0;

  /** Takes the next piece of the report and returns the seconds encoded so far. */
  feed(chunk: Buffer): number {
    const lines = (this.pending + chunk.toString("utf8")).split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = /^out_time_us=(\d+)$/.exec(line.trim());
      if (match?.[1]) this.seconds = Number(match[1]) / 1_000_000;
    }
    return this.seconds;
  }
}
