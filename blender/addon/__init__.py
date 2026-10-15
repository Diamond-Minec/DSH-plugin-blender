bl_info = {
    "name": "DSH Bridge (DeepSeek Harness)",
    "author": "DSH-Auto-Video / DSH community",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar > DSH",
    "description": "让 DeepSeek Harness 实时驱动 Blender：指令在主线程执行，你能在界面上看到每一步建模过程。",
    "category": "Interface",
}

"""DSH Bridge —— APP 模式的服务端。

为什么需要它：Blender 的 Python API **不是线程安全的**，所有 bpy 操作必须在主线程执行。
所以在 socket 线程里直接调 bpy 会崩。标准做法是：

    socket 线程                主线程
    ──────────                 ──────
    收到指令 ──▶ 队列 ──▶ bpy.app.timers 轮询 ──▶ 执行 bpy 操作
                    ▲                              │
                    └──────── 结果回传 ◀───────────┘

这样每处理完一条指令就立刻让出控制权（返回一个很短的间隔），
所以 Blender 界面**全程保持响应**，用户能实时看到模型长出来。

协议（换行分隔的 JSON，localhost TCP）：
    请求  {"id": 1, "cmd": "ping"|"exec"|"summary"|"render"|"save"|"reset", ...}
    响应  {"id": 1, "ok": true, "data": {...}}  或  {"id": 1, "ok": false, "error": "..."}
"""

import json
import os
import queue
import socket
import sys
import threading
import time
import traceback

import bpy

# ------------------------------------------------------------------ 状态 ---

DEFAULT_PORT = 8765
HOST = "127.0.0.1"

_state = {
    "server": None,          # 监听 socket
    "thread": None,          # 接收线程
    "running": False,
    "port": DEFAULT_PORT,
    "queue": queue.Queue(),  # 待执行任务（主线程消费）
    "log": [],               # 最近的操作记录，给界面显示
    "last_error": "",
    "executed": 0,
    "clients": 0,
}
_log_lock = threading.Lock()


def _log(message):
    with _log_lock:
        _state["log"].append(str(message))
        if len(_state["log"]) > 100:
            del _state["log"][:-100]
    print("[DSH] " + str(message))


# ------------------------------------------------------------ 端口发现文件 ---

def _discovery_path():
    """端口发现文件的位置。

    插件按同样的规则算这个路径，所以**用户手动启动 Blender 也能被找到** ——
    不需要靠插件猜端口。优先 DSH_HOME（从 DSH 启动时会带上），否则 ~/.dsh。
    """
    home = os.environ.get("DSH_HOME")
    if not home:
        home = os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "blender-plugin", "bridge.json")


def _write_discovery(port):
    """把实际监听的端口写下来，让插件知道该连哪。"""
    try:
        target = _discovery_path()
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as handle:
            json.dump({
                "port": int(port),
                "host": HOST,
                "pid": os.getpid(),
                "blender": bpy.app.version_string,
                "startedAt": time.time(),
            }, handle)
        _log("已写出端口发现文件：" + target)
    except Exception as exc:  # noqa: BLE001
        # 写不了不影响服务本身，只是插件得靠配置端口来连
        _log("写端口发现文件失败（不影响服务）：%s" % exc)


def _clear_discovery():
    try:
        target = _discovery_path()
        if os.path.exists(target):
            with open(target, encoding="utf-8") as handle:
                info = json.load(handle)
            # 只清理自己写的，别误删别人的
            if int(info.get("pid", -1)) == os.getpid():
                os.remove(target)
    except Exception:  # noqa: BLE001
        pass


# -------------------------------------------------------- 建模指令层加载 ---

