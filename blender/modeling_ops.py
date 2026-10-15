#!/usr/bin/env python
"""共享建模指令层 —— 两种模式跑的是同一份代码。

设计要点：
  · 这里只有「把一条指令变成 bpy 操作」的纯逻辑，不碰网络、不碰 stdin。
  · APP 模式：addon 在主线程收到指令 dict，调用 apply_instruction()。
  · 终端模式：驱动脚本读 JSON，逐条 apply_instruction()。
  · 因为两种模式共用本文件，所以「终端模式效果差一点」的差别只来自
    「看不到中间结果、无法及时纠偏」，不是 API 能力受限。

指令形态（dict）：
  {"op": "primitive", "kind": "cube", "name": "...", "location": [x,y,z], "scale": [x,y,z], ...}
  {"op": "transform",  "target": "name", "location": [...], "rotation": [...], "scale": [...]}
  {"op": "material",   "target": "name", "base_color": [r,g,b,a], "metallic": f, "roughness": f}
  {"op": "boolean",    "target": "name", "tool": "name", "mode": "DIFFERENCE"}
  {"op": "bevel",      "target": "name", "width": f, "segments": n}
  {"op": "subdivide",  "target": "name", "levels": n}
  {"op": "mirror",     "target": "name", "axis": "X"}
  {"op": "array",      "target": "name", "count": n, "offset": [x,y,z]}
  {"op": "delete",     "target": "name"}
  {"op": "duplicate",  "target": "name", "new_name": "...", "offset": [x,y,z]}
  {"op": "group_join", "targets": [...], "name": "..."}
  {"op": "annotate",   "text": "说明文字"}
"""

import math

import bpy


# --------------------------------------------------------------- 场景基础 ---

def reset_scene():
    """清空场景，得到一个确定性的起点（两种模式都从这里开始）。

    ⚠️ 刻意**不用** `bpy.ops.wm.read_factory_settings()`：
    那会重建整个 Blender 状态，在 GUI 里运行时会把正在干活的 addon 一并卸载
    （桥接的 socket 线程与主线程 timer 随 register/unregister 一起消失），
    表现为「发出一条指令之后连接就断了」。这是实测踩到的 bug。

    直接删数据块同样能得到空场景，而且不会动宿主：
    Blender 出厂自带的 Cube / Camera / Light 也是普通物体，一样被删掉。
    """
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    # 清掉失去用户的数据块，避免多次运行后名字带 .001
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights,
                 bpy.data.cameras, bpy.data.curves):
        for item in list(coll):
            if getattr(item, "users", 0) == 0:
                try:
                    coll.remove(item)
                except Exception:  # noqa: BLE001
                    pass
    return {"cleared": True}


def _resolve(name):
    """按名字找物体；找不到给出清晰错误（而不是抛 KeyError 让 agent 猜）。"""
    obj = bpy.data.objects.get(name)
    if obj is None:
        available = sorted(o.name for o in bpy.data.objects)
        raise ValueError("找不到物体 %r。当前场景里有：%s" % (name, available or "(空)"))
    return obj


def _deselect_all():
    for obj in bpy.context.selected_objects:
        obj.select_set(False)


def _make_active(obj):
    _deselect_all()
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def _vec(value, default=(0.0, 0.0, 0.0)):
    if value is None:
        return list(default)
    if isinstance(value, (int, float)):
        return [float(value)] * 3
    out = [float(v) for v in value][:3]
    while len(out) < 3:
        out.append(0.0)
    return out


# ------------------------------------------------------------- 图元创建 ---

#: kind -> (bpy 算子名, 额外参数)
PRIMITIVES = {
    "cube": ("primitive_cube_add", {}),
    "sphere": ("primitive_uv_sphere_add", {"segments": 32, "ring_count": 16}),
    "ico_sphere": ("primitive_ico_sphere_add", {"subdivisions": 2}),
    "cylinder": ("primitive_cylinder_add", {"vertices": 32}),
    "cone": ("primitive_cone_add", {"vertices": 32}),
    "torus": ("primitive_torus_add", {"major_segments": 48, "minor_segments": 12}),
    "plane": ("primitive_plane_add", {}),
    "monkey": ("primitive_monkey_add", {}),
    "capsule": ("primitive_uv_sphere_add", {"segments": 24, "ring_count": 12}),
}


