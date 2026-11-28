#!/usr/bin/env python3
"""Builds the Devpost demo from build/demo.webm: narration placed at each scene start, Bach's Toccata and Fugue in
D minor (BWV 565, CC BY 4.0 recording by Norbert Schenk) ducked under it, a credit line at the end,
H.264 + AAC output, an SRT with the narration, and a second copy with the subtitles burned in. Needs ffmpeg and Node.
Run after record-demo.mjs."""
import json
import re
import subprocess
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
OUT = HERE / "necrolegacy-devpost-demo.mp4"
OUT_SUBTITLED = HERE / "necrolegacy-devpost-demo-subtitled.mp4"
SRT = HERE / "necrolegacy-devpost-demo.srt"
SUBS = BUILD / "subs"
HEIGHT = 1080
SUB_BAND = 220  # height of each subtitle image, see render-subtitles.mjs
# The recording already carries scene captions about 36 to 90 px above the bottom edge; subtitles sit above them.
SUB_BOTTOM_MARGIN = 100
MAX_CUE_CHARS = 80
MIN_CUE_CHARS = 30
# Wikimedia Commons, "Bach, Toccata und Fuge d-moll BWV 565, Norbert Schenk.mp3", CC BY 4.0 (organ of the
# Evangelische Kirche Solms-Albshausen, recorded 2017). The credit line is drawn by render-subtitles.mjs.
MUSIC_URL = (
    "https://upload.wikimedia.org/wikipedia/commons/4/4d/"
    "Bach%2C_Toccata_und_Fuge_d-moll_BWV_565%2C_Norbert_Schenk.mp3"
)
MUSIC = BUILD / "music" / "toccata_schenk.mp3"
CREDIT = BUILD / "credit.png"
CREDIT_BAND = 120
CREDIT_BOTTOM_MARGIN = 22
CREDIT_SECONDS = 13
# Music level: loudnorm target for the organ before ducking, and how far narration pushes it down.
MUSIC_LUFS = -22
SCENES = ["s0", "s1", "s2", "s3", "s4", "s5a", "s5b", "s6"]
# Playwright's video clock starts slightly after the script's, by about a tenth of a second.
SYNC = 0.1

marks = json.loads((BUILD / "timeline.json").read_text())
dur = json.loads((BUILD / "durations.json").read_text())
trim = marks["s0"]
total = marks["end"] - trim + 0.8
starts = {s: marks[s] - trim + SYNC for s in SCENES}

def ensure_music() -> None:
    if MUSIC.exists():
        return
    MUSIC.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(MUSIC_URL, headers={"User-Agent": "NecroLegacyDemo/1.0 (github.com/timothylee58/NecroLegacy)"})
    MUSIC.write_bytes(urllib.request.urlopen(request, timeout=120).read())


ensure_music()
SPOKEN = {"M C P": "MCP", "nineteen ninety four": "1994", "nineteen requirement": "19-requirement"}


def chunks(sentence: str) -> list[str]:
    """Splits a sentence at commas and colons into pieces of at most MAX_CUE_CHARS, then at spaces if still too long."""
    parts, current = [], ""
    for piece in re.split(r"(?<=[,:;])\s+", sentence):
        if current and len(current) + 1 + len(piece) > MAX_CUE_CHARS:
            parts.append(current)
            current = piece
        else:
            current = f"{current} {piece}".strip()
    parts.append(current)
    out: list[str] = []
    for part in parts:
        while len(part) > MAX_CUE_CHARS:
            cut = part.rfind(" ", 0, MAX_CUE_CHARS)
            out.append(part[:cut])
            part = part[cut + 1 :]
        out.append(part)
    return out


def merge_short(pieces: list[str]) -> list[str]:
    """Joins a cue too short to read (under about 2 s of speech, roughly 30 characters) with the next one."""
    out: list[str] = []
    current = ""
    for piece in pieces:
        if current and len(current) < MIN_CUE_CHARS and len(current) + 1 + len(piece) <= MAX_CUE_CHARS + 6:
            current = f"{current} {piece}"
        else:
            if current:
                out.append(current)
            current = piece
    out.append(current)
    return out


def stamp(t: float) -> str:
    h, rem = divmod(t, 3600)
    m, sec = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(sec):02d},{int(round((sec - int(sec)) * 1000)):03d}"


