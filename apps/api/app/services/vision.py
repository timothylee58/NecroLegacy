import logging
import math
import re
import statistics
from dataclasses import dataclass, field
from typing import Literal, Protocol

import cv2
import numpy as np

from app.schemas.autopsy import BoundingBox, VisionCell, VisionDefect
from app.services.file_checks import image_dimensions
from app.services.sanitizer import sanitize_cell

logger = logging.getLogger("necro.vision")

MIN_SIDE = 200
MAX_PIXELS = 40_000_000
MAX_CELLS = 10_000
SMUDGE_THRESHOLD = 0.6
FALLBACK_MEAN_CONFIDENCE = 0.4
MISALIGNED_RATIO = 0.25
EngineName = Literal["paddleocr", "tesseract"]
_NUMBER = re.compile(r"^[-+(]?[$€£]?\s*\d[\d,]*(\.\d+)?\)?$")


class VisionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class OcrEngine(Protocol):
    name: EngineName

    def read(self, crop: np.ndarray) -> tuple[str, float]: ...


class PaddleEngine:
    name: EngineName = "paddleocr"

    def __init__(self) -> None:
        from paddleocr import TextRecognition  # heavy import kept lazy so the other engine can run without it

        self._model = TextRecognition()

    def read(self, crop: np.ndarray) -> tuple[str, float]:
        rgb = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)
        results = self._model.predict(rgb)
        if not results:
            return "", 0.0
        first = results[0]
        return str(first["rec_text"]), float(first["rec_score"])


class TesseractEngine:
    name: EngineName = "tesseract"

    def __init__(self) -> None:
        import pytesseract

        pytesseract.get_tesseract_version()
        self._pt = pytesseract

    def read(self, crop: np.ndarray) -> tuple[str, float]:
        data = self._pt.image_to_data(crop, config="--psm 7", output_type=self._pt.Output.DICT)
        words, confs = [], []
        for text, conf in zip(data["text"], data["conf"], strict=False):
            if str(text).strip():
                words.append(str(text).strip())
                confs.append(max(0.0, float(conf)) / 100.0)
        if not words:
            return "", 0.0
        return " ".join(words), sum(confs) / len(confs)


def resolve_engine_name(value: str | None) -> EngineName:
    if value == "tesseract":
        return "tesseract"
    if value == "paddleocr":
        return "paddleocr"
    logger.warning("invalid OCR_ENGINE value %r, using paddleocr", value)
    return "paddleocr"


def _default_factories() -> dict[EngineName, type]:
    return {"paddleocr": PaddleEngine, "tesseract": TesseractEngine}


@dataclass
class Rect:
    x: int
    y: int
    w: int
    h: int
    open_side: bool = False

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2


@dataclass
class LocalVision:
    image_width: int
    image_height: int
    skew_angle_degrees: float
    engine: EngineName | None
    cells: list[VisionCell] = field(default_factory=list)
    defects: list[VisionDefect] = field(default_factory=list)
    needs_fallback: str | None = None
    image: np.ndarray | None = None


def check_dimensions(width: int, height: int) -> None:
    if width < MIN_SIDE or height < MIN_SIDE or width * height > MAX_PIXELS:
        raise VisionError("unreadable_image", "Image dimensions are outside the supported range.")


def decode_image(data: bytes) -> np.ndarray:
    dims = image_dimensions(data)
    if dims is not None:
        check_dimensions(*dims)
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise VisionError("unreadable_image", "Image could not be decoded.")
    check_dimensions(img.shape[1], img.shape[0])
    return img


def estimate_skew(gray: np.ndarray) -> float:
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    coords = cv2.findNonZero(binary)
    if coords is None or len(coords) < 10:
        return 0.0
    angle = float(cv2.minAreaRect(coords)[2])
    if angle > 45:
        angle -= 90
    return max(-45.0, min(45.0, round(angle, 1)))


def deskew(gray: np.ndarray, angle: float) -> tuple[np.ndarray, np.ndarray]:
    h, w = gray.shape
    matrix = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    rotated = cv2.warpAffine(gray, matrix, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return rotated, matrix


def enhance(gray: np.ndarray) -> np.ndarray:
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)


def binarize(gray: np.ndarray) -> np.ndarray:
    return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 10)


def _side_coverage(mask: np.ndarray, rect: Rect) -> list[float]:
    h, w = mask.shape
    x0, x1 = max(rect.x, 0), min(rect.x + rect.w, w)
    y0, y1 = max(rect.y, 0), min(rect.y + rect.h, h)

    def horizontal(y: int) -> float:
        band = mask[max(y - 4, 0) : min(y + 3, h), x0:x1]
        return float(np.any(band, axis=0).mean()) if band.size else 0.0

    def vertical(x: int) -> float:
        band = mask[y0:y1, max(x - 4, 0) : min(x + 3, w)]
        return float(np.any(band, axis=1).mean()) if band.size else 0.0

    return [horizontal(y0), horizontal(y1), vertical(x0), vertical(x1)]


