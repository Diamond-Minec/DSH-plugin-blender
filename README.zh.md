# DSH Blender 建模

**让 DeepSeek Harness 连上 Blender 建模 —— 可以在你眼前实时建，也可以在后台批量建。**

一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件，把 agent 接到 **Blender 5.x** 上。
它在同一个包里带了三样东西：让界面能实时建模的 Blender addon、用来批量跑的终端驱动脚本，
以及**由插件自动装进 DSH 的技能** —— agent 靠它知道怎么建得好。

[English](README.md) · [更新日志](CHANGELOG.md) · [MIT 许可](LICENSE)

---

## 两种模式，同一套建模指令层

两种模式调的是**同一份** `modeling_ops.py`。建出来的几何完全一样，差别只在于你能不能看着它建。

| | **看着建（APP 模式）** | **后台建（终端模式）** |
|---|---|---|
| 能不能看到建模过程 | **能** —— 每一块模型都在 Blender 视口里实时长出来 | 不能，只有最后结果 |
| 需要什么 | Blender 开着 + 装好桥接组件 | 只要知道 `blender.exe` 在哪 |
| 适合 | 探索、做给用户看、边看边手动微调 | 批量、无人值守、Blender 没开的时候 |

「看着建」的原理是往 Blender 里装一个小 addon。addon 监听本机端口，插件把指令发过去，
**addon 用 `bpy.app.timers` 在主线程上逐条执行**。最后这句是关键：`bpy` 不是线程安全的，
在工作线程里直接调 `bpy.ops` 会把 Blender 搞崩；排队到主线程既安全，又保证界面全程不卡。

## 插件会自己安装技能

这是最值得说的一点。插件不只是开几个 HTTP 接口 —— 它通过 `ctx.skills.registerProvider()`
**把自己注册成一个技能来源**。装一次插件，DSH 立刻就有了 `blender-modeling` 技能：

- 技能的一行描述会进首轮技能目录（198 个字符，**故意压短** —— 它出现在每一轮对话的 prompt 里）
- 完整说明**只在 agent 真的要建模时才加载**，平时不花 token
- `references/` 里放着指令表、预览评审清单和建模范式，按需读取

不用手动去配 `customSkillDirs`。

## 预览闭环是成品质感的来源

每一轮都渲染预览图，agent 看了再改。但这只有在图**看得懂**的前提下才有意义，所以渲染器会
**自动布景**：按视场角反推相机距离保证完整取景、加三点光、铺地面接收阴影并作为尺度参照、
设置中性世界背景。

在真实模型上量过，差别不是好看一点的问题：

| | 自动布景前 | 自动布景后 |
|---|---|---|
| 取景 | 模型被裁掉，只看到一角 | 完整入镜 |
| 颜色 | 灰柱子被世界光染成偏红 | 颜色正确 |
| 可判读性 | 纯黑背景，看不出轮廓 | 轮廓清晰，有接触阴影 |

没有这一步，「agent 看自己的渲染图」就只是走个形式。

## 安装

```bash
dsh plugin --profile <profile> add dsh-plugin-blender
```

或者在 DSH 界面里：**设置 → 插件 → 安装**。然后打开
**设置 → Blender 建模**，点一次 **安装桥接组件**。

装完 addon 后**把 Blender 完全关掉再重开**，它才会认出新组件。重开后 3D 视口左侧会出现
`DSH` 面板。回到设置页点「重新检查」—— 状态变绿就能实时建模了。

Blender 会**自动查找**，包括 **Steam 库**（`steamapps/common/Blender`）。
装在别处的话，到「高级」里填一下 `blender.exe` 的完整路径。

## 运行要求

- **Blender 4.2+**（实测 **5.2.2 LTS**）。Windows / macOS / Linux 都可以。
- 工具脚本要 Python 3.x —— **不需要任何第三方包，也没有构建步骤**。
- 「看着建」额外需要在 Blender 里装桥接组件（插件会替你装）。

## 设置页

全是大白话：

- **状态卡** —— Blender 找到没？桥接组件装了没？连上了没？技能注册了没？每项带红黄绿指示，
  并说明该怎么处理。
- **安装桥接组件** —— 一个按钮，外加装完之后的三步引导。
- **默认模式** —— 「看着建」（实时可见）与「后台建」。
- **自动预览** —— 是否让 agent 渲染预览图来自查。
- **试一下** —— 内置一个样例模型，一键跑通整条链路并显示渲染结果，让你在提真实需求前
  先确认环境是对的。
- **最近产出** —— `.blend` 与预览图列表，可以直接在文件夹里定位。
- 技术细节（Blender 路径、输出目录、预览尺寸、连接端口）收在「高级」里。

## 不走界面也能用

