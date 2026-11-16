import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  classifyExtension,
  signatureMatches,
  validateExtensionAndSize,
  validateFile,
} from "./file-validation";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];

function makeFile(name: string, bytes: number[]): File {
  const blob = new Blob([new Uint8Array(bytes)]);
  const file = new File([blob], name);
  // jsdom's Blob lacks arrayBuffer(); the validator only needs slice().arrayBuffer().
  if (typeof (blob as Blob).arrayBuffer !== "function") {
    const slice = (start?: number, end?: number) => {
      const part = new Uint8Array(bytes.slice(start, end));
      return { arrayBuffer: async () => part.buffer } as unknown as Blob;
    };
    Object.defineProperty(file, "slice", { value: slice });
  }
  return file;
}

describe("extension validation (Req 1.1, 1.2)", () => {
  it.each([
    ["ledger.DAT", "text"],
    ["notes.TxT", "text"],
    ["data.CSV", "text"],
    ["layout.Cpy", "text"],
    ["scan.PNG", "image"],
    ["scan.JpG", "image"],
    ["scan.JPEG", "image"],
  ])("accepts %s as %s regardless of case", (name, kind) => {
    const result = validateExtensionAndSize({ name, size: 1 });
    expect(result).toEqual({ ok: true, kind, extension: name.slice(name.lastIndexOf(".")).toLowerCase() });
  });

  it.each(["virus.exe", "archive.zip", "noextension", "photo.gif", "file.dat.bak", "file."])(
    "rejects %s as unsupported_extension",
    (name) => {
      const result = validateExtensionAndSize({ name, size: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason.code).toBe("unsupported_extension");
        expect(result.reason.message).toMatch(/\.dat.*\.txt.*\.csv.*\.cpy.*\.png.*\.jpg.*\.jpeg/);
      }
    },
  );

  it("classifies by the last extension only", () => {
    expect(classifyExtension("a.png.txt")).toBe("text");
  });
});

describe("size limits (Req 1.5, 1.6)", () => {
  it("accepts a text file of exactly 5,242,880 bytes", () => {
    expect(MAX_TEXT_BYTES).toBe(5_242_880);
    expect(validateExtensionAndSize({ name: "a.dat", size: MAX_TEXT_BYTES }).ok).toBe(true);
  });

  it("rejects a text file of 5,242,881 bytes", () => {
    const result = validateExtensionAndSize({ name: "a.TXT", size: MAX_TEXT_BYTES + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("text_too_large");
      expect(result.reason.message).toContain("5 MB");
    }
  });

  it("accepts an image of exactly 10,485,760 bytes", () => {
    expect(MAX_IMAGE_BYTES).toBe(10_485_760);
    expect(validateExtensionAndSize({ name: "a.png", size: MAX_IMAGE_BYTES }).ok).toBe(true);
    expect(validateExtensionAndSize({ name: "a.JPG", size: MAX_IMAGE_BYTES }).ok).toBe(true);
  });

  it("rejects an image of 10,485,761 bytes", () => {
    const result = validateExtensionAndSize({ name: "a.jpeg", size: MAX_IMAGE_BYTES + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("image_too_large");
      expect(result.reason.message).toContain("10 MB");
    }
  });

  it("applies the text limit, not the image limit, to text files", () => {
    const size = MAX_TEXT_BYTES + 1;
    expect(validateExtensionAndSize({ name: "a.csv", size }).ok).toBe(false);
    expect(validateExtensionAndSize({ name: "a.png", size }).ok).toBe(true);
  });
});

describe("signature checks (Req 1.8)", () => {
  it("accepts matching PNG and JPEG signatures", async () => {
    expect((await validateFile(makeFile("a.png", [...PNG, 0]))).ok).toBe(true);
    expect((await validateFile(makeFile("a.JPG", JPEG))).ok).toBe(true);
    expect((await validateFile(makeFile("a.jpeg", JPEG))).ok).toBe(true);
  });

  it("rejects a .png without PNG magic bytes", async () => {
    for (const bytes of [JPEG, [0x00, 0x01, 0x02, 0x03], PNG.slice(0, 7)]) {
      const result = await validateFile(makeFile("a.png", bytes));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.code).toBe("signature_mismatch");
    }
  });

  it("rejects .jpg/.jpeg without JPEG magic bytes", async () => {
    for (const name of ["a.jpg", "a.JPEG"]) {
      for (const bytes of [PNG, [0xff, 0xd8, 0x00]]) {
        const result = await validateFile(makeFile(name, bytes));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason.code).toBe("signature_mismatch");
      }
    }
  });

  it("rejects text files that begin with PNG or JPEG magic bytes", async () => {
    for (const name of ["a.dat", "a.TXT", "a.csv", "a.cpy"]) {
      for (const bytes of [PNG, JPEG]) {
        const result = await validateFile(makeFile(name, bytes));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason.code).toBe("signature_mismatch");
      }
    }
  });

  it("accepts plain text and empty text files", async () => {
    expect((await validateFile(makeFile("a.txt", [0x48, 0x69]))).ok).toBe(true);
    expect((await validateFile(makeFile("a.dat", []))).ok).toBe(true);
  });

  it("reports extension errors before reading the signature", async () => {
    const result = await validateFile(makeFile("a.gif", PNG));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("unsupported_extension");
  });

  it("signatureMatches handles short buffers", () => {
    expect(signatureMatches(".png", new Uint8Array([0x89]))).toBe(false);
    expect(signatureMatches(".txt", new Uint8Array([]))).toBe(true);
  });
});
