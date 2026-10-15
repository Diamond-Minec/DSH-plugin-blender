#!/usr/bin/env python
"""预览渲染 —— 给「看图自纠」闭环提供可判读的画面。

为什么需要专门做这件事：默认渲染出来的东西往往没法看 ——
相机没对准（只看到模型一角）、背景全黑、没有地面和阴影、材质一片灰。
agent 拿这种图判断不了「像不像」，闭环就白做了。

所以这里做「自动布景」：
  1. 按场景包围盒自动取景（相机拉到能框住整个模型的角度）
  2. 三点光（主光 + 补光 + 轮廓光），保证形体可读
  3. 加一块地面接收阴影，给模型一个「站得住」的参照
  4. 设置世界背景色（否则背景是纯黑，看不出轮廓）
  5. 多角度出图（正前 / 斜 45° / 侧面），一次给 agent 更多信息

本模块两种模式共用。
"""

import math
import os

import bpy
from mathutils import Vector


def _scene_bounds():
    """所有「属于模型」的可见物体的世界坐标包围盒。空场景返回 None。

    刻意跳过预览自己加的东西（相机、灯、地面）以及 Blender 出厂自带的
    默认相机/灯 —— 否则一个远处的默认灯就能把包围盒撑大，
    自动取景会莫名其妙地把模型拍成一个小点。
    """
    skip_prefixes = ("Preview",)
    skip_names = {"Camera", "Light", "Lamp"}
    points = []
    for obj in bpy.data.objects:
        if obj.type != "MESH" or obj.hide_render:
            continue
        if obj.name in skip_names:
            continue
        if any(obj.name.startswith(p) for p in skip_prefixes):
            continue
        for corner in obj.bound_box:
            points.append(obj.matrix_world @ Vector(corner))
    if not points:
        return None
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return lo, hi


def setup_world(rgb=(0.05, 0.055, 0.07), strength=0.35):
    """世界背景。

    注意 strength 要压得比较低：世界色既是「背景」也是 EEVEE 的**环境光来源**，
    调亮了会把模型染成背景的颜色（实测蓝色背景会把灰柱子染成偏红）。
    所以这里只给一点点环境光提亮暗部，真正的照明交给三点灯。
    """
    world = bpy.data.worlds.get("PreviewWorld") or bpy.data.worlds.new("PreviewWorld")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs[0].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
        bg.inputs[1].default_value = float(strength)
    bpy.context.scene.world = world
    return world


def setup_lights(center, radius):
    """三点光。已存在的预览灯先清掉，避免重复运行越堆越多。"""
    for obj in list(bpy.data.objects):
        if obj.type == "LIGHT" and obj.name.startswith("PreviewLight"):
            bpy.data.objects.remove(obj, do_unlink=True)

    distance = max(radius * 3.0, 4.0)
    specs = [
        # (名字, 方位, 强度倍数, 尺寸倍数)
        ("PreviewLight_Key", (1.0, -1.2, 1.1), 1.0, 2.0),
        ("PreviewLight_Fill", (-1.2, -0.8, 0.4), 0.45, 3.0),
        ("PreviewLight_Rim", (-0.4, 1.4, 0.9), 0.75, 1.5),
    ]
    created = []
    for name, direction, factor, size_mult in specs:
        vec = Vector(direction).normalized() * distance
        bpy.ops.object.light_add(type="AREA", location=center + vec)
        light = bpy.context.active_object
        light.name = name
        # 强度随场景尺度平方缩放，大小场景都曝光正确
        light.data.energy = max(50.0, 55.0 * factor * radius * radius)
        light.data.size = max(0.5, radius * size_mult)
        # 让灯朝向场景中心
        look = (center - light.location).normalized()
        light.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()
        created.append(name)
    return created