```bash
# 终端模式，无界面
blender --background --factory-startup --python blender/modeling_driver.py -- \
  --json request.json --out result.json
```

`request.json` 里放 `instructions`（格式见技能的 `references/instructions.md`），
另外可选 `save`、`render`、`open`、`width`、`height`、`angles`。驱动脚本会打一行
`RESULT_JSON=`，并把同样的内容写到 `--out` 指定的文件。

如果 `@deepseek-ai/dsh-tools` 能解析到，插件还会注册两个模型可见工具：
`blender_environment` 和 `blender_model`。

## 已在真实机器上验证

下面每一项都是真的跑了 Blender、并且**用眼睛看过输出**的。

| 验证项 | 结果 |
|---|---|
| 自动找到 Blender | `E:\SteamLibrary\steamapps\common\Blender\blender.exe`，版本 **5.2.2** |
| 建模指令层 | 11 种操作；布尔切割实测生效（方块 8 顶点 → 切割后 248 顶点） |
| 终端模式 | 真出 `.blend`（94 KB）+ 3 张预览图，没有出厂残留物体 |
| APP 模式协议 | `ping` / `reset` / `exec` / `summary` / `render` / `save` 全部应答；错误以可读信息回传 |
| 主线程队列 | `bpy.app.timers` 驱动队列；操作真的执行，timer 能干净卸载 |
| 自动布景渲染 | 取景、曝光、色偏全部修好并目视确认 |
| 技能注册 | `ctx.skills.registerProvider()` 注册成功；与内置技能共存；未知名字返回 null |
| 优雅降级 | 没有 `skills` 服务时插件照常加载；没有 `@deepseek-ai/dsh-tools` 时跳过工具并留警告 |
| 路径安全 | 取文件的路由拒绝输出目录之外的路径（403） |
| 三套测试 | `verify` 46 项 / `render` 21 项 / `smoke` 27 项 —— 全绿 |

## 开发

**没有任何依赖要装**，拉下来就能改：

```bash
node tools/verify.mjs            # 静态：语法、manifest 不变量、工程约束、技能结构
node tools/render.mjs            # 用固定数据渲染设置页并断言内容
node tools/smoke.mjs             # 模拟宿主：加载插件、走通每条路由
node tools/smoke.mjs --blender   # 并且真的建一个模型（需要装好 Blender）
```

`verify.mjs` 和 `render.mjs` 只要 Node 就能跑，CI 跑的就是这两个。它们覆盖的正是这套环境里
最容易踩的坑：

1. **不能静态 `import '@deepseek-ai/*'`** —— 以 profile 形式安装的插件解析不到这些包，
   静态引入会在加载时直接失败。
2. **不能导出 `Config`** —— 它依赖 `schemastery`，同样解析不到。
3. **addon 必须用 `bpy.app.timers` 调度** —— 否则 `bpy` 不在主线程运行，会崩掉 Blender。
4. **驱动脚本必须用 `utf-8-sig` 读请求** —— BOM（PowerShell 默认就会写）会让 `json.load`
   直接失败。这是实际踩到并修掉的 bug。

## 仓库结构

```
dsh-plugin-blender/
├─ index.js               宿主半边：探测 Blender、装 addon、注册技能、两条执行通道
├─ client.js              浏览器半边：设置页
├─ blender/
│  ├─ modeling_ops.py     共享建模指令层          ─┐
│  ├─ preview_render.py   自动布景的预览渲染       ├─ 两种模式都调这几个
│  ├─ modeling_driver.py  终端模式驱动脚本        ─┘
│  └─ addon/__init__.py   桥接 addon（APP 模式）
├─ skills/
│  └─ blender-modeling/
│     ├─ SKILL.md         agent 首先读到的内容
│     └─ references/      指令表、预览评审、建模配方
└─ tools/                 verify.mjs · render.mjs · smoke.mjs
```

装 addon 时，插件会把 `modeling_ops.py`、`preview_render.py`、`modeling_driver.py`
一起复制到 addon 旁边，让它**自包含**，不依赖插件源码一直待在原处。

## 已知限制

- **没有 Cycles。** 实测环境里的 Blender 构建只提供 EEVEE。预览图出得快、可判读，但不是
  照片级；要真实感渲染请自己用 Cycles 版本打开 `.blend`。
- **只能做占位体，做不了角色。** 工具链基于图元、布尔和修改器，**不含雕刻、拓扑重建与绑定**。
  有机体（角色类）只能做出粗糙占位。技能文档里如实写明了，不做夸大。
- **「看着建」需要 Blender 开着。** 没开就用「后台建」。
- **装完 addon 需要重启一次 Blender** 它才会出现在偏好设置里。不过服务本身在注册时就会启动，
  所以已经开着的 Blender 在文件就位并重载后也能被驱动。

## 许可

[MIT](LICENSE)
