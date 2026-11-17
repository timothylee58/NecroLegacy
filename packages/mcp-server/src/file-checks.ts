import { open, stat } from "node:fs/promises";
import { extname } from "node:path";
import { ToolError } from "./types.js";

export const MAX_TEXT_BYTES = 5_242_880;
export const MAX_IMAGE_BYTES = 10_485_760;

const TEXT_EXTENSIONS = [".dat", ".txt", ".csv", ".cpy"];
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg"];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

export type FileKind = "text" | "image";

export interface CheckedFile {
  path: string;
  name: string;
  kind: FileKind;
  extension: string;
}

const startsWith = (head: Uint8Array, magic: number[]): boolean =>
  head.length >= magic.length && magic.every((b, i) => head[i] === b);

export function signatureMatches(extension: string, head: Uint8Array): boolean {
  const isPng = startsWith(head, PNG_MAGIC);
  const isJpeg = startsWith(head, JPEG_MAGIC);
  if (extension === ".png") return isPng;
  if (extension === ".jpg" || extension === ".jpeg") return isJpeg;
  return !isPng && !isJpeg;
}

async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(8);
    const { bytesRead } = await handle.read(buffer, 0, 8, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Runs every check before any upload so a rejected file never reaches the network. */
export async function checkFile(path: string, parameter: string): Promise<CheckedFile> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new ToolError("file_not_found", `${parameter}: file not found or unreadable.`, [parameter]);
  }
  if (!info.isFile()) {
    throw new ToolError("not_a_regular_file", `${parameter}: path is not a regular file.`, [parameter]);
  }
  const extension = extname(path).toLowerCase();
  const kind: FileKind | null = TEXT_EXTENSIONS.includes(extension)
    ? "text"
    : IMAGE_EXTENSIONS.includes(extension)
      ? "image"
      : null;
  if (!kind) {
    throw new ToolError(
      "unsupported_extension",
      `${parameter}: unsupported extension. Accepted: ${[...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS].join(", ")}.`,
      [parameter],
    );
  }
  // Strict `>` so a file of exactly the limit is accepted.
  if (kind === "text" && info.size > MAX_TEXT_BYTES) {
    throw new ToolError("file_too_large", `${parameter}: text file exceeds the 5 MB limit (5,242,880 bytes).`, [parameter]);
  }
  if (kind === "image" && info.size > MAX_IMAGE_BYTES) {
    throw new ToolError("file_too_large", `${parameter}: image exceeds the 10 MB limit (10,485,760 bytes).`, [parameter]);
  }
  if (!signatureMatches(extension, await readHead(path))) {
    throw new ToolError("signature_mismatch", `${parameter}: file contents do not match the extension.`, [parameter]);
  }
  return { path, name: path.split(/[\\/]/).pop() ?? path, kind, extension };
}
