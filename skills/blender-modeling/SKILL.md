---
name: blender-modeling
description: Use when the user wants to build, modify or render a 3D model, scene or asset in Blender. Covers live-app mode (the user watches every step), headless terminal mode, and preview-based self-checking.
---

# Blender modelling

Blender is installed on this machine and the DSH Blender plugin can drive it. Two modes exist
and they run **the same instruction layer** — the difference is only whether the user watches.

| | Live-app mode | Terminal mode |
|---|---|---|
| User sees the modelling happen | **yes**, in the Blender UI | no, only the result |
| Requires | Blender running with the DSH Bridge addon | just the blender.exe path |
| Use it for | exploring, showing the user, hands-on tweaking | batch work, one-shot assets, no UI available |

**Pick live-app mode by default when Blender is already open** — the user asked to see the
process, and seeing it is also how you notice a wrong turn early. Fall back to terminal mode
when Blender is closed, when asked for a batch, or when the bridge is not installed.

## Before you build

1. Check the environment, and which mode is actually usable right now.
2. Decide the mode, and say which one you are using and why — the user cares about the difference.
3. **Figure out the scale.** Blender's default unit is 1 metre. A "chair" is ~1 m tall, a
   "mug" is ~0.1 m. Getting scale wrong is the most common reason a model looks wrong in the
   preview and is expensive to fix later.
4. Build in passes, not one shot: rough blockout → check the preview → refine → materials.
   Do not write one giant instruction list and hope.

## How to drive it

The plugin exposes both channels. Full command reference and the instruction schema:
`references/instructions.md`.

Rough shape of the work:

- **live-app**: send instructions to the bridge; each one executes on Blender's main thread and
  appears in the viewport immediately. Ask for a preview render when you want to check yourself.
- **terminal**: run Blender headless with a script that replays the same instructions.

## Judge your own work with the preview

Every time you finish a meaningful pass, **render a preview and actually look at the image** —
do not assume it is right because the commands succeeded. The renderer auto-frames the model,
adds three-point lighting and a ground plane, so the picture is readable.

Read the image for: is the silhouette what was asked for, is the scale plausible, are parts
intersecting or floating, are the proportions off. Then fix and re-render. Two or three passes
is normal; one pass is usually not enough.

Details on what to look for, and the failure modes that show up: `references/preview-review.md`.

## Model quality rules that matter most

- **Block out first, detail later.** Get the silhouette right before bevels and materials.
- **Name every object you create.** Unnamed `Cube.001` objects make later instructions fail and
  make the scene impossible to reason about.
- **Use booleans for cuts, arrays for repetition, mirror for symmetry.** Do not place twenty
  copies by hand — the array instruction exists.
- **Nothing floats and nothing intersects** unless that is the design. Sit objects on the
  ground plane.
- **Materials are cheap and make the preview readable.** Give each distinct part a colour so
  you (and the user) can tell them apart.
- Read `references/recipes.md` for worked patterns (hard-surface, props, architecture,
  low-poly) before inventing your own approach.

## When something fails

The instruction layer returns readable errors that name what went wrong and what the scene
actually contains — read them instead of retrying blindly. Common causes: an object name that
does not exist yet (you skipped creating it, or a previous instruction failed and you kept
going), a bad scale, or a boolean whose tool object you already deleted.

If a boolean or modifier silently produces nothing, check the summary before continuing.
