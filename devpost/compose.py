#!/usr/bin/env python3
"""Builds the Devpost demo from build/demo.webm: narration placed at each scene start, a quiet ambient drone,
H.264 + AAC output and an SRT with the narration. Needs ffmpeg. Run after record-demo.mjs."""
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
OUT = HERE / "necrolegacy-devpost-demo.mp4"
SRT = HERE / "necrolegacy-devpost-demo.srt"
SCENES = ["s0", "s1", "s2", "s3", "s4", "s5a", "s5b", "s6"]
# Playwright's video clock starts slightly after the script's, by about a tenth of a second.
SYNC = 0.1

marks = json.loads((BUILD / "timeline.json").read_text())
dur = json.loads((BUILD / "durations.json").read_text())
trim = marks["s0"]
total = marks["end"] - trim + 0.8
starts = {s: marks[s] - trim + SYNC for s in SCENES}

inputs = ["-ss", f"{trim:.3f}", "-t", f"{total:.3f}", "-i", str(BUILD / "demo.webm")]
for s in SCENES:
    inputs += ["-i", str(BUILD / f"{s}.wav")]
music = (
    "aevalsrc='0.5*sin(2*PI*55*t)+0.35*sin(2*PI*82.41*t)+0.22*sin(2*PI*110.5*t)*(0.6+0.4*sin(2*PI*0.07*t))"
    f"+0.10*sin(2*PI*164.8*t)*(0.5+0.5*sin(2*PI*0.031*t))':s=44100:d={total:.3f}"
)
inputs += ["-f", "lavfi", "-i", music]

filters = []
for i, s in enumerate(SCENES, start=1):
    ms = int(starts[s] * 1000)
    filters.append(f"[{i}:a]adelay={ms}|{ms},apad=whole_dur={total:.3f}[n{i}]")
mix = "".join(f"[n{i}]" for i in range(1, len(SCENES) + 1))
filters.append(f"{mix}amix=inputs={len(SCENES)}:normalize=0:duration=longest[nar]")
mus = len(SCENES) + 1
filters.append(
    f"[{mus}:a]lowpass=f=420,volume=0.085,afade=t=in:st=0:d=3,afade=t=out:st={total - 4:.2f}:d=4[mus]"
)
filters.append("[nar][mus]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[aout]")
filters.append("[0:v]fps=30,format=yuv420p[vout]")

cmd = [
    "ffmpeg", "-y", "-loglevel", "error", *inputs,
    "-filter_complex", ";".join(filters),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", str(OUT),
]
subprocess.run(cmd, check=True)


def stamp(t: float) -> str:
    h, rem = divmod(t, 3600)
    m, sec = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(sec):02d},{int(round((sec - int(sec)) * 1000)):03d}"


cues = []
for s in SCENES:
    text = (BUILD / f"{s}.txt").read_text().strip()
    sentences = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text) if p.strip()]
    weight = sum(len(p) for p in sentences)
    t = starts[s]
    for p in sentences:
        span = dur[s] * len(p) / weight
        cues.append((t, t + span, p.replace("M C P", "MCP").replace("nineteen ninety four", "1994")))
        t += span
SRT.write_text(
    "\n".join(f"{i}\n{stamp(a)} --> {stamp(b)}\n{text}\n" for i, (a, b, text) in enumerate(cues, start=1)),
    encoding="utf-8",
)
print(f"wrote {OUT.name} ({total:.1f} s) and {SRT.name} ({len(cues)} cues)")
