# DSH Blender Modelling

**Let DeepSeek Harness model in Blender — live in front of you, or headless in the background.**

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that connects an agent to
**Blender 5.x**. It ships three things in one package: a Blender addon for live driving, a
headless driver for batch work, and a **skill the plugin installs into DSH** so the agent knows
how to model well.

[中文说明](README.zh.md) · [Changelog](CHANGELOG.md) · [MIT License](LICENSE)

---

## Two modes, one modelling layer

Both modes call **the same** `modeling_ops.py`. The geometry is identical; the difference is
whether you get to watch.

| | **Live-app mode** | **Terminal mode** |
|---|---|---|
| You see the modelling happen | **yes** — every block appears in the Blender viewport | no — only the finished result |
| Needs | Blender running + the bridge addon | just `blender.exe` |
| Good for | exploring, showing the user, tweaking by hand as it goes | batch work, unattended runs, when Blender is closed |

Live-app works by installing a small addon into Blender. The addon listens on localhost; the
plugin sends instructions; **the addon executes them on Blender's main thread** through
`bpy.app.timers`, one at a time. That last detail is the whole trick: `bpy` is not thread-safe,
so a socket thread calling `bpy.ops` directly would crash Blender. Queueing to the main thread
keeps the UI responsive and the operations safe.

## The plugin installs the skill

This is the part worth calling out. The plugin does not just expose HTTP routes — it registers
itself as a **skill provider** through `ctx.skills.registerProvider()`. Install the plugin once
and DSH immediately has a `blender-modeling` skill:

- the skill's one-line description enters the first-turn skill catalog (198 characters — kept
  short on purpose, it is in every conversation's prompt)
- the full instructions load **only when the agent actually models**, so it costs nothing until used
- `references/` carries the instruction schema, the preview-review checklist, and modelling
  recipes, read on demand

No manual `customSkillDirs` configuration.

## The preview loop is why the output is decent

Every pass renders previews and the agent looks at them. That only works if the images are
readable, so the renderer **auto-stages the shot**: it computes the camera distance from the
field of view so the whole model is framed, adds three-point lighting, drops in a ground plane
for shadows and scale, and sets a neutral world.

Measured on a real model, the difference is not cosmetic:

| | before auto-staging | after |
|---|---|---|
| Framing | model cropped, only a corner visible | whole model in frame |
| Colour | grey columns tinted red by the world light | correct colours |
| Readability | black background, no silhouette | clear silhouette and contact shadows |

Without that, "the agent looks at its own render" is theatre.

## Install

```bash
dsh plugin --profile <profile> add dsh-plugin-blender
```

Or from the DSH UI: **Settings → Plugins → install**. Then open
**Settings → Blender 建模 (Blender Modelling)** and click **安装桥接组件** once.

After installing the addon: **restart Blender** so it picks the addon up. You will see a
`DSH` tab in the 3D viewport sidebar. Come back and click *重新检查* — when the status turns
green you can model live.

Blender is found automatically, including **Steam libraries** (`steamapps/common/Blender`).
If yours is somewhere unusual, put the path to `blender.exe` in the Advanced section.

## Requirements

- **Blender 4.2+** (tested on **5.2.2 LTS**). Windows, macOS or Linux.
- Python 3.x for the tooling — no third-party packages, and no build step.
- Live-app mode additionally needs the bridge addon installed (the plugin does that for you).

## Settings page

Plain language throughout:

- **Status card** — Blender found? addon installed? bridge connected? skill registered? Each with
  a green / amber / red dot and an explanation of what to do about it.
- **Install the bridge** — one button, plus the three steps that follow it.
- **Default mode** — *看着建* (watch it being built, live) vs *后台建* (background).
- **Auto-preview** — whether the agent renders previews to check its own work.
- **Try it** — builds a sample model end to end and shows you the renders, so you can confirm the
  whole chain works before asking for something real.
- **Recent output** — `.blend` files and previews, with reveal-in-folder.
- Technical knobs (Blender path, output folder, preview size, bridge port) under *Advanced*.

## Driving it without the UI

```bash
# terminal mode, headless
blender --background --factory-startup --python blender/modeling_driver.py -- \
  --json request.json --out result.json
```