def _ops_module():
    """加载共享建模指令层。

    两处都找，哪边有就用哪边：
      1. addon 自己所在目录 —— **安装后的形态**。装到 Blender 扩展目录时，
         modeling_ops.py / preview_render.py 会被复制到 addon 旁边，做到自包含。
      2. addon 的上一级目录 —— **开发态**。在源码树里跑测试时，
         共享层就在 blender/ 下、addon 在 blender/addon/ 里。

    两边都找不到时给出可操作的报错，而不是抛一个 ModuleNotFoundError 让人猜。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        here,                                     # 安装后：和 addon 同级
        os.path.dirname(here),                    # 开发态：blender/ 目录
    ]

    attempted = []
    for path in candidates:
        if not os.path.isdir(path):
            continue
        attempted.append(path)
        if path not in sys.path:
            sys.path.insert(0, path)
        try:
            import modeling_ops
            import preview_render
            return modeling_ops, preview_render
        except ImportError:
            # 这个候选目录里没有共享层，换下一个
            if path in sys.path:
                sys.path.remove(path)
            continue

    raise RuntimeError(
        "加载共享建模指令层失败。需要在下列任一目录里同时找到 modeling_ops.py 与 "
        "preview_render.py：%s" % (", ".join(attempted) or "(无可用目录)")
    )


# ------------------------------------------------------ 主线程任务执行器 ---

def _run_task(task):
    """在主线程执行一条指令，把结果写回 task。"""
    cmd = task.get("cmd")
    try:
        modeling_ops, preview_render = _ops_module()
        if cmd == "exec":
            results = []
            annotated = []
            for inst in task.get("instructions") or []:
                results.append(modeling_ops.apply_instruction(inst))
                # annotate 是给用户看的进度说明，不产生几何。
                # 两种模式都要把它收集起来，返回结构保持一致。
                if isinstance(inst, dict) and inst.get("op") == "annotate":
                    annotated.append(str(inst.get("text") or ""))
            _state["executed"] += len(results)
            _log("执行 %d 条指令" % len(results))
            return {"results": results, "annotations": annotated,
                    "summary": modeling_ops.scene_summary()}

        if cmd == "reset":
            modeling_ops.reset_scene()
            _log("场景已清空")
            return {"reset": True}

        if cmd == "summary":
            return modeling_ops.scene_summary()

        if cmd == "render":
            r = preview_render.render_previews(
                task.get("out_dir") or os.path.join(os.path.expanduser("~"), "dsh_blender_preview"),
                width=int(task.get("width") or 640),
                height=int(task.get("height") or 480),
                angles=task.get("angles"),
            )
            _log("渲染 %d 张预览图" % len(r.get("shots") or []))
            return r

        if cmd == "save":
            path = task.get("path")
            if not path:
                raise ValueError("save 需要 path")
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            bpy.ops.wm.save_as_mainfile(filepath=path)
            _log("已保存 " + path)
            return {"saved": path, "exists": os.path.exists(path)}

        if cmd == "open":
            path = task.get("path")
            if not path or not os.path.exists(path):
                raise ValueError("open 需要存在的 path：%r" % path)
            bpy.ops.wm.open_mainfile(filepath=path)
            _log("已打开 " + path)
            return {"opened": path}

        if cmd == "ping":
            return {"pong": True, "blender": bpy.app.version_string}

        raise ValueError("未知命令 %r" % cmd)
    except Exception as exc:  # noqa: BLE001
        _state["last_error"] = "%s: %s" % (type(exc).__name__, exc)
        traceback.print_exc()
        _log("失败：" + _state["last_error"])
        return {"__error__": _state["last_error"]}


def _pump():
    """bpy.app.timers 回调 —— 主线程在这里消费队列。

    关键：每次只处理**一条**任务就返回一个很短的间隔，
    这样界面不会被长任务卡住，用户能实时看到每一步。
    """
    if not _state["running"] and _state["queue"].empty():
        return 0.2
    try:
        task = _state["queue"].get_nowait()
    except queue.Empty:
        return 0.05
    task["result"] = _run_task(task)
    task["event"].set()
    return 0.01


# ------------------------------------------------------------ socket 服务 ---

def _send(conn, payload):
    try:
        conn.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
    except OSError:
        pass


def _handle_client(conn):
    """每个客户端一个线程：只负责读请求、投队列、等结果、回响应。"""
    _state["clients"] += 1
    buffer = b""
    try:
        with conn:
            conn.settimeout(0.5)
            while _state["running"]:
                try:
                    chunk = conn.recv(65536)
                except socket.timeout:
                    continue
                except OSError:
                    break
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        request = json.loads(line.decode("utf-8"))
                    except ValueError as exc:
                        _send(conn, {"id": None, "ok": False, "error": "请求不是合法 JSON：%s" % exc})
                        continue

                    task = {
                        "id": request.get("id"),
                        "cmd": request.get("cmd"),
                        "instructions": request.get("instructions"),
                        "out_dir": request.get("out_dir"),
                        "width": request.get("width"),
                        "height": request.get("height"),
                        "angles": request.get("angles"),
                        "path": request.get("path"),
                        "event": threading.Event(),
                        "result": None,
                    }
                    _state["queue"].put(task)
                    # 等待主线程执行完（超时可配，默认 10 分钟）
                    if not task["event"].wait(timeout=float(request.get("timeout", 600))):
                        _send(conn, {"id": task["id"], "ok": False,
                                     "error": "主线程执行超时（Blender 可能正忙）"})
                        continue
                    result = task["result"] or {}
                    if "__error__" in result:
                        _send(conn, {"id": task["id"], "ok": False, "error": result["__error__"]})
                    else:
                        _send(conn, {"id": task["id"], "ok": True, "data": result})
    except Exception as exc:  # noqa: BLE001
        _log("客户端处理异常：%s" % exc)
    finally:
        _state["clients"] -= 1


def _serve():
    """接收线程：只做 accept 和分发，绝不碰 bpy。"""
    server = _state["server"]
    while _state["running"] and server is not None:
        try:
            server.settimeout(0.5)
            conn, _addr = server.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        threading.Thread(target=_handle_client, args=(conn,), daemon=True).start()


def start_server(port=DEFAULT_PORT, tries=20):
    """启动桥接服务。

    端口不是想绑就能绑的：实测这台机器上默认端口 8765 被一个无关程序占着，
    而且 Windows 下两个进程可以同时绑同一端口（SO_REUSEADDR），
    结果就是连接可能落到别人身上 —— 表现为「连上了但返回垃圾」。
    所以这里：
      · Windows 上改用 SO_EXCLUSIVEADDRUSE，独占绑定，被占了就绑不上（这是我们要的）
      · 从配置端口开始往后试若干端口，找到能独占的为止
      · 把**实际**用的端口写进发现文件，插件读它就知道该连哪
    """
    if _state["running"]:
        return {"running": True, "port": _state["port"], "already": True}

    errors = []
    chosen = None
    for offset in range(max(1, int(tries))):
        candidate = int(port) + offset
        if candidate > 65535:
            break
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if os.name == "nt":
                # 独占绑定：别人占了就直接失败，不会出现两个进程抢同一端口
                server.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind((HOST, candidate))
            server.listen(8)
        except OSError as exc:
            try:
                server.close()
            except OSError:
                pass
            errors.append("%s(%s)" % (candidate, exc.errno or exc.strerror))
            continue
        chosen = (server, candidate)
        break

    if chosen is None:
        _state["last_error"] = "从端口 %s 起试了 %s 个都绑不上：%s" % (
            port, tries, ", ".join(errors[:6]))
        _log(_state["last_error"])
        raise OSError(_state["last_error"])

    server, chosen_port = chosen
    _state["server"] = server
    _state["port"] = chosen_port
    _state["running"] = True
    _state["thread"] = threading.Thread(target=_serve, daemon=True)
    _state["thread"].start()

    if not bpy.app.timers.is_registered(_pump):
        bpy.app.timers.register(_pump, persistent=True)

    _write_discovery(chosen_port)
    _log("服务已启动：%s:%s" % (HOST, chosen_port))
    return {"running": True, "port": chosen_port, "requested": int(port)}


def stop_server():
    _state["running"] = False
    server = _state["server"]
    if server is not None:
        try:
            server.close()
        except OSError:
            pass
    _state["server"] = None
    if bpy.app.timers.is_registered(_pump):
        try:
            bpy.app.timers.unregister(_pump)
        except Exception:  # noqa: BLE001
            pass
    _clear_discovery()
    _log("服务已停止")
    return {"running": False}


# ------------------------------------------------------------ 界面面板 ---

class DSH_OT_start(bpy.types.Operator):
    bl_idname = "dsh.start_bridge"
    bl_label = "启动 DSH 桥接"
    bl_description = "让 DeepSeek Harness 可以连接本 Blender"

    def execute(self, context):
        try:
            info = start_server(DSH_AddonPreferences.port)
            self.report({"INFO"}, "DSH 桥接已启动，端口 %s" % info.get("port"))
        except Exception as exc:  # noqa: BLE001
            self.report({"ERROR"}, "启动失败：%s" % exc)
        return {"FINISHED"}


class DSH_OT_stop(bpy.types.Operator):
    bl_idname = "dsh.stop_bridge"
    bl_label = "停止 DSH 桥接"

    def execute(self, context):
        stop_server()
        self.report({"INFO"}, "DSH 桥接已停止")
        return {"FINISHED"}


class DSH_PT_panel(bpy.types.Panel):
    bl_label = "DeepSeek Harness"
    bl_idname = "DSH_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "DSH"

    def draw(self, context):
        layout = self.layout
        running = _state["running"]
        box = layout.box()
        box.label(text="桥接状态：" + ("运行中" if running else "已停止"),
                  icon="PLAY" if running else "PAUSE")
        if running:
            box.label(text="端口 %s · 已执行 %d 条指令" % (_state["port"], _state["executed"]))
            box.label(text="客户端 %d 个" % _state["clients"])
            box.operator("dsh.stop_bridge", icon="CANCEL")
        else:
            box.label(text="启动后 Harness 即可实时驱动")
            box.operator("dsh.start_bridge", icon="PLAY")

        if _state["last_error"]:
            err = layout.box()
            err.label(text="最近错误：", icon="ERROR")
            err.label(text=_state["last_error"][:80])

        if _state["log"]:
            log = layout.box()
            log.label(text="最近操作：")
            for line in _state["log"][-8:]:
                log.label(text=line[:60])


class DSH_AddonPreferences(bpy.types.AddonPreferences):
    bl_idname = __name__
    port: bpy.props.IntProperty(
        name="端口", default=DEFAULT_PORT, min=1024, max=65535,
        description="DSH 桥接监听的本地端口",
    )
    autostart: bpy.props.BoolProperty(
        name="Blender 启动时自动开启", default=True,
        description="打开 Blender 就自动开始监听，省得每次手动点",
    )

    def draw(self, context):
        layout = self.layout
        layout.prop(self, "port")
        layout.prop(self, "autostart")


_classes = (DSH_OT_start, DSH_OT_stop, DSH_PT_panel, DSH_AddonPreferences)


# ---------------------------------------------------- 注册 / 卸载 / 自动启动 ---

@bpy.app.handlers.persistent
def _on_load(_dummy):
    """文件加载后，如果开着自动启动而服务没跑，就起起来。"""
    try:
        prefs = bpy.context.preferences.addons.get(__name__)
        if prefs is None:
            return
        if getattr(prefs.preferences, "autostart", True) and not _state["running"]:
            start_server(prefs.preferences.port)
    except Exception as exc:  # noqa: BLE001
        _log("自动启动失败：%s" % exc)


def register():
    for cls in _classes:
        bpy.utils.register_class(cls)
    if _on_load not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(_on_load)
    try:
        prefs = bpy.context.preferences.addons.get(__name__)
        if prefs is not None and getattr(prefs.preferences, "autostart", True):
            start_server(prefs.preferences.port)
    except Exception as exc:  # noqa: BLE001
        _log("注册时自动启动失败（可在侧栏手动启动）：%s" % exc)


def unregister():
    stop_server()
    if _on_load in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(_on_load)
    for cls in reversed(_classes):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