def add_primitive(inst):
    kind = str(inst.get("kind") or "cube").lower()
    if kind not in PRIMITIVES:
        raise ValueError("不支持的图元 %r；可用：%s" % (kind, ", ".join(sorted(PRIMITIVES))))
    op_name, defaults = PRIMITIVES[kind]

    kwargs = {}
    if kind == "cube":
        kwargs["size"] = float(inst.get("size", 1.0))
    elif kind in ("sphere", "ico_sphere"):
        kwargs["radius"] = float(inst.get("radius", inst.get("size", 0.5) / 2 if "size" in inst else 1.0))
    elif kind == "cylinder":
        kwargs["radius"] = float(inst.get("radius", 0.5))
        kwargs["depth"] = float(inst.get("depth", 2.0))
    elif kind == "cone":
        kwargs["radius1"] = float(inst.get("radius", 0.5))
        kwargs["depth"] = float(inst.get("depth", 2.0))
    elif kind == "torus":
        kwargs["major_radius"] = float(inst.get("major_radius", 1.0))
        kwargs["minor_radius"] = float(inst.get("minor_radius", 0.25))
    elif kind == "plane":
        kwargs["size"] = float(inst.get("size", 2.0))
    elif kind == "monkey":
        kwargs["size"] = float(inst.get("size", 2.0))
    elif kind == "capsule":
        kwargs["radius"] = float(inst.get("radius", 0.5))
    kwargs.update({k: v for k, v in defaults.items() if k not in kwargs})

    kwargs["location"] = _vec(inst.get("location"))
    if inst.get("rotation") is not None:
        kwargs["rotation"] = _vec(inst.get("rotation"))

    getattr(bpy.ops.mesh, op_name)(**kwargs)
    obj = bpy.context.active_object

    if kind == "capsule":
        # 球体拉长成胶囊
        length = float(inst.get("length", 1.5))
        obj.scale = (1.0, 1.0, length / max(1e-6, kwargs["radius"] * 2))
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    if inst.get("scale") is not None:
        obj.scale = _vec(inst.get("scale"), (1.0, 1.0, 1.0))
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # 用户给了名字就用用户的，否则保留 Blender 自动名（Cube、Cube.001 …）
    if inst.get("name"):
        obj.name = str(inst["name"])
        if obj.data is not None:
            obj.data.name = str(inst["name"])

    _shade(inst, obj)
    return {"created": obj.name, "kind": kind, "location": list(obj.location)}


def _shade(inst, obj):
    """可选：平滑着色 / 自动平滑。"""
    mode = inst.get("shading")
    if not mode:
        return
    _make_active(obj)
    if mode == "smooth":
        bpy.ops.object.shade_smooth()
    elif mode == "flat":
        bpy.ops.object.shade_flat()


# ------------------------------------------------------------- 变换 / 材质 ---

def transform(inst):
    obj = _resolve(inst["target"])
    if inst.get("location") is not None:
        obj.location = _vec(inst["location"])
    if inst.get("rotation") is not None:
        rot = _vec(inst.get("rotation"))
        obj.rotation_euler = [math.radians(a) for a in rot]
    if inst.get("scale") is not None:
        obj.scale = _vec(inst.get("scale"), (1.0, 1.0, 1.0))
    return {"transformed": obj.name}


def _get_or_make_material(name, color, metallic, roughness, emission=None):
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        for node in mat.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                bsdf = node
                break
    if bsdf is not None:
        rgba = list(_vec(color, (0.8, 0.8, 0.8)))
        bsdf.inputs["Base Color"].default_value = (rgba[0], rgba[1], rgba[2], 1.0)
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = float(metallic)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = float(roughness)
        if emission is not None and "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = float(emission)
    # 材质预览色（视口里也能看出颜色）
    rgba = list(_vec(color, (0.8, 0.8, 0.8)))
    mat.diffuse_color = (rgba[0], rgba[1], rgba[2], 1.0)
    return mat


def material(inst):
    targets = inst.get("targets") or ([inst["target"]] if inst.get("target") else [])
    if not targets:
        raise ValueError("material 指令需要 target 或 targets")
    name = str(inst.get("name") or "mat")
    color = inst.get("base_color") or inst.get("color") or [0.8, 0.8, 0.8]
    mat = _get_or_make_material(
        name, color,
        float(inst.get("metallic", 0.0)),
        float(inst.get("roughness", 0.5)),
        inst.get("emission"),
    )
    applied = []
    for target in targets:
        obj = _resolve(target)
        if obj.data is not None and hasattr(obj.data, "materials"):
            obj.data.materials.clear()
            obj.data.materials.append(mat)
            applied.append(obj.name)
    return {"material": mat.name, "applied_to": applied}


# --------------------------------------------------------- 布尔 / 细分等 ---

