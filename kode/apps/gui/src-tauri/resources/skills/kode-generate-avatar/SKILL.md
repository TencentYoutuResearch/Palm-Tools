---
name: kode-generate-avatar
description: Generate, split, validate, and install a 36-frame Kode avatar from one 3x3 character sheet, with or without a layout reference image. Use when a user asks to create, customize, repair, or install a Kode tab avatar, animated CLI pet, avatar sprite sheet, or running/idle/awaiting/error animation set.
---

# Generate Kode Avatar

Create one square 3x3 source sheet, split it with the bundled Python script, inspect all nine states, and publish exactly
36 PNG frames. Keep one coherent character design across the entire sheet. Do not replace this workflow with four
independent sheets.

## Workflow

1. Collect the character, style, optional character reference, `avatar-id`, and gallery directory.
2. Resolve this skill's directory from the supplied `SKILL.md` path and verify
   `<skill-dir>/scripts/split_avatar_sheets.py`.
3. Choose `quad` for reference-free generation or `bottom-strip` for an existing all.png-style layout reference.
4. Show the complete generation prompt, generate one source sheet, and inspect it before splitting.
5. Split into a gallery-local preview, inspect all nine states, then publish the accepted output.
6. Verify the exact directory structure, frame count, and image dimensions.

## Inputs and paths

Collect:

- `avatar-id`: lowercase letters, numbers, and hyphens only.
- Character name or description, character-specific palette, and requested art style.
- Optional character reference. This controls identity only and is not required.
- Optional layout reference. Prefer `<gallery>/all.png` when it exists.
- The gallery directory supplied by Kode. Never guess it.

Use these paths:

```text
working directory: <gallery>/images/generated/<avatar-id>
source sheet:      <working-dir>/sheet.png
preview output:    <working-dir>/preview
final output:      <gallery>/<avatar-id>
splitter:          <skill-dir>/scripts/split_avatar_sheets.py
```

Never write generated or intermediate avatar files outside the supplied gallery.

Before generation, verify the splitter dependency:

```bash
python3 -c "from PIL import Image"
```

If Pillow is unavailable, report it and ask before installing anything.

## Choose the source layout

Use `quad` by default when no usable layout reference exists. This is the reliable reference-free format:

```text
one square source image
└── 3x3 equal state panels
    └── each state panel contains a 2x2 grid of four equal animation frames
```

Use `bottom-strip` only when a supplied layout reference clearly has one large scene plus four mini frames along the
bottom of every panel. Inspect the reference before choosing it.

## Generate the source sheet

Show the complete prompt to the user before the image-generation call. Use one image-generation call with the reference
image when available and these fixed parameters when supported:

```text
size=1024x1024, n=1, quality=high, background=opaque, input_fidelity=high, revise=false
```

For reference-free `quad` generation, use this prompt:

```text
Create one opaque square Kode avatar sprite sheet for {角色}, in {画风}.

The canvas is an exact 3x3 grid of nine equal state panels. Every state panel is itself an exact 2x2 grid of four
equal animation frames, for exactly 36 mini frames total. Do not draw a large hero illustration anywhere. Use thin,
straight, consistent dividers. Do not add titles, captions, labels, logos, or watermarks.

The nine state panels, left-to-right and top-to-bottom, are:
1 typing code, 2 eating chips, 3 drinking cola,
4 reading manga, 5 debugging, 6 compile success,
7 compile error, 8 slacking/phone break, 9 waiting/thinking.

Within each state panel, the four subframes show a subtle continuous animation of that exact action. Keep the same
character identity, hairstyle, face, eyes, outfit, palette, chibi proportions, line weight, camera distance,
background, and lighting across all 36 frames. Keep the full character and all important props inside the inner 80%
safe area of every subframe. Use only {角色}'s own palette. No realism, no card illustration, no nudity.
```

For `bottom-strip`, use the same state order and character constraints, but explicitly require the supplied reference's
one-large-scene-plus-four-bottom-frames geometry. Treat the layout image as a layout reference and any character image
as an identity reference.

Reject and regenerate a source sheet if it has the wrong number of panels or subframes, character drift, inconsistent
camera scale, clipped characters, labels, or an unusable grid. Save the accepted result as `<working-dir>/sheet.png`.

## Split and install

For reference-free `quad`, create the preview with:

```bash
python3 <skill-dir>/scripts/split_avatar_sheets.py \
  --source <working-dir>/sheet.png \
  --layout quad \
  --contact-sheet <working-dir>/preview-contact-sheet.png \
  --output-dir <working-dir>/preview
```

For all.png-style `bottom-strip`, use:

```bash
python3 <skill-dir>/scripts/split_avatar_sheets.py \
  --source <working-dir>/sheet.png \
  --layout bottom-strip \
  --contact-sheet <working-dir>/preview-contact-sheet.png \
  --output-dir <working-dir>/preview
```

The state mapping is fixed:

```text
source panel        Kode output
1 敲代码中          running/01
2 吃薯片            running/02
3 喝可乐            running/03
4 看漫画            running/04
5 调试中            running/05
6 编译成功          running/06
7 编译失败          error
8 摸鱼中            idle
9 思考中            awaiting
```

`bottom-strip` defaults to the original 418-unit reference coordinates:

```text
x=20,113,206,299  y=280  width=91  height=94
```

Generated sheets may shift strips by row. After inspecting a preview, pass explicit overrides instead of editing the
script:

```bash
python3 <skill-dir>/scripts/split_avatar_sheets.py \
  --source <working-dir>/sheet.png \
  --layout bottom-strip \
  --frame-x 20,116,212,308 \
  --frame-y 320,300,280 \
  --contact-sheet <working-dir>/preview-adjusted-contact-sheet.png \
  --output-dir <working-dir>/preview-adjusted
```

`--frame-y` accepts one value for all rows or three comma-separated values for rows 1, 2, and 3.

Inspect the contact sheet first, then spot-check the original 91x94 files from all nine preview states. When accepted,
rerun the same command with
`--output-dir <gallery>/<avatar-id>`. Do not use `--force` unless the user explicitly approves replacing an existing
avatar. Replacement preserves the previous directory as a timestamped `.backup-...` sibling.

## Verify

Check:

```text
<gallery>/<avatar-id>/
  running/01..06/frame-01.png..frame-04.png
  error/frame-01.png..frame-04.png
  idle/frame-01.png..frame-04.png
  awaiting/frame-01.png..frame-04.png
```

Confirm:

- exactly 36 PNG files;
- four frames in every state directory;
- every frame is 91x94 by default;
- the QA contact sheet shows all nine states and four frames in the expected order;
- no frame contains a neighboring cell, hero-scene fragment, clipped face, or unexpected label;
- the four frames form a coherent animation and each state matches its mapped meaning.

Report the final absolute path, layout mode, source-sheet path, any backup path, and the exact splitter command. Tell the
user to close and reopen the avatar picker so Kode refreshes the gallery.
