import struct
from collections.abc import AsyncIterable
from dataclasses import dataclass
from typing import Literal

MAX_TEXT_BYTES = 5_242_880
MAX_IMAGE_BYTES = 10_485_760
MAX_PIXELS = 40_000_000
CHUNK_SIZE = 64 * 1024

TEXT_EXTENSIONS = (".dat", ".txt", ".csv", ".cpy")
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg")

PNG_MAGIC = bytes.fromhex("89504e470d0a1a0a")
JPEG_MAGIC = bytes.fromhex("ffd8ff")
EXECUTABLE_MAGICS = (
    bytes.fromhex("7f454c46"),
    bytes.fromhex("4d5a"),
    bytes.fromhex("feedface"),
    bytes.fromhex("feedfacf"),
    bytes.fromhex("cefaedfe"),
    bytes.fromhex("cffaedfe"),
    bytes.fromhex("cafebabe"),
)

FileKind = Literal["text", "image"]


@dataclass(frozen=True)
class UploadRejection(Exception):
    status: int
    code: str
    message: str


def _extension(name: str) -> str:
    dot = name.rfind(".")
    return name[dot:].lower() if dot >= 0 else ""


def classify_extension(name: str) -> FileKind:
    ext = _extension(name)
    if ext in TEXT_EXTENSIONS:
        return "text"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    raise UploadRejection(
        415,
        "unsupported_extension",
        f"Unsupported file type. Accepted extensions: {', '.join(TEXT_EXTENSIONS + IMAGE_EXTENSIONS)}.",
    )


def validate_upload(filename: str, size: int, head: bytes) -> FileKind:
    kind = classify_extension(filename)
    # Strict `>` so a file of exactly the limit passes.
    if size > (MAX_TEXT_BYTES if kind == "text" else MAX_IMAGE_BYTES):
        raise UploadRejection(413, "file_too_large", "File exceeds the size limit for its type.")
    if any(head.startswith(m) for m in EXECUTABLE_MAGICS):
        raise UploadRejection(415, "binary_executable", "Executable binaries are not accepted.")
    ext = _extension(filename)
    is_png = head.startswith(PNG_MAGIC)
    is_jpeg = head.startswith(JPEG_MAGIC)
    if ext == ".png":
        ok = is_png
    elif ext in (".jpg", ".jpeg"):
        ok = is_jpeg
    else:
        ok = not is_png and not is_jpeg
    if not ok:
        raise UploadRejection(415, "signature_mismatch", "File contents do not match the file extension.")
    return kind


async def read_bounded(chunks: AsyncIterable[bytes], limit: int = MAX_IMAGE_BYTES) -> bytes:
    """Aborts as soon as the running total passes `limit`, so oversize bodies are never fully buffered."""
    buf = bytearray()
    async for chunk in chunks:
        buf.extend(chunk)
        if len(buf) > limit:
            raise UploadRejection(413, "file_too_large", "File exceeds the size limit.")
    return bytes(buf)


async def iter_chunks(read, chunk_size: int = CHUNK_SIZE):  # type: ignore[no-untyped-def]
    while chunk := await read(chunk_size):
        yield chunk


def image_dimensions(data: bytes) -> tuple[int, int] | None:
    """Header-only parse so a decompression bomb is rejected before any decode."""
    if data.startswith(PNG_MAGIC):
        if len(data) < 24 or data[12:16] != b"IHDR":
            return None
        w, h = struct.unpack(">II", data[16:24])
        return w, h
    if data.startswith(JPEG_MAGIC):
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7 or marker == 0xFF:
                i += 1 if marker == 0xFF else 2
                continue
            seg_len = struct.unpack(">H", data[i + 2 : i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                return w, h
            i += 2 + seg_len
    return None
