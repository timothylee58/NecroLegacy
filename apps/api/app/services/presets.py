import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.schemas.autopsy import PresetId, PresetInfo


@dataclass(frozen=True)
class Preset:
    id: PresetId
    label: str
    kind: Literal["text", "image"]
    filename: str


PRESETS: tuple[Preset, ...] = (
    Preset("ledger_1994", "1994 Mainframe Ledger Dump", "text", "1994_mainframe_ledger_dump.dat"),
    Preset("fnb_pos_corrupted", "Corrupted F&B Warehouse POS Batch", "text", "corrupted_fnb_warehouse_pos_batch.txt"),
    Preset("dotmatrix_manifest", "Faded Dot-Matrix Manifest", "image", "faded_dotmatrix_manifest.png"),
)


def dumps_dir() -> Path:
    override = os.environ.get("SAMPLE_DUMPS_DIR")
    return Path(override) if override else Path(__file__).resolve().parents[4] / "sample-dumps"


def get_preset(preset_id: str) -> Preset | None:
    return next((p for p in PRESETS if p.id == preset_id), None)


def read_preset(preset: Preset) -> bytes:
    return (dumps_dir() / preset.filename).read_bytes()


def preset_infos() -> list[PresetInfo]:
    return [PresetInfo(id=p.id, label=p.label, kind=p.kind) for p in PRESETS]