def detect_cells(binary: np.ndarray) -> list[Rect]:
    h, w = binary.shape
    hk = cv2.getStructuringElement(cv2.MORPH_RECT, (max(10, w // 30), 1))
    vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(10, h // 30)))
    # Faded ribbon prints leave 1 px dropout streaks that would otherwise cut every line below the opening length.
    h_src = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 1)))
    v_src = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 5)))
    horizontal = cv2.morphologyEx(h_src, cv2.MORPH_OPEN, hk)
    vertical = cv2.morphologyEx(v_src, cv2.MORPH_OPEN, vk)
    lines = cv2.bitwise_or(horizontal, vertical)
    # Closing bridges short tears so a torn cell still forms a contour; open sides are measured on the unbridged mask.
    bridged = cv2.bitwise_or(
        cv2.morphologyEx(horizontal, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (max(15, w // 12), 1))),
        cv2.morphologyEx(vertical, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(15, h // 12)))),
    )
    bridged = cv2.dilate(bridged, np.ones((3, 3), np.uint8))
    contours, hierarchy = cv2.findContours(bridged, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []
    min_area = max(150, int(w * h * 0.0002))
    rects: list[Rect] = []
    for contour, info in zip(contours, hierarchy[0], strict=True):
        if info[3] == -1:
            continue
        x, y, cw, ch = cv2.boundingRect(contour)
        if cw * ch < min_area or cw * ch > 0.5 * w * h:
            continue
        rect = Rect(x, y, cw, ch)
        rect.open_side = min(_side_coverage(lines, rect)) < 0.6
        rects.append(rect)
    return rects


def _cluster(values: list[float], tolerance: float) -> list[int]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    labels = [0] * len(values)
    label = 0
    group: list[float] = []
    for i in order:
        if group and values[i] - statistics.fmean(group) > tolerance:
            label += 1
            group = []
        group.append(values[i])
        labels[i] = label
    return labels


def assign_grid(rects: list[Rect]) -> list[tuple[int, int, Rect]]:
    if not rects:
        return []
    row_tol = statistics.median(r.h for r in rects) / 2
    col_tol = statistics.median(r.w for r in rects) / 2
    rows = _cluster([r.cy for r in rects], row_tol)
    cols = _cluster([r.cx for r in rects], col_tol)
    placed = [(rows[i] + 1, cols[i] + 1, r) for i, r in enumerate(rects)]
    placed.sort(key=lambda t: (t[0], t[2].cx))
    return placed


def map_box(rect: Rect, inverse: np.ndarray, width: int, height: int) -> BoundingBox:
    corners = np.array(
        [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x, rect.y + rect.h], [rect.x + rect.w, rect.y + rect.h]],
        dtype=np.float64,
    )
    mapped = corners @ inverse[:, :2].T + inverse[:, 2]
    x0 = min(max(math.floor(float(mapped[:, 0].min())), 0), width - 1)
    y0 = min(max(math.floor(float(mapped[:, 1].min())), 0), height - 1)
    x1 = min(max(math.ceil(float(mapped[:, 0].max())), x0 + 1), width)
    y1 = min(max(math.ceil(float(mapped[:, 1].max())), y0 + 1), height)
    return BoundingBox(x=x0, y=y0, width=x1 - x0, height=y1 - y0)


def _crop(enhanced: np.ndarray, rect: Rect) -> np.ndarray:
    inset = 3
    h, w = enhanced.shape
    x0, y0 = min(rect.x + inset, w - 1), min(rect.y + inset, h - 1)
    x1, y1 = max(rect.x + rect.w - inset, x0 + 1), max(rect.y + rect.h - inset, y0 + 1)
    crop = enhanced[y0:y1, x0:x1]
    padded: np.ndarray = cv2.copyMakeBorder(crop, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=(255,))
    return padded


def _run_engine(engine: OcrEngine, crops: list[np.ndarray]) -> list[tuple[str, float]]:
    return [engine.read(c) for c in crops]


def _ocr_all(
    crops: list[np.ndarray], preferred: EngineName, engines: dict[EngineName, OcrEngine] | None
) -> tuple[EngineName, list[tuple[str, float]]] | None:
    factories = _default_factories()
    order: list[EngineName] = [preferred, "tesseract" if preferred == "paddleocr" else "paddleocr"]
    for name in order:
        try:
            engine = engines[name] if engines is not None and name in engines else factories[name]()
            return name, _run_engine(engine, crops)
        except Exception as exc:  # noqa: BLE001 - any engine failure triggers failover to the other engine
            logger.warning("ocr engine %s failed: %s", name, type(exc).__name__)
    return None


def is_number(text: str) -> bool:
    return bool(_NUMBER.match(text.strip()))


def _has_digit_or_unreadable(text: str) -> bool:
    return not text.strip() or "\ufffd" in text or "?" in text or any(ch.isdigit() for ch in text)


@dataclass
class DefectInput:
    row: int
    col: int
    text: str
    confidence: float
    smudged: bool
    cx: float
    width: float
    open_side: bool
    bbox: BoundingBox


def find_defects(items: list[DefectInput]) -> list[VisionDefect]:
    if not items:
        return []
    last_row = max(i.row for i in items)
    headers = {i.col: i.text.strip().lower() for i in items if i.row == 1}
    by_col: dict[int, list[DefectInput]] = {}
    for item in items:
        by_col.setdefault(item.col, []).append(item)
    medians = {
        col: (statistics.median(i.cx for i in cells), statistics.median(i.width for i in cells))
        for col, cells in by_col.items()
    }
    defects: list[VisionDefect] = []
    for item in items:
        if item.smudged and _has_digit_or_unreadable(item.text):
            defects.append(_defect("smudged_digit", item, 1 - item.confidence))
        total_col = headers.get(item.col) == "total" and item.row != 1
        if total_col or item.row == last_row:
            if not is_number(item.text):
                defects.append(_defect("torn_total", item, 0.9))
            elif item.open_side:
                defects.append(_defect("torn_total", item, 0.7))
        median_cx, median_w = medians[item.col]
        deviation = abs(item.cx - median_cx)
        if median_w > 0 and deviation > MISALIGNED_RATIO * median_w:
            defects.append(_defect("misaligned_column", item, min(1.0, deviation / (0.5 * median_w))))
    return defects


def _defect(kind: str, item: DefectInput, confidence: float) -> VisionDefect:
    return VisionDefect(
        type=kind,
        row=item.row,
        col=item.col,
        bbox=item.bbox,
        confidence=round(max(0.0, min(1.0, confidence)), 2),
    )


def _cell(row: int, col: int, text: str, confidence: float, bbox: BoundingBox) -> VisionCell:
    conf = round(max(0.0, min(1.0, confidence)), 2)
    return VisionCell(
        row=row, col=col, text=sanitize_cell(text), bbox=bbox, confidence=conf, smudged=conf < SMUDGE_THRESHOLD
    )


def build_from_boxes(
    boxes: list[tuple[int, int, str, float, BoundingBox]], width: int, height: int
) -> tuple[list[VisionCell], list[VisionDefect]]:
    """Cell and defect construction shared by local OCR and the vision-LLM fallback."""
    cells = [_cell(r, c, t, conf, b) for r, c, t, conf, b in boxes]
    items = [
        DefectInput(
            c.row, c.col, c.text, c.confidence, c.smudged, c.bbox.x + c.bbox.width / 2, c.bbox.width, False, c.bbox
        )
        for c in cells
    ]
    return cells, find_defects(items)


def analyze(
    data: bytes, ocr_engine: str | None = "paddleocr", engines: dict[EngineName, OcrEngine] | None = None
) -> LocalVision:
    gray = decode_image(data)
    height, width = gray.shape
    angle = estimate_skew(gray)
    rotated, matrix = deskew(gray, angle)
    enhanced = enhance(rotated)
    rects = detect_cells(binarize(enhanced))
    result = LocalVision(width, height, angle, None, image=gray)
    grid = assign_grid(rects)
    if len(grid) > MAX_CELLS:
        raise VisionError("cell_limit_exceeded", "The table has more than 10,000 cells.")
    if not grid or max(r for r, _, _ in grid) < 2 or max(c for _, c, _ in grid) < 2:
        result.needs_fallback = "no_grid"
        return result
    ocr = _ocr_all([_crop(enhanced, rect) for _, _, rect in grid], resolve_engine_name(ocr_engine), engines)
    if ocr is None:
        result.needs_fallback = "ocr_failed"
        return result
    result.engine, reads = ocr
    inverse = cv2.invertAffineTransform(matrix)
    cells: list[VisionCell] = []
    items: list[DefectInput] = []
    for (row, col, rect), (text, confidence) in zip(grid, reads, strict=True):
        box = map_box(rect, inverse, width, height)
        cell = _cell(row, col, text, confidence, box)
        cells.append(cell)
        items.append(
            DefectInput(row, col, cell.text, cell.confidence, cell.smudged, rect.cx, rect.w, rect.open_side, box)
        )
    result.cells, result.defects = cells, find_defects(items)
    if statistics.fmean(c.confidence for c in cells) < FALLBACK_MEAN_CONFIDENCE:
        result.needs_fallback = "low_confidence"
    return result