`request.json` carries `instructions` (see the skill's `references/instructions.md`), plus
optional `save`, `render`, `open`, `width`, `height`, `angles`. The driver prints a
`RESULT_JSON=` line and writes the same payload to `--out`.

If `@deepseek-ai/dsh-tools` resolves, the plugin also registers two model-visible tools:
`blender_environment` and `blender_model`.

## Verified on a real machine

Every item below was checked by running actual Blender and looking at the output.

| Check | Result |
|---|---|
| Blender auto-detected | `E:\SteamLibrary\steamapps\common\Blender\blender.exe`, version **5.2.2** |
| Addon install | files copied to `%APPDATA%\Blender Foundation\Blender\5.2\scripts\addons\dsh_blender_bridge` |
| Addon **enabled** and persisted | verified from a clean state — survives a Blender restart |
| Bridge auto-start | starts on Blender launch; `ping` answers `Blender 5.2.2 LTS` |
| **Live-app mode, end to end** | 4 parts built on the main thread, `.blend` 141 KB, 3 previews, **1.2 s** |
| Terminal mode | real `.blend` (94 KB) + 3 preview renders, no factory-default leftovers |
| Modelling layer | 11 operations; boolean cut verified (cube 8 verts → 248 after subtraction) |
| Auto-staging render | framing, exposure and colour cast all fixed and visually confirmed |
| Port collision handling | 8765 was held by an unrelated process; the addon moved to 8766 automatically and published the real port |
| Skill provider | `ctx.skills.registerProvider()` registers `blender-modeling`; coexists with built-in skills; `get()` returns null for unknown names |
| Graceful degradation | no `skills` service → plugin still loads; no `@deepseek-ai/dsh-tools` → tools skipped with a warning |
| Sanitisation | output-file route refuses paths outside the output folder (403) |
| Test suites | `verify` 54 / `render` 21 / `smoke` 27 / `smoke-app` 18 checks — all pass |

### Four bugs that only showed up by running it

Worth recording, because each one was invisible to static checks:

1. **`addon_utils.enable()` does not persist.** It reports success and `save_userpref()` returns
   fine, but a fresh Blender still shows the addon as *not enabled*. Only
   `bpy.ops.preferences.addon_enable` — the operator the preferences UI itself uses — actually
   writes it. The original code used the former, so "installed" never became "working".

2. **`bpy.ops.wm.read_factory_settings()` tears down the running addon.** Using it to clear the
   scene rebuilt Blender's entire state, which unregistered the bridge mid-session: the first
   instruction would succeed and the connection would die immediately after. Clearing data
   blocks directly gives the same empty scene without touching the host.

3. **A `BOM` breaks `json.load`.** PowerShell writes UTF-8 with a BOM by default, and Python's
   `json.load` rejects it outright. The driver now reads `utf-8-sig`.

4. **The skill-provider contract is stricter than the docs suggest — and violations fail
   silently.** The plugin installs its skill through `ctx.skills.registerProvider()`, and the
   first version got four things wrong:

   | | wrong | right |
   |---|---|---|
   | `registerProvider` argument | a provider **object** | a **synchronous factory** — the registry calls `create(control)` |
   | invocation policy | flat `modelInvocable` | nested inside an `invocation` object |
   | candidate fields | `name`/`description`/`path` | also required: `source`, `rank`, `provider` (and `provider` must equal the provider's name) |
   | `get()` argument | the skill **name** | the **candidate object** |

   Any one of these makes `validateCandidate` throw — and the registry **skips a failing provider
   quietly**. The symptom is "the plugin is clearly running, but the skill never appears", with
   nothing in the logs.

   This one is worth dwelling on: my own smoke test *passed* against a mock, because the mock was
   more permissive than the real registry. The fix was not a code change but a **test change** —
   `tools/smoke-skill.mjs` now loads the real `@deepseek-ai/dsh-skill` and `@deepseek-ai/cordis`
   from the profile and registers against them, so a contract mismatch cannot pass. Prefer real
   dependencies over mocks for anything that has a published contract.

5. **A `link:`-installed plugin cannot resolve `@deepseek-ai/*`.** Bare specifiers resolve by
   walking up from the importing file, and a plugin linked in from outside the profile
   (`link:E:/…`) has no DSH packages on that path — so `import('@deepseek-ai/dsh-tools')` failed
   with `MODULE_NOT_FOUND` and my `.catch` swallowed it. Same silent class of failure: the
   model-visible tools simply never existed. Now resolved through explicit candidate bases (the
   plugin's own location, then each `$DSH_HOME/profiles/<name>`, then `~/.dsh/profiles`) via
   `createRequire`, so one code path works whether the plugin is linked or installed.

6. **DSH's JSON Schema subset requires `additionalProperties` on objects.** With resolution fixed,
   the tools *still* failed to register:

   ```
   unsupported JSON schema:
   parameters.instructions.items.additionalProperties must be explicitly true or false
   ```

   `items: { type: 'object' }` is rejected; it must carry an explicit `additionalProperties`.
   And one invalid parameter fails the **whole** `defineTool` call, so both tool definitions were
   lost together — two independent bugs both had to be fixed before a single tool appeared.

7. **A synchronous skill provider crashes the real host with `promise.then is not a function`.**
   This is the one that surfaced in actual use. The registry wraps provider calls like this:

   ```js
   function waitWithAbort(promise, signal) {
     if (signal === void 0) return promise;   // no signal → passes the value straight through
     ...
     promise.then(...)                        // signal present → calls .then directly
   }
   ```

   `list()` and `get()` originally returned arrays/objects synchronously. The registry tolerates
   that when no signal is passed — and the real host **always** passes `options.signal`, so the
   sync return hit `.then` on an array. Both are `async` now.

   The testing lesson repeats and sharpens: my integration test called `list({ cwd })` without a
   signal, so it exercised the early return and stayed green. Passing an `AbortSignal` in
   `tools/smoke-skill.mjs` makes the failure reproducible — I confirmed the test goes red before
   the fix and green after, rather than trusting it either way.

## Develop

No build step and no dependencies to install to work on this:

```bash
node tools/verify.mjs            # static: syntax, manifest invariants, engineering rules, skill structure
node tools/render.mjs            # render the settings page against canned data and assert its content
node tools/smoke.mjs             # simulate the Host: load the plugin, exercise every route
node tools/smoke.mjs --blender   # ...and actually model something (needs Blender installed)
node tools/smoke-app.mjs         # live-app mode end to end: install addon, launch Blender, model live
```

`verify.mjs` and `render.mjs` need nothing but Node, and are what CI runs. `smoke-app.mjs` is
the only one that launches a visible Blender window — it installs the addon for real, so run it
when you want to prove the live path works.

They cover the rules that bite hardest in this environment:

1. **No static `@deepseek-ai/*` import** — a profile-installed plugin cannot resolve those
   packages, so a static import fails at load.
2. **Never export `Config`** — it needs `schemastery`, which is equally unresolvable.
3. **The addon must schedule through `bpy.app.timers`** — otherwise `bpy` runs off the main
   thread and crashes Blender.
4. **The addon must never call `read_factory_settings` to clear the scene** — it unregisters the
   bridge out from under itself (see the bug list above).
5. **The driver must read its request as `utf-8-sig`** — a BOM (which PowerShell writes by
   default) breaks `json.load` outright.

## Repository layout

```
dsh-plugin-blender/
├─ index.js               Host half: Blender detection, addon install, skill provider, both modes
├─ client.js              Browser half: the settings page
├─ blender/
│  ├─ modeling_ops.py     the shared instruction layer  ─┐
│  ├─ preview_render.py   auto-staged preview renders    ├─ both modes call these
│  ├─ modeling_driver.py  headless driver (terminal mode)┘
│  └─ addon/__init__.py   bridge addon (live-app mode)
├─ skills/
│  └─ blender-modeling/
│     ├─ SKILL.md         what the agent reads first
│     └─ references/      instruction schema, preview review, recipes
└─ tools/                 verify.mjs · render.mjs · smoke.mjs
```

When the plugin installs the addon it copies `modeling_ops.py`, `preview_render.py` and
`modeling_driver.py` next to the addon so it is self-contained and does not depend on the
plugin's source staying where it is.

## Known limits

- **No Cycles.** The bundled Blender build in testing exposes EEVEE. Previews are fast and
  readable but not photoreal; if you need that, render the `.blend` yourself with a Cycles build.
- **Placeholders, not characters.** The toolset builds from primitives, booleans and modifiers.
  There is no sculpting, retopology or rigging — organic figures come out coarse, and the skill
  says so rather than pretending otherwise.
- **Live-app mode needs Blender open.** If it is closed, use terminal mode.
- **Installing the addon requires restarting Blender** for it to appear in preferences. The
  service itself starts on registration, so an already-open Blender can still be driven once the
  addon files are in place and it reloads.

## License

[MIT](LICENSE)
