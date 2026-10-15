# Instruction reference

The instruction layer is one Python module (`modeling_ops.py`) executed identically in both
modes. An instruction is a JSON object with an `op` key. Every instruction returns a
serializable result; a failure raises a readable error and **does not** silently continue.

## Primitives

```json
{"op": "primitive", "kind": "cube", "name": "base", "size": 2, "location": [0,0,1],
 "scale": [1,1,0.5], "rotation": [0,0,45], "shading": "flat"}
```

| `kind` | extra keys | note |
|---|---|---|
| `cube` | `size` | edge length |
| `sphere` | `radius` | UV sphere, 32×16 |
| `ico_sphere` | `radius`, `subdivisions` | even topology, better for subdivision |
| `cylinder` | `radius`, `depth`, `vertices` | |
| `cone` | `radius`, `depth` | |
| `torus` | `major_radius`, `minor_radius` | |
| `plane` | `size` | flat, no thickness |
| `monkey` | `size` | Suzanne, use for quick tests |
| `capsule` | `radius`, `length` | stretched sphere |

`rotation` is in **degrees** (the layer converts to radians). `shading` is `"smooth"` or `"flat"`.

**Always pass `name`.** Unnamed objects become `Cube.001` and every later instruction that
targets them becomes guesswork.

## Transform

```json
{"op": "transform", "target": "base", "location": [0,0,2], "rotation": [0,0,90], "scale": [2,1,1]}
```

Only the keys you pass are applied. `location` is absolute, not relative.

## Material

```json
{"op": "material", "targets": ["base","lid"], "name": "steel",
 "base_color": [0.35,0.38,0.42], "metallic": 0.9, "roughness": 0.25}
```

`base_color` is **linear RGB in 0..1**, not hex and not 0..255. `metallic` 0..1,
`roughness` 0..1. Give each visually distinct part its own material — it is the cheapest way
to make the preview readable and to let the user tell parts apart.

Quick palette that reads well against the dark preview background:

| want | base_color | metallic | roughness |
|---|---|---|---|
| steel | `[0.35,0.38,0.42]` | 0.9 | 0.25 |
| brass | `[0.75,0.55,0.2]` | 1.0 | 0.3 |
| plastic red | `[0.8,0.12,0.1]` | 0.0 | 0.45 |
| plastic blue | `[0.15,0.35,0.8]` | 0.0 | 0.45 |
| matte white | `[0.85,0.85,0.85]` | 0.0 | 0.7 |
| rubber black | `[0.04,0.04,0.05]` | 0.0 | 0.85 |
| wood | `[0.45,0.28,0.15]` | 0.0 | 0.6 |
| glass-ish | `[0.8,0.9,0.95]` | 0.0 | 0.05 |

## Boolean

```json
{"op": "boolean", "target": "base", "tool": "drill", "mode": "DIFFERENCE"}
```

Modes: `DIFFERENCE` (cut), `UNION` (merge), `INTERSECT`. The modifier is applied immediately
so the cut is visible at once. `"delete_tool": false` keeps the cutter object.

The tool object **must exist** when this runs. Create the cutter first, in the same batch or an
earlier one. After a `DIFFERENCE` the tool is deleted by default — do not reference it later.

## Modifiers

```json
{"op": "bevel",     "target": "base", "width": 0.05, "segments": 2}
{"op": "subdivide", "target": "base", "levels": 2}
{"op": "mirror",    "target": "half", "axis": "X"}
{"op": "array",     "target": "post", "count": 5, "offset": [1.2,0,0]}
```

All are applied immediately (not left live) so both modes see the same result and the preview
matches the saved file. `bevel` width is in scene units — scale it with the model, a 0.05 bevel
is invisible on a 10 m object and destroys a 0.1 m one.

## Object management

```json
{"op": "duplicate",  "target": "ball", "new_name": "ball_r", "offset": [1.6,0,0]}
{"op": "delete",     "target": "drill"}
{"op": "group_join", "targets": ["wall_a","wall_b"], "name": "walls"}
{"op": "annotate",   "text": "现在开始加倒角"}
```

`annotate` produces no geometry — it reports progress to the user in live-app mode. Use it
between phases so the user can follow what is happening.

## Two other commands (not modelling ops)

- `reset` — clear the scene to an empty, deterministic state. **Start every job with it**,
  otherwise leftover objects from a previous run make names drift to `.001`.
- `summary` — a serializable snapshot: every object with name, type, location, scale, and for
  meshes the vertex/polygon counts and materials. Read this to confirm what actually exists
  instead of assuming your instructions all succeeded.

## Reading errors

Errors name the problem and list what is available, for example:

```
找不到物体 'lid'。当前场景里有：['base', 'post', 'ring']
```

That listing is the point — it tells you the previous instruction failed, or you forgot to
create the object. Fix the actual cause; do not retry the same instruction.
