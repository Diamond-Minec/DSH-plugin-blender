# Reviewing your own preview

The renderer auto-frames the model, adds three-point lighting, and puts a ground plane under
it. That means **the picture is about the model, not about the camera** — if it looks wrong,
the model is wrong. This is what makes the loop worth running.

Run a preview after every meaningful pass, and actually look at the image. "The commands
succeeded" is not evidence the model is right.

## What to look at, in order

**1. Silhouette — does it read as the thing?**
Squint at it. If you cannot tell what it is from the outline alone, the proportions are wrong
and no amount of material work will save it. Fix the blockout before continuing.

**2. Scale sanity.**
The ground plane and the framing give you a size reference. A chair that is 1 unit tall is
right; a chair that is 10 units tall is a tree. If everything looks tiny and lost in the frame,
the model is far too big for a fixed camera, or you built it at the wrong scale.

**3. Floating and intersecting parts.**
Nothing should hover above the ground unless it is meant to. Nothing should be buried inside
another object unless you deliberately unioned it. Both are extremely common and both are
obvious in a preview and invisible in a summary.

**4. Proportion between parts.**
A mug handle as thick as the mug. A table leg thinner than the tabletop. Check the ratios
between parts, not just each part alone.

**5. Is anything missing entirely?**
Count the parts in the image against the parts you intended. A silently failed boolean or a
misnamed target often shows up as "one piece is simply absent".

**6. Materials distinguishable.**
If everything is one flat grey, you skipped the material pass and cannot judge part boundaries.
Add colours.

## Failure modes and what they mean

| What you see | Almost always means |
|---|---|
| Only part of the model in frame, or the model is small and lost in the middle | Scale is off by a lot, or one stray object far from the origin pulls the framing |
| Everything one flat grey | No materials assigned |
| Object floating above the ground | Its `location.z` is wrong — the origin sits at the object centre, so a 2 m tall box centred at z=1 rests on the ground |
| A cut that did not happen | The boolean tool object did not exist yet, or was already deleted |
| Repeated parts overlapping exactly | `array` offset was `[0,0,0]`, or you duplicated without an offset |
| Model looks squashed or stretched | Non-uniform `scale` was applied and then more operations were done on top |
| Preview is empty / just background | Nothing visible in the scene; check `summary` — the objects may have failed to be created |

## How many passes

Two or three is normal for anything with structure: blockout → check → refine details → check
→ materials → check. One pass is almost never enough. If you find yourself on the fifth pass
of small tweaks, stop and reconsider the approach rather than nudging numbers.

## In live-app mode

The user is watching the viewport, so they will see a mistake before your preview does. When
they say something looks wrong, look at the preview yourself and fix the model — do not
explain why the code is correct.
