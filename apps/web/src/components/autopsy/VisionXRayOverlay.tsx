"use client";
import * as React from "react";
import { Toggle } from "@/components/ui/toggle";
import { flaggedRegions, LOW_CONFIDENCE_THRESHOLD } from "@/lib/session-reducer";
import type { VisionCell, VisionDefect, VisionResult } from "@/types/autopsy";

export interface VisionXRayOverlayProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  cells: VisionCell[];
  defects: VisionDefect[];
  onAnnounce: (message: string) => void;
}

const GREEN = "#15803D";
const CRIMSON = "#DC143C";
const MAX_TAGS = 200;
const FADE_MS = 150;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function overlayFillOpacity(confidence: number): number {
  return Math.round((0.1 + 0.5 * (1 - confidence)) * 100) / 100;
}

const keyOf = (row: number, col: number) => `${row}:${col}`;

function subscribeReducedMotion(cb: () => void): () => void {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function useReducedMotion(): boolean {
  return React.useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

interface CellShape {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  flagged: boolean;
  fillOpacity: number;
}

const RectGroup = React.memo(function RectGroup({ shapes }: { shapes: CellShape[] }) {
  return (
    <g>
      {shapes.map((s) => (
        <g key={s.key}>
          <rect
            x={s.x}
            y={s.y}
            width={s.width}
            height={s.height}
            fill="none"
            stroke="#FFFFFF"
            strokeWidth={4}
            vectorEffect="non-scaling-stroke"
          />
          <rect
            x={s.x}
            y={s.y}
            width={s.width}
            height={s.height}
            fill={s.flagged ? CRIMSON : GREEN}
            fillOpacity={s.fillOpacity}
            stroke={s.flagged ? CRIMSON : GREEN}
            strokeWidth={2}
            strokeDasharray={s.flagged ? "6 3" : undefined}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </g>
  );
});

export function VisionXRayOverlay({
  imageUrl,
  imageWidth,
  imageHeight,
  cells,
  defects,
  onAnnounce,
}: VisionXRayOverlayProps) {
  const reducedMotion = useReducedMotion();
  const [on, setOn] = React.useState(false);
  const [imageFailed, setImageFailed] = React.useState(false);
  const [hoverKey, setHoverKey] = React.useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = React.useState<string | null>(null);
  const headingId = React.useId();
  const reasonId = React.useId();

  React.useEffect(() => setImageFailed(false), [imageUrl]);

  const disabled = imageFailed || cells.length === 0;
  const reason = imageFailed
    ? "Vision X-Ray is unavailable because the image failed to load."
    : cells.length === 0
      ? "Vision X-Ray is unavailable because no text regions were detected."
      : null;

  const regions = React.useMemo(
    () => flaggedRegions({ cells, defects } as VisionResult),
    [cells, defects],
  );

  const shapes = React.useMemo<CellShape[]>(() => {
    const defectKeys = new Set(defects.map((d) => keyOf(d.row, d.col)));
    return cells.map((c) => ({
      key: keyOf(c.row, c.col),
      x: c.bbox.x,
      y: c.bbox.y,
      width: c.bbox.width,
      height: c.bbox.height,
      flagged: c.confidence < LOW_CONFIDENCE_THRESHOLD || defectKeys.has(keyOf(c.row, c.col)),
      fillOpacity: overlayFillOpacity(c.confidence),
    }));
  }, [cells, defects]);

  const activeKey = hoverKey ?? pinnedKey;
  const active = activeKey ? regions.find((r) => keyOf(r.row, r.col) === activeKey) : undefined;
  const visible = on && !disabled;

  const handlePressedChange = (next: boolean) => {
    if (disabled) return;
    setOn(next);
    if (!next) {
      setHoverKey(null);
      setPinnedKey(null);
    }
    onAnnounce(
      next
        ? `Vision X-Ray on. ${regions.length} flagged ${regions.length === 1 ? "region" : "regions"}.`
        : "Vision X-Ray off.",
    );
  };

  const pct = (v: number, total: number) => `${(v / total) * 100}%`;

  const overlayStyle: React.CSSProperties = reducedMotion
    ? { display: visible ? "block" : "none" }
    : {
        opacity: visible ? 1 : 0,
        visibility: visible ? "visible" : "hidden",
        transition: `opacity ${FADE_MS}ms linear, visibility ${FADE_MS}ms linear`,
      };

  return (
    <section className="flex flex-col gap-3" aria-label="Vision X-Ray">
      <div className="flex flex-wrap items-center gap-3">
        <Toggle
          pressed={visible}
          onPressedChange={handlePressedChange}
          aria-disabled={disabled ? "true" : undefined}
          aria-describedby={reason ? reasonId : undefined}
        >
          Vision X-Ray
        </Toggle>
        {reason && (
          <p id={reasonId} className="text-sm">
            {reason}
          </p>
        )}
      </div>

      <div style={{ position: "relative" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt="Uploaded legacy document"
          style={{ width: "100%", height: "auto", display: "block" }}
          onError={() => setImageFailed(true)}
        />
        {!disabled && (
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", ...overlayStyle }}>
            <svg
              role="img"
              aria-labelledby={headingId}
              viewBox={`0 0 ${imageWidth} ${imageHeight}`}
              preserveAspectRatio="xMidYMid meet"
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
            >
              <RectGroup shapes={shapes} />
              {active && (
                <rect
                  x={active.bbox.x}
                  y={active.bbox.y}
                  width={active.bbox.width}
                  height={active.bbox.height}
                  fill="none"
                  stroke="#000000"
                  strokeWidth={4}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            {regions.slice(0, MAX_TAGS).map((r) => (
              <span
                key={keyOf(r.row, r.col)}
                aria-hidden="true"
                className="absolute bg-black/80 px-1 text-[10px] leading-tight text-white"
                style={{ left: pct(r.bbox.x, imageWidth), top: pct(r.bbox.y, imageHeight) }}
              >
                {`R${r.row}C${r.col} ${r.defectType ?? "low confidence"}`}
              </span>
            ))}
            {active && (
              <div
                role="tooltip"
                className="absolute z-10 rounded border border-border bg-background px-2 py-1 text-xs shadow"
                style={{
                  left: pct(active.bbox.x, imageWidth),
                  top: pct(active.bbox.y + active.bbox.height, imageHeight),
                }}
              >
                <div>{active.text || "(no text)"}</div>
                <div>Confidence {active.confidence.toFixed(2)}</div>
                <div>Defect: {active.defectType ?? "none"}</div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs" aria-label="Opacity legend">
        <span>Confidence 1.0 (opacity 0.1)</span>
        <span
          aria-hidden="true"
          className="h-3 w-32 rounded border border-border"
          style={{ background: `linear-gradient(to right, ${GREEN}1A, ${GREEN}99)` }}
        />
        <span>0.0 (opacity 0.6)</span>
      </div>

      <h2 id={headingId} className="text-sm font-semibold">
        Flagged regions ({regions.length})
      </h2>
      {regions.length === 0 ? (
        <p className="text-sm">No defects were detected.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {regions.map((r) => {
            const k = keyOf(r.row, r.col);
            const pinned = pinnedKey === k;
            const toggleKey = (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setPinnedKey(pinned ? null : k);
              }
            };
            return (
              <li
                key={k}
                tabIndex={0}
                aria-current={pinned ? "true" : undefined}
                className="cursor-pointer rounded border border-border px-2 py-1 text-sm"
                onMouseEnter={() => setHoverKey(k)}
                onMouseLeave={() => setHoverKey(null)}
                onFocus={() => setHoverKey(k)}
                onBlur={() => setHoverKey(null)}
                onKeyDown={toggleKey}
              >
                {`Row ${r.row}, column ${r.col}: ${r.text || "(no text)"}, confidence ${r.confidence.toFixed(2)}, ${r.defectType ?? "low confidence"}`}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default VisionXRayOverlay;
