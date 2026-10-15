#!/usr/bin/env python
"""终端模式驱动 —— 用 blender --background --python 跑一批建模指令。

它和 APP 模式调的是**同一个** modeling_ops.apply_instruction()，
所以两者建出来的几何完全一致。差别只在于：
  · 终端模式看不到中间过程（Blender 没有界面）
  · 因此更适合批量、自动化、无人值守的场景

用法（由插件宿主半边调用）：
    blender --background --factory-startup --python modeling_driver.py -- \
        --json request.json --out result.json

request.json:
{
  "instructions": [ {...}, {...} ],
  "save":     "C:/out/scene.blend",     # 可选
  "render":   "C:/out/preview",         # 可选，渲染目录
  "width": 640, "height": 480,          # 可选，渲染尺寸
  "angles": [0, 45, 135],               # 可选
  "open":     "C:/in/existing.blend"    # 可选，先打开一个已有文件再改
}

result.json（以及 stdout 里的 RESULT_JSON 行）：
{"ok": bool, "code": str, "reason": str, "data": {...}}
"""

import json
import os
import sys
import traceback

import bpy

# Blender 会用 `--` 之后的内容当脚本参数；没给 `--` 时退化为取全部
argv = sys.argv
args = argv[argv.index("--") + 1:] if "--" in argv else []


def _arg(name, default=None):
    if name in args:
        index = args.index(name)
        if index + 1 < len(args):
            return args[index + 1]
    return default


HERE = os.path.dirname(os.path.abspath(__file__))
# 共享建模指令层就在驱动脚本旁边（安装后是同目录）
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import modeling_ops  # noqa: E402
import preview_render  # noqa: E402


def emit(payload, out_path=None):
    """结果写到 --out 指定的文件；同时打一行带前缀的 JSON 方便宿主抓取。"""
    text = json.dumps(payload, ensure_ascii=False)
    if out_path:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False, indent=2))
        except OSError as exc:
            print("写结果文件失败: %s" % exc, file=sys.stderr)
    print("RESULT_JSON=" + text, flush=True)


def main():
    request_path = _arg("--json")
    out_path = _arg("--out")

    if not request_path:
        emit({"ok": False, "code": "bad-request", "reason": "缺少 --json <请求文件>", "data": {}}, out_path)
        return 2

    try:
        # 用 utf-8-sig 读：Windows 上的 PowerShell / 记事本 / 某些编辑器
        # 写 UTF-8 时会带 BOM，而带 BOM 的 JSON 用 utf-8 解会直接失败。
        # 这不是理论问题 —— 实测中就踩到了。
        with open(request_path, encoding="utf-8-sig") as handle:
            request = json.load(handle)
    except (OSError, ValueError) as exc:
        emit({"ok": False, "code": "bad-request", "reason": "读不了请求文件：%s" % exc, "data": {}}, out_path)
        return 2

    # 先打开已有文件（可选）—— 让"改现有模型"成为可能
    open_path = request.get("open")
    if open_path:
        if not os.path.exists(open_path):
            emit({"ok": False, "code": "not-found", "reason": "要打开的文件不存在：%s" % open_path, "data": {}}, out_path)
            return 1
        try:
            bpy.ops.wm.open_mainfile(filepath=open_path)
        except Exception as exc:  # noqa: BLE001
            emit({"ok": False, "code": "open-failed",
                  "reason": "打开 %s 失败：%s" % (open_path, exc), "data": {}}, out_path)
            return 1

    results = []
    annotated = []
    try:
        # 默认先清空场景。否则 Blender 出厂自带的 Cube / Camera / Light 会留在模型里，
        # 既污染结果、又会把预览的自动取景撑大（多一个物体就改变包围盒）。
        # open 了已有文件时不能清，否则把用户要改的东西删了。
        if request.get("reset", True) and not open_path:
            modeling_ops.reset_scene()

        for index, instruction in enumerate(request.get("instructions") or []):
            try:
                results.append(modeling_ops.apply_instruction(instruction))
            except Exception as exc:  # noqa: BLE001
                # 关键：把出错的是**第几条**说清楚，agent 才知道改哪
                detail = getattr(exc, "args", [None])[0] or str(exc)
                emit({
                    "ok": False,
                    "code": "instruction-failed",
                    "reason": "第 %d 条指令失败（op=%s）：%s" % (
                        index + 1, instruction.get("op"), detail),
                    "data": {
                        "failedIndex": index,
                        "failedInstruction": instruction,
                        "completed": len(results),
                        "summary": modeling_ops.scene_summary(),
                        "annotations": annotated,
                    },
                }, out_path)
                return 1
            if isinstance(instruction, dict) and instruction.get("op") == "annotate":
                annotated.append(str(instruction.get("text") or ""))

        data = {
            "results": results,
            "summary": modeling_ops.scene_summary(),
            "annotations": annotated,
        }

        saves = request.get("save")
        if saves:
            if isinstance(saves, str):
                saves = [saves]
            written = []
            for index, target in enumerate(saves):
                os.makedirs(os.path.dirname(os.path.abspath(target)) or ".", exist_ok=True)
                # 第二个及之后的路径写成副本，避免 save_as_mainfile 改变当前文件
                if index == 0:
                    bpy.ops.wm.save_as_mainfile(filepath=target)
                else:
                    bpy.ops.wm.save_as_mainfile(filepath=target, copy=True)
                written.append({"path": target, "bytes": os.path.getsize(target) if os.path.exists(target) else 0})
            data["saved"] = written
            data["blend"] = written[0]["path"] if written else None

        render_dir = request.get("render")
        if render_dir:
            rendered = preview_render.render_previews(
                render_dir,
                width=int(request.get("width") or 640),
                height=int(request.get("height") or 480),
                angles=request.get("angles"),
                prefix=request.get("prefix") or "preview",
            )
            data["render"] = rendered
            data["previews"] = [shot["path"] for shot in rendered.get("shots") or []]

        emit({"ok": True, "code": "ok", "reason": "", "data": data}, out_path)
        return 0

    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        emit({"ok": False, "code": "driver-failed",
              "reason": "%s: %s" % (type(exc).__name__, exc),
              "data": {"completed": len(results)}}, out_path)
        return 1


if __name__ == "__main__":
    # Blender 会忽略这里的返回值；退出码由宿主从结果文件读
    code = main()
    if code != 0:
        print("DRIVER_EXIT=%d" % code, flush=True)
