import math
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
from sklearn.decomposition import PCA
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

from app.schemas.autopsy import Anomaly, SampleRow, SkippedEntity, SpatialPoint
from app.services.embeddings import EmbeddingError, EmbeddingProvider, is_valid_matrix, record_text
from app.services.sanitizer import sanitize_cell

MIN_ROWS = 20
OUTLIER_THRESHOLD = -0.15
MAX_POINTS = 5000
EMBEDDING_BUDGET_SECONDS = 20.0
# Below this a PCA axis carries only floating-point noise; normalizing it would blow noise up to +-1.
AXIS_EPSILON = 1e-9

CoordinateSource = Literal["embedding", "numeric"]
FallbackReason = Literal["provider_error", "provider_timeout", "invalid_embedding", "degenerate_embedding"]


@dataclass(frozen=True)
class MlEntity:
    name: str
    fields: tuple[tuple[str, str], ...]
    rows: tuple[tuple[str, ...], ...]
    row_numbers: tuple[int, ...]


@dataclass
class MlOutcome:
    anomalies: list[Anomaly] = field(default_factory=list)
    skipped: list[SkippedEntity] = field(default_factory=list)
    points: list[SpatialPoint] = field(default_factory=list)
    coordinate_source: CoordinateSource = "embedding"
    embedding_fallback_reason: FallbackReason | None = None
    embeddings: dict[str, np.ndarray] = field(default_factory=dict)


@dataclass
class _Scored:
    entity: MlEntity
    scores: np.ndarray
    flagged: np.ndarray
    features: np.ndarray
    numeric_names: list[str]
    numeric_matrix: np.ndarray


def _to_float(value: str) -> float:
    try:
        parsed = float(value.strip().replace(",", ""))
    except ValueError:
        return math.nan
    return parsed if math.isfinite(parsed) else math.nan


def _cell(row: Sequence[str], i: int) -> str:
    return row[i] if i < len(row) else ""


def _numeric_columns(entity: MlEntity) -> tuple[list[str], np.ndarray, bool]:
    idx = [i for i, (_, t) in enumerate(entity.fields) if t in ("integer", "decimal")]
    has_numeric = bool(idx)
    names: list[str] = []
    columns: list[np.ndarray] = []
    for i in idx:
        col = np.array([_to_float(_cell(r, i)) for r in entity.rows], dtype=np.float64)
        valid = col[~np.isnan(col)]
        if valid.size == 0:
            continue
        col = np.where(np.isnan(col), np.median(valid), col)
        if float(col.max()) == float(col.min()):
            continue
        names.append(entity.fields[i][0])
        columns.append(col)
    matrix = np.column_stack(columns) if columns else np.zeros((len(entity.rows), 0))
    return names, matrix, has_numeric


def _byte_variance(entity: MlEntity) -> np.ndarray:
    sizes = np.array([sum(len(v.encode("utf-8")) for v in r) for r in entity.rows], dtype=np.float64)
    variance: np.ndarray = (sizes - sizes.mean()) ** 2
    return variance


def _finish_axes(raw: np.ndarray) -> np.ndarray:
    n = raw.shape[0]
    out = np.zeros((n, 3), dtype=np.float64)
    k = min(3, raw.shape[1])
    out[:, :k] = raw[:, :k]
    for axis in range(3):
        peak = float(np.abs(out[:, axis]).max()) if n else 0.0
        out[:, axis] = out[:, axis] / peak if peak > AXIS_EPSILON else 0.0
    result: np.ndarray = np.round(np.clip(out, -1.0, 1.0), 6) + 0.0
    return result


def _embedding_coordinates(matrix: np.ndarray) -> np.ndarray | None:
    data = matrix.astype(np.float64)
    keep = data.max(axis=0) != data.min(axis=0)
    dims = int(keep.sum())
    if dims == 0:
        return None
    n_components = min(3, dims, data.shape[0])
    projected = PCA(n_components=n_components, svd_solver="full", random_state=42).fit_transform(data[:, keep])
    return _finish_axes(projected)


def _numeric_coordinates(features: np.ndarray) -> np.ndarray:
    scaled = StandardScaler().fit_transform(features)
    n_components = min(3, features.shape[1], features.shape[0])
    projected = PCA(n_components=n_components, svd_solver="full", random_state=42).fit_transform(scaled)
    return _finish_axes(projected)


def _score(entity: MlEntity) -> _Scored | str:
    if len(entity.rows) < MIN_ROWS:
        return "insufficient_rows"
    names, matrix, has_numeric = _numeric_columns(entity)
    if not has_numeric:
        return "no_numeric_columns"
    variance = _byte_variance(entity)
    cols = [matrix] if matrix.shape[1] else []
    if float(variance.max()) != float(variance.min()):
        cols.append(variance.reshape(-1, 1))
    if not cols:
        return "constant_features"
    features = np.hstack(cols)
    forest = IsolationForest(contamination="auto", random_state=42)
    forest.fit(features)
    scores = np.round(forest.decision_function(features), 6) + 0.0
    return _Scored(entity, scores, scores < OUTLIER_THRESHOLD, features, names, matrix)


