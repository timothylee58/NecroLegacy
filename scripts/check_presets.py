#!/usr/bin/env python3
"""Fails when a built-in preset carries personal-looking data or the PNG has metadata or is malformed."""
import re
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
FORBIDDEN_CHUNKS = {b"eXIf", b"tEXt", b"iTXt", b"zTXt"}
MAX_IMAGE_BYTES = 10_485_760
MIN_WIDTH = 1_000

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE = re.compile(
    r"\(\d{3}\)\s?\d{3}-\d{4}|(?<!\d)\d{3}[-.]\d{3}[-.]\d{4}(?!\d)|\+\d{1,3}[ -]\d{2,4}[ -]\d{3,4}[ -]\d{3,4}"
)
SSN = re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)")
CARD = re.compile(r"(?<![\d-])(?:\d{13,19}|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7})(?![\d-])")


def luhn_valid(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n = n * 2 - 9 if n * 2 > 9 else n * 2
        total += n
    return total % 10 == 0


def scan_text(text: str) -> list[str]:
    kinds: list[str] = []
    if EMAIL.search(text):
        kinds.append("email address")
    if PHONE.search(text):
        kinds.append("phone number")
    if SSN.search(text):
        kinds.append("SSN pattern")
    for match in CARD.finditer(text):
        digits = re.sub(r"\D", "", match.group(0))
        if 13 <= len(digits) <= 19 and luhn_valid(digits):
            kinds.append("Luhn-valid card number")
            break
    return kinds


def check_png(data: bytes) -> list[str]:
    if not data.startswith(PNG_SIGNATURE):
        return ["not a PNG (bad signature)"]
    if len(data) > MAX_IMAGE_BYTES:
        return ["PNG is larger than 10 MB"]
    problems: list[str] = []
    pos, width, seen_end = len(PNG_SIGNATURE), 0, False
    while pos + 12 <= len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        crc = data[pos + 8 + length : pos + 12 + length]
        if len(body) != length or len(crc) != 4 or struct.pack(">I", zlib.crc32(kind + body)) != crc:
            return [*problems, f"corrupt PNG chunk {kind.decode('latin1')}"]
        if kind in FORBIDDEN_CHUNKS:
            problems.append(f"PNG metadata chunk {kind.decode()} present")
        if kind == b"IHDR":
            (width,) = struct.unpack(">I", body[:4])
        if kind == b"IEND":
            seen_end = True
            break
        pos += 12 + length
    if not seen_end:
        problems.append("PNG has no IEND chunk")
    if width < MIN_WIDTH:
        problems.append(f"PNG is {width} px wide, need at least {MIN_WIDTH}")
    return problems


def ocr_text(data: bytes) -> list[str] | None:
    """Returns OCR text of every cell, or None when no OCR engine is installed here."""
    sys.path.insert(0, str(ROOT / "apps/api"))
    try:
        from app.services import vision
    except ImportError:
        return None
    for engine in ("tesseract", "paddleocr"):
        try:
            result = vision.analyze(data, engine)
        except Exception:
            continue
        if result.engine is not None:
            return [cell.text for cell in result.cells]
    return None


def check(root: Path, ocr: bool = True) -> list[str]:
    problems: list[str] = []
    dumps = root / "sample-dumps"
    for path in sorted(dumps.iterdir()) if dumps.is_dir() else []:
        if path.suffix.lower() == ".png":
            data = path.read_bytes()
            problems += [f"{path.name}: {p}" for p in check_png(data)]
            texts = ocr_text(data) if ocr else None
            if texts is None and ocr:
                print(f"{path.name}: no OCR engine available, OCR text scan skipped", file=sys.stderr)
            for kind in scan_text("\n".join(texts or [])):
                problems.append(f"{path.name}: OCR text contains {kind}")
        elif path.is_file():
            problems += [f"{path.name}: contains {k}" for k in scan_text(path.read_text(errors="replace"))]
    return problems


def main() -> int:
    problems = check(ROOT)
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