cues: list[dict] = []
for s in SCENES:
    text = (BUILD / f"{s}.txt").read_text().strip()
    for old, new in SPOKEN.items():
        text = text.replace(old, new)
    pieces = [c for p in re.split(r"(?<=[.!?])\s+", text) if p.strip() for c in chunks(p.strip())]
    pieces = merge_short(pieces)
    weight = sum(len(p) for p in pieces)
    t = starts[s]
    for p in pieces:
        span = dur[s] * len(p) / weight
        cues.append({"start": round(t, 3), "end": round(t + span, 3), "text": p})
        t += span
SRT.write_text(
    "\n".join(
        f"{i}\n{stamp(c['start'])} --> {stamp(c['end'])}\n{c['text']}\n" for i, c in enumerate(cues, start=1)
    ),
    encoding="utf-8",
)
(BUILD / "cues.json").write_text(json.dumps(cues, indent=1))

base_inputs = ["-ss", f"{trim:.3f}", "-t", f"{total:.3f}", "-i", str(BUILD / "demo.webm")]
for s in SCENES:
    base_inputs += ["-i", str(BUILD / f"{s}.wav")]
base_inputs += ["-i", str(MUSIC)]


def audio_filters() -> list[str]:
    filters = []
    for i, s in enumerate(SCENES, start=1):
        ms = int(starts[s] * 1000)
        filters.append(f"[{i}:a]adelay={ms}|{ms},apad=whole_dur={total:.3f}[n{i}]")
    mix = "".join(f"[n{i}]" for i in range(1, len(SCENES) + 1))
    filters.append(f"{mix}amix=inputs={len(SCENES)}:normalize=0:duration=longest,aformat=channel_layouts=stereo,asplit=2[nar][nar_sc]")
    mus = len(SCENES) + 1
    # The organ is levelled, ducked while the narrator speaks (the narration is the sidechain), and faded out at the end.
    filters.append(
        f"[{mus}:a]atrim=0:{total:.3f},asetpts=PTS-STARTPTS,aresample=44100,"
        f"loudnorm=I={MUSIC_LUFS}:TP=-2:LRA=11,afade=t=out:st={total - 5:.2f}:d=5[m0]"
    )
    filters.append("[m0][nar_sc]sidechaincompress=threshold=0.02:ratio=3.5:attack=25:release=900:makeup=1[mducked]")
    filters.append("[nar][mducked]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[aout]")
    return filters


def encode(out: Path, burn_subtitles: bool) -> None:
    inputs = list(base_inputs)
    filters = audio_filters()
    credit_index = len(SCENES) + 2  # after the video, the narration clips and the music
    inputs += ["-i", str(CREDIT)]
    # (image input index, y, start, end); a one-frame image is repeated after its end, so `enable` decides when it shows.
    overlays = [(credit_index, HEIGHT - CREDIT_BAND - CREDIT_BOTTOM_MARGIN, total - CREDIT_SECONDS, total - 0.4)]
    if burn_subtitles:
        y = HEIGHT - SUB_BAND - SUB_BOTTOM_MARGIN
        for i, c in enumerate(cues):
            inputs += ["-i", str(SUBS / f"{i + 1:03d}.png")]
            overlays.append((credit_index + 1 + i, y, c["start"], c["end"]))
    filters.append("[0:v]fps=30,format=yuv420p[v0]")
    for n, (index, y, start, end) in enumerate(overlays):
        last = n == len(overlays) - 1
        filters.append(
            f"[v{n}][{index}:v]overlay=0:{y}:enable='between(t,{start:.3f},{end:.3f})'{'[vout]' if last else f'[v{n + 1}]'}"
        )
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", *inputs,
        "-filter_complex", ";".join(filters),
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", "192k", "-t", f"{total:.3f}", str(out),
    ]
    subprocess.run(cmd, check=True)


subprocess.run(["node", str(HERE / "render-subtitles.mjs")], check=True)
encode(OUT, burn_subtitles=False)
encode(OUT_SUBTITLED, burn_subtitles=True)
print(f"wrote {OUT.name}, {OUT_SUBTITLED.name} ({total:.1f} s) and {SRT.name} ({len(cues)} cues)")