def _anomaly(s: _Scored) -> Anomaly | None:
    flagged_idx = np.flatnonzero(s.flagged)
    if flagged_idx.size == 0:
        return None
    field_name: str | None = None
    if s.numeric_names:
        std = s.numeric_matrix.std(axis=0)
        z = np.abs((s.numeric_matrix[flagged_idx] - s.numeric_matrix.mean(axis=0)) / np.where(std > 0, std, 1.0))
        field_name = s.numeric_names[int(np.argmax(z.mean(axis=0)))]
    rows = [s.entity.row_numbers[i] for i in flagged_idx]
    lowest = float(s.scores[flagged_idx].min())
    names = [n for n, _ in s.entity.fields]
    samples = [
        SampleRow(
            row_number=s.entity.row_numbers[i],
            values={n: sanitize_cell(_cell(s.entity.rows[i], j)) for j, n in enumerate(names)},
        )
        for i in flagged_idx[:5]
    ]
    where = f" on field {field_name}" if field_name else ""
    return Anomaly(
        id=f"ml:{s.entity.name}:statistical_outlier",
        name="statistical_outlier",
        entity=s.entity.name,
        field=field_name,
        affected_rows=rows,
        affected_row_count=len(rows),
        sample_rows=samples,
        severity="low" if lowest >= -0.30 else "medium",
        confidence=round(min(1.0, -lowest / 0.5), 2),
        root_cause=f"Isolation Forest scored {len(rows)} row(s) as statistical outliers{where}.",
        source="ml",
        outlier_scores={s.entity.row_numbers[i]: float(s.scores[i]) for i in flagged_idx},
    )


def _embed_all(
    entities: Sequence[MlEntity], provider: EmbeddingProvider, deadline: float
) -> tuple[dict[str, np.ndarray], FallbackReason | None]:
    out: dict[str, np.ndarray] = {}
    for e in entities:
        names = [n for n, _ in e.fields]
        texts = [record_text(e.name, names, r) for r in e.rows]
        try:
            matrix = provider.embed(texts, deadline=deadline)
        except EmbeddingError as exc:
            return {}, exc.reason
        except Exception:
            return {}, "provider_error"
        if not is_valid_matrix(matrix, len(texts)):
            return {}, "invalid_embedding"
        out[e.name] = matrix
    return out, None


def _sample(points: list[tuple[SpatialPoint, int]]) -> list[SpatialPoint]:
    if len(points) <= MAX_POINTS:
        return [p for p, _ in points]
    flagged = sorted((x for x in points if x[0].flagged), key=lambda x: x[0].outlier_score)
    if len(flagged) >= MAX_POINTS:
        chosen = flagged[:MAX_POINTS]
    else:
        unflagged = [x for x in points if not x[0].flagged]
        room = MAX_POINTS - len(flagged)
        stride = math.ceil(len(unflagged) / room)
        chosen = flagged + unflagged[::stride][:room]
    chosen.sort(key=lambda x: x[1])
    return [p for p, _ in chosen]


def score_entities(
    entities: Sequence[MlEntity], provider: EmbeddingProvider, deadline: float | None = None
) -> MlOutcome:
    limit = deadline if deadline is not None else time.monotonic() + EMBEDDING_BUDGET_SECONDS
    outcome = MlOutcome()
    embeddings, failure = _embed_all(entities, provider, limit)
    outcome.embeddings = embeddings
    reason: FallbackReason | None = failure
    ordered: list[tuple[SpatialPoint, int]] = []
    position = 0
    for e in entities:
        result = _score(e)
        if isinstance(result, str):
            outcome.skipped.append(SkippedEntity(entity=e.name, reason=result))
            continue
        coords: np.ndarray | None = None
        if e.name in embeddings:
            coords = _embedding_coordinates(embeddings[e.name])
            if coords is None:
                reason = reason or "degenerate_embedding"
        if coords is None:
            coords = _numeric_coordinates(result.features)
        anomaly = _anomaly(result)
        if anomaly is not None:
            outcome.anomalies.append(anomaly)
        for i, row_number in enumerate(e.row_numbers):
            point = SpatialPoint(
                entity=e.name,
                row_number=row_number,
                x=float(coords[i, 0]),
                y=float(coords[i, 1]),
                z=float(coords[i, 2]),
                flagged=bool(result.flagged[i]),
                outlier_score=float(result.scores[i]),
            )
            ordered.append((point, position))
            position += 1
    outcome.points = _sample(ordered)
    if reason is not None and ordered:
        outcome.coordinate_source = "numeric"
        outcome.embedding_fallback_reason = reason
    return outcome