def boolean(inst):
    obj = _resolve(inst["target"])
    tool = _resolve(inst["tool"])
    mode = str(inst.get("mode") or "DIFFERENCE").upper()
    _make_active(obj)
    mod = obj.modifiers.new(name="bool_%s" % tool.name, type="BOOLEAN")
    mod.operation = mode
    mod.object = tool
    # 立刻应用，让结果在界面上马上可见（APP 模式要看到过程）
    bpy.ops.object.modifier_apply(modifier=mod.name)
    if inst.get("delete_tool", True):
        bpy.data.objects.remove(tool, do_unlink=True)
    return {"boolean": obj.name, "mode": mode}


def bevel(inst):
    obj = _resolve(inst["target"])
    _make_active(obj)
    mod = obj.modifiers.new(name="bevel", type="BEVEL")
    mod.width = float(inst.get("width", 0.05))
    mod.segments = int(inst.get("segments", 2))
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return {"beveled": obj.name}


def subdivide(inst):
    obj = _resolve(inst["target"])
    _make_active(obj)
    mod = obj.modifiers.new(name="subsurf", type="SUBSURF")
    mod.levels = int(inst.get("levels", 1))
    mod.render_levels = int(inst.get("levels", 1))
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return {"subdivided": obj.name}


def mirror(inst):
    obj = _resolve(inst["target"])
    axis = str(inst.get("axis") or "X").upper()
    _make_active(obj)
    mod = obj.modifiers.new(name="mirror", type="MIRROR")
    for index, letter in enumerate("XYZ"):
        mod.use_axis[index] = (letter == axis)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return {"mirrored": obj.name, "axis": axis}


def array(inst):
    obj = _resolve(inst["target"])
    _make_active(obj)
    mod = obj.modifiers.new(name="array", type="ARRAY")
    mod.count = int(inst.get("count", 3))
    mod.use_relative_offset = False
    mod.use_constant_offset = True
    mod.constant_offset_displace = _vec(inst.get("offset"), (1.0, 0.0, 0.0))
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return {"arrayed": obj.name, "count": mod.count}


def duplicate(inst):
    obj = _resolve(inst["target"])
    _make_active(obj)
    bpy.ops.object.duplicate()
    copy = bpy.context.active_object
    copy.location = [obj.location[i] + _vec(inst.get("offset"))[i] for i in range(3)]
    if inst.get("new_name"):
        copy.name = str(inst["new_name"])
    return {"duplicated": obj.name, "new": copy.name}


def delete(inst):
    obj = _resolve(inst["target"])
    name = obj.name
    bpy.data.objects.remove(obj, do_unlink=True)
    return {"deleted": name}


def group_join(inst):
    targets = inst.get("targets") or []
    if len(targets) < 2:
        raise ValueError("group_join 至少需要两个 targets")
    objs = [_resolve(t) for t in targets]
    first = objs[0]
    _deselect_all()
    for obj in objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = first
    bpy.ops.object.join()
    if inst.get("name"):
        first.name = str(inst["name"])
    return {"joined_into": first.name, "members": len(objs)}


# ------------------------------------------------------------------ 调度 ---

#: op 名 -> 处理函数
OPERATIONS = {
    "primitive": add_primitive,
    "transform": transform,
    "material": material,
    "boolean": boolean,
    "bevel": bevel,
    "subdivide": subdivide,
    "mirror": mirror,
    "array": array,
    "duplicate": duplicate,
    "delete": delete,
    "group_join": group_join,
}


def apply_instruction(inst):
    """执行一条指令。返回可序列化的结果 dict；失败抛 ValueError。

    这是两种模式唯一的公共入口 —— APP 模式的 addon 和终端模式的驱动
    都调它，所以行为完全一致。
    """
    if not isinstance(inst, dict):
        raise ValueError("指令必须是对象，收到 %s" % type(inst).__name__)
    op = str(inst.get("op") or "").strip()
    if op == "annotate":
        # 纯给用户看的进度说明，不产生几何
        return {"annotated": str(inst.get("text") or "")}
    handler = OPERATIONS.get(op)
    if handler is None:
        raise ValueError("未知指令 op=%r；可用：%s" % (op, ", ".join(sorted(OPERATIONS))))
    return handler(inst)


def scene_summary():
    """当前场景的可序列化快照 —— 给 agent 判断「建出来没有」。"""
    objects = []
    for obj in bpy.data.objects:
        entry = {
            "name": obj.name,
            "type": obj.type,
            "location": [round(v, 4) for v in obj.location],
            "scale": [round(v, 4) for v in obj.scale],
        }
        if obj.type == "MESH" and obj.data is not None:
            entry["vertices"] = len(obj.data.vertices)
            entry["polygons"] = len(obj.data.polygons)
            entry["materials"] = [m.name for m in obj.data.materials if m]
        objects.append(entry)
    return {"objects": objects, "count": len(objects)}
