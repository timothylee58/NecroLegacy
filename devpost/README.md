# Demo video tooling

`SUBMISSION.md` is the Devpost text. The video is built from the deployed site, so it shows real runs.

```sh
# 1. Narration (macOS): one text file per scene in build/, then
for s in s0 s1 s2 s3 s4 s5a s5b s6; do
  say -v Daniel -r 170 -o build/$s.aiff -f build/$s.txt && ffmpeg -y -i build/$s.aiff -ar 44100 -ac 1 build/$s.wav
done
# build/durations.json maps each scene to its wav length in seconds.

# 2. Cache-missing copies of the presets (a completed run is cached for 24 h, so use a new directory per take):
#    build/<name>/corrupted_fnb_warehouse_pos_batch.txt   the F&B batch plus extra trailing newlines
#    build/<name>/faded_dotmatrix_manifest.png            the manifest re-encoded with another PNG compression level

# 3. Record against the live site, then compose
VARIANT=<name> node devpost/record-demo.mjs
python3 devpost/compose.py        # writes necrolegacy-devpost-demo.mp4, the -subtitled.mp4 copy and the .srt
```

Needs Node with Playwright installed in `apps/web`, and ffmpeg. `build/` and the video files are git-ignored. Warm the
API first (open the site or call `/api/health`): a cold start would otherwise land inside the recording.

## Music

`compose.py` downloads a CC BY 4.0 organ recording of BWV 565 (Norbert Schenk, Wikimedia Commons) into
`build/music/`, levels it, ducks it under the narration and fades it out. The licence requires the credit line drawn
over the end card (`render-subtitles.mjs`) and repeated in the video description (see `SUBMISSION.md`). Do not swap in
a commercial recording: YouTube's Content ID will flag it.

`necrolegacy-devpost-demo-subtitled.mp4` has the narration burned in as subtitles; the plain `.mp4` plus the `.srt`
is the better upload for YouTube, which can show or hide the captions.
