# Recipes

Worked patterns for the things people actually ask for. These are approaches, not literal
instruction lists — adapt the numbers to the requested size.

## General method

1. `reset`
2. **Blockout pass** — every major volume as a rough primitive, correct positions and
   proportions, one flat material. Preview it.
3. **Refinement pass** — booleans for cuts and holes, bevels on hard edges, subdivide where it
   should be smooth, arrays for anything repeated. Preview it.
4. **Material pass** — give each distinct part a material. Preview it.
5. Save.

Two or three previews per model is normal. The blockout is where you catch proportion errors,
and they are cheap to fix there and expensive later.

## Hard surface / product

The strongest fit for this toolset — primitives plus boolean plus bevel covers most of it.

- Build the **primary body** from a cube or cylinder at the correct aspect ratio, not a
  default cube scaled afterwards.
- **Cut with booleans**, don't model the shape directly. A hole, a slot, a recess, a port: make
  a cutter primitive, boolean `DIFFERENCE`, and let the tool object be deleted.
  - For a round hole through a flat panel: cylinder rotated 90° on X, boolean difference.
  - For a chamfered slot: cube cutter, then bevel the target's edges afterwards.
- **Bevel every hard edge slightly** — 1–3% of the object's smallest dimension, 2 segments.
  Zero bevel reads as CG; a bevel that is too large destroys the shape.
- **Repeat with `array`**, never by hand. Vent slots, fins, ribs, bolt rings.
- **Use `mirror` for symmetry** — build one half, mirror, join. Faster and guarantees symmetry.
- **Torus for rings, collars, gaskets, handles.** A torus is `major_radius` minus
  `minor_radius` from the centre at its inner edge — account for that or it will intersect.
- Materials: metal parts get `metallic` 0.8–1.0 and `roughness` 0.2–0.35; plastic and painted
  parts get `metallic` 0 and `roughness` 0.4–0.6. One accent colour reads better than five.

## Props / low-poly scene

- Build from primitives at final scale; do not rely on scaling after the fact.
- `ico_sphere` with `subdivisions` 2 gives even, clean topology — better than a UV sphere for
  organic-ish props.
- `bevel` where the object is hand-held, `shading: "smooth"` where it is organic.
- Slight irregularity (a small rotation on a duplicated object) stops a repeated row from
  looking mechanical.
- Keep the poly count honest: subdivide once for smoothness, not three times "to be safe".

## Architecture / blockout

- The ground plane already exists in the preview. Place walls and floors at exact coordinates
  rather than approximately — gaps between walls are glaring in a preview.
- A wall is a cube scaled thin, not a plane; planes have no thickness and look wrong edge-on.
- Cut windows and doors with booleans **after** the walls are in place.
- `array` for windows along a facade and for stair treads.
- Use a single material for all structural surfaces and one accent for trim; it reads as a
  deliberate blockout rather than an unfinished model.

## Organic / character placeholder

Be honest about the limit: this toolset makes **coarse placeholders**, not characters.
There is no sculpting, no retopology, no rigging.

- Build a mannequin from capsules, spheres and a cube torso, with correct proportions.
- `subdivide` once (twice at most) and `shading: "smooth"` to take the faceted edge off.
- Use it for scale reference, composition, staging — and tell the user plainly that it is a
  placeholder, because it will not become a real character by refining it.

## Common numbers worth remembering

- Human figure: 1.7 m tall, head ~0.23 m.
- Chair: seat 0.45 m high, back to ~1.0 m.
- Table: top at 0.75 m, thickness 0.04 m.
- Mug: 0.09 m diameter, 0.10 m tall.
- Door: 2.05 m tall, 0.9 m wide.
- Two-storey house: ~6 m tall.

Guessing these wrong is the single most common reason a model looks wrong.
