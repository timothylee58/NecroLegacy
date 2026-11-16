export const MAX_TEXT_BYTES = 5_242_880;
export const MAX_IMAGE_BYTES = 10_485_760;

export const TEXT_EXTENSIONS = [".dat", ".txt", ".csv", ".cpy"] as const;
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg"] as const;
export const ACCEPTED_EXTENSIONS = [...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS] as const;

export type FileKind = "text" | "image";

export type RejectionCode =
  | "unsupported_extension"
  | "text_too_large"
  | "image_too_large"
  | "signature_mismatch";

export interface Rejection {
  code: RejectionCode;
  message: string;
}

export type ValidationResult =
  | { ok: true; kind: FileKind; extension: string }
  | { ok: false; reason: Rejection };

export const REJECTION_MESSAGES: Record<RejectionCode, string> = {
  unsupported_extension: `Unsupported file type. Accepted extensions: ${ACCEPTED_EXTENSIONS.join(", ")}.`,
  text_too_large: "Text file exceeds the 5 MB size limit (5,242,880 bytes).",
  image_too_large: "Image file exceeds the 10 MB image size limit (10,485,760 bytes).",
  signature_mismatch: "File contents do not match the file extension.",
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

const reject = (code: RejectionCode): ValidationResult => ({
  ok: false,
  reason: { code, message: REJECTION_MESSAGES[code] },
});

export function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

export function classifyExtension(name: string): FileKind | null {
  const ext = getExtension(name);
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) return "text";
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  return null;
}

const startsWith = (bytes: Uint8Array, magic: number[]): boolean =>
  bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

export async function readSignature(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, 8).arrayBuffer());
}

export function signatureMatches(extension: string, head: Uint8Array): boolean {
  const isPng = startsWith(head, PNG_MAGIC);
  const isJpeg = startsWith(head, JPEG_MAGIC);
  if (extension === ".png") return isPng;
  if (extension === ".jpg" || extension === ".jpeg") return isJpeg;
  return !isPng && !isJpeg;
}

export function validateExtensionAndSize(file: { name: string; size: number }): ValidationResult {
  const kind = classifyExtension(file.name);
  if (!kind) return reject("unsupported_extension");
  // Strict `>` so a file of exactly the limit is accepted.
  if (kind === "text" && file.size > MAX_TEXT_BYTES) return reject("text_too_large");
  if (kind === "image" && file.size > MAX_IMAGE_BYTES) return reject("image_too_large");
  return { ok: true, kind, extension: getExtension(file.name) };
}

export async function validateFile(file: File): Promise<ValidationResult> {
  const result = validateExtensionAndSize(file);
  if (!result.ok) return result;
  const head = await readSignature(file);
  if (!signatureMatches(result.extension, head)) return reject("signature_mismatch");
  return result;
}