def setup_ground(lo, radius):
    """地面：给模型一个参照平面并接收阴影。"""
    existing = bpy.data.objects.get("PreviewGround")
    if existing is not None:
        bpy.data.objects.remove(existing, do_unlink=True)

    size = max(radius * 8.0, 12.0)
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, lo.z - 0.001))
    ground = bpy.context.active_object
    ground.name = "PreviewGround"

    mat = bpy.data.materials.get("PreviewGroundMat") or bpy.data.materials.new("PreviewGroundMat")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (0.16, 0.17, 0.19, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.85
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.0
    ground.data.materials.clear()
    ground.data.materials.append(mat)
    return ground.name


def _fit_distance(camera, center, radius, margin=1.35):
    """算出让整个包围球恰好入镜的距离（而不是拍脑袋乘一个系数）。

    用相机的**有效视场角**反推：取水平/垂直中较小的那个，
    再按包围球半径算距离，最后乘一个边距系数。
    这样无论模型多大、画幅多宽，都能框住。
    """
    scene = bpy.context.scene
    render = scene.render
    aspect = (render.resolution_x / max(1, render.resolution_y)) if render.resolution_y else 1.333

    # 传感器宽度（默认 36mm）与镜头焦距决定水平视场
    sensor = camera.data.sensor_width or 36.0
    lens = max(1e-3, camera.data.lens)
    fov_x = 2.0 * math.atan((sensor * 0.5) / lens)
    fov_y = 2.0 * math.atan((sensor * 0.5 / aspect) / lens)
    fov = min(fov_x, fov_y)

    if radius < 1e-6:
        radius = 0.5
    # 包围球恰好内切视锥所需的距离
    return (radius * margin) / math.sin(fov * 0.5)


def _aim_camera(camera, center, radius, azimuth_deg, elevation_deg=20.0, margin=1.35):
    """把相机摆在球坐标上、朝向中心，并自动拉到能框住整个模型的距禈。"""
    distance = _fit_distance(camera, center, radius, margin)
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    offset = Vector((
        math.cos(el) * math.cos(az),
        math.cos(el) * math.sin(az),
        math.sin(el),
    )) * distance
    camera.location = center + offset
    direction = (center - camera.location).normalized()
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return distance


def make_camera(center, radius, azimuth_deg):
    cam_data = bpy.data.cameras.get("PreviewCam") or bpy.data.cameras.new("PreviewCam")
    cam_data.lens = 50.0
    cam = bpy.data.objects.get("PreviewCamObj")
    if cam is None:
        cam = bpy.data.objects.new("PreviewCamObj", cam_data)
        bpy.context.scene.collection.objects.link(cam)
    cam.data = cam_data
    _aim_camera(cam, center, radius, azimuth_deg)
    bpy.context.scene.camera = cam
    return cam


def configure_render(width, height, samples=32):
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        pass
    # EEVEE 的抗锯齿/采样设置（不同小版本属性名有差异，逐项容错）
    eevee = getattr(scene, "eevee", None)
    if eevee is not None:
        for attr, value in (("taa_render_samples", samples), ("use_gtao", True),
                            ("use_shadows", True), ("use_raytracing", True)):
            if hasattr(eevee, attr):
                try:
                    setattr(eevee, attr, value)
                except Exception:
                    pass
    scene.render.resolution_x = int(width)
    scene.render.resolution_y = int(height)
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    try:
        scene.view_settings.view_transform = "Standard"
    except TypeError:
        pass
    return scene.render.engine


def render_previews(out_dir, width=640, height=480, angles=None, samples=32, prefix="preview"):
    """渲染一组预览图。

    @returns {"engine": str, "shots": [{"angle": int, "path": str, "bytes": int}], "notes": [str]}
    """
    os.makedirs(out_dir, exist_ok=True)
    notes = []

    bounds = _scene_bounds()
    if bounds is None:
        notes.append("场景里没有可见网格，渲染的是空背景。")
        center = Vector((0, 0, 0))
        radius = 1.0
    else:
        lo, hi = bounds
        center = (lo + hi) / 2.0
        size = hi - lo
        radius = max(size.x, size.y, size.z) / 2.0
        if radius < 1e-3:
            radius = 0.5
            notes.append("场景尺寸接近 0，用了最小取景半径。")

    # 让相机大致水平地对准模型中心高度（避免俯视导致形体压扁）
    if bounds is not None:
        center = Vector((center.x, center.y, center.z))

    engine = configure_render(width, height, samples)
    setup_world()
    setup_lights(center, radius)
    if bounds is not None and bounds[0].z > -0.5:
        try:
            setup_ground(bounds[0], radius)
        except Exception as exc:
            notes.append("地面创建失败（不影响出图）：%s" % exc)

    if angles is None:
        angles = [0, 45, 135]

    shots = []
    for angle in angles:
        make_camera(center, radius, angle)
        path = os.path.join(out_dir, "%s_%03d.png" % (prefix, angle))
        bpy.context.scene.render.filepath = path
        try:
            bpy.ops.render.render(write_still=True)
        except Exception as exc:
            notes.append("角度 %s° 渲染失败：%s" % (angle, exc))
            continue
        if os.path.exists(path):
            shots.append({"angle": angle, "path": path, "bytes": os.path.getsize(path)})
        else:
            notes.append("角度 %s° 没有产出文件" % angle)

    return {"engine": engine, "shots": shots, "notes": notes}
