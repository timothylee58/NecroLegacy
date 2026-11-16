import json
from pathlib import Path

import pytest

from app.services.file_checks import UploadRejection, image_dimensions, iter_chunks, read_bounded, validate_upload

CASES = json.loads((Path(__file__).parents[3] / "web/src/lib/upload-cases.json").read_text())
CODE = {"too_large": "file_too_large"}


@pytest.mark.parametrize("case", CASES)
def test_shared_cases(case):
    head = bytes.fromhex(case["head"])
    if case["expect"] == "ok":
        validate_upload(case["name"], case["size"], head)
        return
    with pytest.raises(UploadRejection) as exc:
        validate_upload(case["name"], case["size"], head)
    assert exc.value.code == CODE.get(case["expect"], case["expect"])


@pytest.mark.parametrize("magic", ["7f454c46", "4d5a", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"])
def test_executables_rejected(magic):
    with pytest.raises(UploadRejection) as exc:
        validate_upload("a.dat", 10, bytes.fromhex(magic) + b"00")
    assert (exc.value.status, exc.value.code) == (415, "binary_executable")


async def test_read_bounded_aborts_early():
    pulled = 0

    async def gen():
        nonlocal pulled
        while True:
            pulled += 1
            yield b"x" * 65536

    with pytest.raises(UploadRejection) as exc:
        await read_bounded(gen(), limit=200_000)
    assert exc.value.status == 413
    assert pulled == 4


async def test_iter_chunks_reads_64k():
    data = [b"a" * 65536, b"b", b""]

    async def read(n):
        assert n == 65536
        return data.pop(0)

    assert [len(c) async for c in iter_chunks(read)] == [65536, 1]


def test_png_dimensions():
    png = bytes.fromhex("89504e470d0a1a0a0000000d49484452") + (1200).to_bytes(4, "big") + (800).to_bytes(4, "big")
    assert image_dimensions(png) == (1200, 800)


def test_jpeg_dimensions():
    jpg = (
        bytes.fromhex("ffd8ffe000104a46494600010100000100010000")
        + bytes.fromhex("ffc0001108")
        + (300).to_bytes(2, "big")
        + (500).to_bytes(2, "big")
        + b"\x03\x00"
    )
    assert image_dimensions(jpg) == (500, 300)


def test_unparseable_dimensions():
    assert image_dimensions(b"hello") is None
