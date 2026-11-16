import cv2
import numpy as np


def skewed_table_png(angle: float, rows: int = 5, cols: int = 4, size: int = 800) -> bytes:
    img = np.full((size, size), 255, np.uint8)
    cw, ch = 100, 50
    x0, y0 = (size - cols * cw) // 2, (size - rows * ch) // 2
    for r in range(rows + 1):
        cv2.line(img, (x0, y0 + r * ch), (x0 + cols * cw, y0 + r * ch), 0, 3)
    for c in range(cols + 1):
        cv2.line(img, (x0 + c * cw, y0), (x0 + c * cw, y0 + rows * ch), 0, 3)
    for r in range(rows):
        for c in range(cols):
            cv2.putText(img, "12.5", (x0 + c * cw + 20, y0 + r * ch + 33), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 0, 2)
    matrix = cv2.getRotationMatrix2D((size / 2, size / 2), angle, 1.0)
    img = cv2.warpAffine(img, matrix, (size, size), borderValue=255, flags=cv2.INTER_CUBIC)
    return cv2.imencode(".png", img)[1].tobytes()


class StubEngine:
    def __init__(self, name: str = "tesseract", confidences: list[float] | None = None, text: str = "12.5") -> None:
        self.name = name
        self.confidences = confidences
        self.text = text
        self.calls = 0

    def read(self, crop: np.ndarray) -> tuple[str, float]:
        conf = self.confidences[self.calls % len(self.confidences)] if self.confidences else 0.9
        self.calls += 1
        return self.text, conf


class BrokenEngine:
    def __init__(self, name: str) -> None:
        self.name = name

    def read(self, crop: np.ndarray) -> tuple[str, float]:
        raise RuntimeError("engine down")
