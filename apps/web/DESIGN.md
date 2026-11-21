---
name: NecroLegacy Autopsy Theatre
colors:
  theatre-slate: "#14120F"
  slab: "#1C1A16"
  popover: "#1E1B16"
  rule: "#3A332A"
  bone: "#EFE4CC"
  bone-dim: "#B9AE98"
  tallow: "#E8B04F"
  crimson: "#EC5167"
  crimson-ink: "#F98A99"
  ochre: "#DE9346"
  formalin: "#94B6AD"
  verdigris: "#6FC08A"
  xray-confident: "#15803D"
  xray-flagged: "#DC143C"
typography:
  notice:
    fontFamily: Anton
    fontSize: clamp(2.75rem, 6.2vw, 5.75rem)
    fontWeight: 400
    lineHeight: 0.92
    letterSpacing: 0.01em
  section-title:
    fontFamily: Anton
    fontSize: 1.875rem
    fontWeight: 400
    lineHeight: 1
  body:
    fontFamily: Archivo
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: Archivo
    fontSize: 0.72rem
    fontWeight: 600
    letterSpacing: 0.08em
  data:
    fontFamily: JetBrains Mono
    fontSize: 0.75rem
    fontWeight: 400
  xray-tag:
    fontFamily: JetBrains Mono
    fontSize: 10px
    fontWeight: 400
rounded:
  default: 2px
spacing:
  page-x: 2rem
  column-gap: 2.5rem
  section-gap: 2rem
components:
  button-primary:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.theatre-slate}"
    rounded: "{rounded.default}"
    height: 2.5rem
  button-primary-hover:
    backgroundColor: "{colors.tallow}"
    textColor: "{colors.theatre-slate}"
  button-outline:
    textColor: "{colors.bone}"
    rounded: "{rounded.default}"
    height: 2.5rem
  input:
    backgroundColor: "{colors.slab}"
    textColor: "{colors.bone}"
    rounded: "{rounded.default}"
    height: 2.5rem
---

# Design System: NecroLegacy Autopsy Theatre

## Overview
An anatomical theatre after hours. The case is posted as a coroner's notice in cream condensed poster type; the specimens lie on a 3D table lit by one overhead lamp. It is a working screen first (Operate mode): standard controls, a left case-file column, a main column for the verdict and the table, and search and code below. Atmosphere comes from type, palette, the notice, and a few hand-drawn line illustrations (lamp, cobwebs, slab, bats, coffin, toe tag, candle) in bone and tallow.

## Colors
### Primary
- **Bone** (`#EFE4CC`) is all primary text, the notice, and the solid primary button. Bone-dim (`#B9AE98`) is secondary text.
### Secondary
- **Tallow** (`#E8B04F`) is lamp light: focus ring, running step, drag-over, selected preset, button hover, and the lamp pool on the table.
### Neutral
- **Theatre slate** (`#14120F`) ground, **slab** (`#1C1A16`) inputs and image frames, **popover** (`#1E1B16`) dialogs and the drawer, **rule** (`#3A332A`) every 1px line.
### Named Rules
- **Crimson means critical, nothing else.** `crimson` fills dots, nodes and alert borders; `crimson-ink` is the text-safe variant for labels and the notice's critical line.
- **Severity is never colour alone.** Every severity carries an icon and a word (Critical, Medium, Low, No anomalies).
- **Ochre** is medium, **formalin** is low, **verdigris** is a completed step or a passed check.
- **X-Ray colours are fixed by the spec**: `#15803D` confident, `#DC143C` flagged (dashed). Do not retint them.

## Typography
### Hierarchy
- **Notice** (Anton, uppercase, 0.92 line height): the case verdict only, up to two lines, the second line dim or crimson.
- **Section titles** (Anton 30px): Search records, Generated FastAPI wrapper, Flagged regions, anomaly names in the drawer.
- **Body** (Archivo 14px), **label** (Archivo 11.5px, 600, uppercase, 0.08em) for column headings such as Procedure and Specimens.
- **Data** (JetBrains Mono): entity names, field names, offsets, file names, node ids, code. Never as decoration.
- **X-Ray tag** (JetBrains Mono 10px): the cell labels drawn over a scanned image, kept small so they don't cover the evidence.
### Named Rules
- Roman numerals I–V number the procedure because the pipeline order is fixed and meaningful.

## Layout
`max-w-[96rem]`, 2rem page gutters. Desktop: a 17.5rem case-file column (Procedure, Specimens, summary) beside the main column (notice above, table below, X-Ray beside the table for images). Search and code sit below a full-width rule in a 5:7 split. Mobile stacks notice, case file, table, then search and code. Lists are ruled rows, not cards.

## Elevation & Depth
Flat panels separated by 1px rules. Only overlays lift: dialog and drawer use a long soft shadow (`0 24px 60px -12px rgb(0 0 0 / 0.7)`) over a dark scrim. The lamp pool (`.lamp-pool`, `.lamp-glow`) is the one lighting effect; low fog (`.fog`) settles along the table floor.

## Shapes
2px corners everywhere. Round shapes are reserved for severity dots and 3D nodes.

## Components
### Buttons
Primary: bone fill, slate text, hover to tallow. Outline: rule border, hover to tallow border and text. Small (h-8) for inline retries.
### Inputs
Slab fill, rule border, tallow caret and focus ring, crimson border when invalid.
### Lists
Specimens, presets, anomalies, flagged regions and search hits are ruled rows with a trailing chevron or badge.
### Motion
Authored moments: the notice re-sets (rise, unblur) when the verdict changes; three bats burst once off a critical verdict; a ghost rises beside the generated wrapper when its syntax check passes; two bats cross the empty slab once. Ambient: the lamp flickers rarely (never more than 3 dips a second), fog drifts, the running step's candle flickers. The drawer slides in 250ms. One-off moments are finite; ambient loops stay faint.

Under `prefers-reduced-motion` all animation stops and the bats are hidden with `motion-reduce:hidden`. Gate motion with CSS, not `useReducedMotion()` branches in server-rendered markup; those cause hydration mismatches in the static export.

### Illustrations
`components/autopsy/illustrations.tsx` holds the line art; Lucide covers icon scale (`Skull` for critical, `Tombstone` for no search hits, `Ghost`, preset icons). Every illustration is `aria-hidden`; meaning always lives in the nearby text. Copy is kept short: the drawing carries the mood, a word carries the meaning.

## Do's and Don'ts
- Do keep every control a standard web control; the theatre lends type and light, not costume.
- Don't add cards, gradients on text, glow halos, or a second accent colour.
- Don't use cartoon pumpkins or clip-art ghosts; Halloween stays in the theatre's line-drawn, bone-and-tallow register.
- Don't use crimson for emphasis that is not a critical finding.
