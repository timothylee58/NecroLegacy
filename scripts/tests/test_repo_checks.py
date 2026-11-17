import json
import struct
import subprocess
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import check_kiro_ignore
import check_manifests
import check_presets
import check_readme_env

CARD_VALID = "4539578763621486"
CARD_INVALID = "4539578763621487"


def chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def png(width: int = 1200, extra: bytes = b"") -> bytes:
    ihdr = struct.pack(">IIBBBBB", width, 4, 8, 0, 0, 0, 0)
    idat = zlib.compress(b"\x00" * (width + 1) * 4)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + extra + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def test_luhn_valid_card_is_flagged_and_invalid_is_not() -> None:
    assert "Luhn-valid card number" in check_presets.scan_text(f"card {CARD_VALID} end")
    assert check_presets.scan_text(f"card {CARD_INVALID} end") == []
    assert "Luhn-valid card number" in check_presets.scan_text("4539 5787 6362 1486")


def test_ledger_style_digit_runs_are_not_cards() -> None:
    assert check_presets.scan_text("JE 000003 A01120 19940110 7779.25") == []


def test_email_phone_ssn_patterns() -> None:
    assert check_presets.scan_text("a.b@example.com") == ["email address"]
    assert check_presets.scan_text("call (555) 123-4567") == ["phone number"]
    assert check_presets.scan_text("id 123-45-6789") == ["SSN pattern"]


def test_png_checks(tmp_path: Path) -> None:
    assert check_presets.check_png(png()) == []
    assert any("wide" in p for p in check_presets.check_png(png(width=999)))
    assert any("tEXt" in p for p in check_presets.check_png(png(extra=chunk(b"tEXt", b"k\x00v"))))
    assert any("eXIf" in p for p in check_presets.check_png(png(extra=chunk(b"eXIf", b"II"))))
    assert any("signature" in p for p in check_presets.check_png(b"nope"))
    corrupt = bytearray(png())
    corrupt[20] ^= 0xFF
    assert any("corrupt" in p for p in check_presets.check_png(bytes(corrupt)))


def test_presets_report_file_names(tmp_path: Path) -> None:
    dumps = tmp_path / "sample-dumps"
    dumps.mkdir()
    (dumps / "bad.txt").write_text(f"x {CARD_VALID}")
    (dumps / "good.txt").write_text("nothing here")
    (dumps / "img.png").write_bytes(png())
    problems = check_presets.check(tmp_path, ocr=False)
    assert problems == ["bad.txt: contains Luhn-valid card number"]


def write_manifests(root: Path, requirements: str, package: dict | None = None) -> None:
    (root / "apps/api").mkdir(parents=True)
    (root / "apps/api/requirements.txt").write_text(requirements)
    (root / "package.json").write_text(json.dumps(package or {}))


def test_manifest_forbidden_packages(tmp_path: Path) -> None:
    write_manifests(tmp_path, "opencv-python-headless==4.0\nnumpy==1\n")
    assert check_manifests.check(tmp_path) == []
    for bad in ("opencv-python==4.0", "torch==2", "nvidia-cudnn-cu12==9", "cuda-python==12", "Torch>=2"):
        write_manifests_bad = tmp_path / "apps/api/requirements.txt"
        write_manifests_bad.write_text(f"opencv-python-headless==4.0\n{bad}\n")
        problems = check_manifests.check(tmp_path)
        assert len(problems) == 1 and "apps/api/requirements.txt" in problems[0]
        assert bad.split("=")[0].split(">")[0].lower() in problems[0]


def test_manifest_requires_headless_and_checks_package_json(tmp_path: Path) -> None:
    write_manifests(tmp_path, "numpy==1\n", {"dependencies": {"torch": "1"}})
    problems = check_manifests.check(tmp_path)
    assert any("missing required package opencv-python-headless" in p for p in problems)
    assert any(p.startswith("package.json") and "torch" in p for p in problems)


def init_repo(root: Path, gitignore: str) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    (root / ".gitignore").write_text(gitignore)
    (root / ".kiro/specs").mkdir(parents=True)
    (root / ".kiro/specs/requirements.md").write_text("x")


def test_kiro_ignore_detects_ignored_paths(tmp_path: Path) -> None:
    init_repo(tmp_path, ".env\nnode_modules/\n")
    assert check_kiro_ignore.check(tmp_path) == []
    (tmp_path / ".gitignore").write_text("specs/\n")
    assert check_kiro_ignore.check(tmp_path) == [".kiro/specs/requirements.md: ignored by .gitignore"]


def test_readme_variable_check() -> None:
    readme = "| Name | Purpose |\n|---|---|\n| `WEB_ORIGIN` | origin |\n| `REDIS_URL` | cache |\n"
    assert check_readme_env.check(readme, ["WEB_ORIGIN", "REDIS_URL"]) == []
    assert check_readme_env.check(readme, ["WEB_ORIGIN", "LOG_LEVEL"]) == ["README environment table is missing LOG_LEVEL"]


def test_repository_passes_its_own_checks() -> None:
    root = Path(__file__).resolve().parents[2]
    assert check_manifests.check(root) == []
    assert check_kiro_ignore.check(root) == []
