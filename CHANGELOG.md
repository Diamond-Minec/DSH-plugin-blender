# Changelog

本文件记录本插件的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] — 2026-10-15

首个版本。

### 新增

- **两种建模模式，共用同一套建模指令层**（`blender/modeling_ops.py`）：
  - **APP 模式** —— 插件把一个桥接 addon 装进 Blender，addon 用
    `bpy.app.timers` 在主线程轮询队列执行操作。因为 `bpy` 不是线程安全的，
    直接在工作线程里调它会崩掉 Blender；排队到主线程既安全又保证界面不卡，
    用户能在视口里看到每一步建模过程。
  - **终端模式** —— `blender --background --python` 跑一批指令，只有结果。
    适合批量与无人值守，不需要 Blender 开着。
- **插件自带并安装技能** —— 通过 `ctx.skills.registerProvider()` 注册
  `blender-modeling` 技能。装一次插件，DSH 立刻获得建模知识；技能正文按需加载，
  平时只占技能目录里 198 个字符的 description。
- **自动布景的预览渲染**（`blender/preview_render.py`）—— 按视场角反推相机距离
  保证完整取景，三点光按场景尺度平方缩放，加地面接收阴影，压低世界光避免给模型
  染色。这构成「渲染预览图 → agent 看图自己改」的闭环。
- **11 种建模指令** —— 图元（cube/sphere/ico_sphere/cylinder/cone/torus/plane/
  monkey/capsule）、变换、材质、布尔、倒角、细分、镜像、阵列、复制、删除、合并，
  外加 `annotate` 进度标注。
- **Blender 自动探测** —— 支持官方安装目录、Steam 库
  （`steamapps/common/Blender`）、桌面快捷方式，最后有界扫描兜底。
- **设置页**（大白话，无术语）—— 状态卡（Blender / 桥接组件 / 连接 / 技能 /
  输出目录，逐项带红黄绿指示与处置说明）、一键装桥接组件、模式选择、
  自动预览开关、内置样例「试一下」、产出列表、高级项折叠。
- 环境就绪时额外注册两个模型可见工具：`blender_environment`、`blender_model`。
- 三套测试：`tools/verify.mjs`（静态自检）、`tools/render.mjs`（设置页渲染断言）、
  `tools/smoke.mjs`（宿主模拟 + 可选真跑建模）。

### 说明

- 适配 Blender **4.2+**，实测于 **5.2.2 LTS**。
- 预览渲染使用 EEVEE（实测环境中的 Blender 构建只提供 EEVEE）。秒级出图，
  适合自查闭环；不追求照片级真实感。
- 建模基于图元、布尔与修改器，**不包含雕刻、拓扑重建与绑定**。有机体（角色类）
  只能做出粗糙占位体，技能文档里已如实说明，不做夸大。

### 修复（开发过程中发现并解决）

- **技能根本没注册上（最重要的一个）。** 插件用 `ctx.skills.registerProvider()` 装技能，
  但最初的实现把契约写错了四处：传给 `registerProvider` 的应该是**同步工厂函数**而不是
  provider 对象；调用策略要包在 `invocation` 对象里而不是平铺；候选项还必须带
  `source`、`rank`、`provider`（且 `provider` 必须等于 provider 名）；`get()` 收到的是
  **候选对象**而不是技能名。任何一条不符都会让 `validateCandidate` 抛错，而注册表会
  **静默跳过**出错的 provider —— 表现就是「插件明明在跑，技能却一直不出现」。
  - 根因之外还有个教训：我自己的 mock 测试当时是**通过的**，因为 mock 比真实实现宽松。
    修法不是改代码而是**改测试** —— 新增 `tools/smoke-skill.mjs`，直接加载 profile 里真实的
    `@deepseek-ai/dsh-skill` 与 `@deepseek-ai/cordis` 做集成测试，契约不符必然失败。
  - 顺带把 `get()` 返回的 `resourceBase` 指向技能目录，这样 SKILL.md 里引用的
    `references/*.md` 才能被正确解析。
- 驱动脚本原本用 `utf-8` 读请求 JSON，Windows 上（PowerShell、记事本等）
  写出的 UTF-8 文件常带 BOM，会导致 `json.load` 直接失败。改用 `utf-8-sig`。
- 终端模式原本会保留 Blender 出厂自带的 `Cube`/`Camera`/`Light`，既污染模型，
  又会撑大自动取景的包围盒。改为默认先 `reset_scene()`（`open` 已有文件时不清）。
- 渲染的包围盒计算原本把出厂相机和灯也算进去，导致取景异常。改为只统计属于模型的
  网格，并跳过预览自身添加的相机、灯与地面。
- addon 原本只在自己所在目录找共享建模层，在源码树里跑测试时找不到。改为
  同时尝试 addon 同级目录（安装后形态）与上一级目录（开发态），并在两处都找不到时
  给出可操作的报错。
- 预览世界光强度原本过高（1.0），把模型染成了背景色（蓝色背景会让灰柱子偏红）。
  压到 0.35 后颜色恢复正常。
- `reset_scene()` 原本用 `bpy.ops.wm.read_factory_settings()`，它会重建整个 Blender 状态，
  在 GUI 里运行时会把正在工作的 addon 一起卸载 —— 表现为「发一条指令之后连接就断」。
  改为直接删除数据块。
- addon 装到磁盘后**没有被真正启用**：原本用 `addon_utils.enable()`，
  它报告成功但重启后依然是禁用状态。改用 `bpy.ops.preferences.addon_enable` 并写出偏好设置。
- 端口被占用时连接可能落到别的程序上（实测 8765 被无关进程占着）。
  改为 Windows 下用 `SO_EXCLUSIVEADDRUSE` 独占绑定、被占则顺延，
  并把**实际**监听端口写进发现文件供插件读取。
- 两种模式返回结构不一致：APP 模式不返回注解。已统一。
- **模型可见的工具从来没注册成功过（两个叠加的 bug）。**
  - 其一：插件以 `link:` 装在 profile **之外**时，`import('@deepseek-ai/dsh-tools')` 这种裸标识符
    是按导入文件位置逐级向上找 node_modules 的，而那条路径上根本没有 DSH 的包 —— 实测
    `MODULE_NOT_FOUND`，且被 `.catch` 吞掉，表现就是「工具从来不存在，而且无人知道」。
    改用 `createRequire` 依次尝试显式候选基点（插件自身位置 → 各 `$DSH_HOME/profiles/<名字>`
    → `~/.dsh/profiles`），link 安装与常规安装走同一套代码。
  - 其二：模块能加载之后工具**仍然**注册失败 —— DSH 的 JSON Schema 子集要求 object 必须显式
    声明 `additionalProperties`，`items: { type: 'object' }` 会被直接拒绝
    （`unsupported JSON schema: ... must be explicitly true or false`）。
    一个参数不合法会让**整个** `defineTool` 失败，所以两个工具一起丢。
    两个 bug 都修掉之后工具才真正出现。
- **同步的 skill provider 会让真实宿主抛 `promise.then is not a function`。**
  这是实际使用中暴露出来的那个。注册表内部是：

  ```js
  function waitWithAbort(promise, signal) {
    if (signal === void 0) return promise;   // 没 signal：直接把值透传
    ...
    promise.then(...)                        // 有 signal：直接调 .then
  }
  ```

  而 `list()` / `get()` 原本是**同步**返回数组/对象的。没有 signal 时注册表能容忍
  （直接透传），但**真实宿主查目录、加载技能时总会传 `options.signal`** ——
  于是同步返回值撞上 `.then`，抛出该错误。两处已改为 `async`。
  - 测试教训再次应验并且更尖锐：我的集成测试调用 `list({ cwd })` **没传 signal**，
    走的是提前返回那条路，所以一直是绿的。现在 `tools/smoke-skill.mjs` 传一个
    `AbortSignal`，修复前确认测试变红、修复后变绿，而不是两边都凭信任。

### 变更

- 设置页新增独立的「技能安装」区块：显示技能是否真的进了 DSH 的技能目录、说明书能否加载，
  并提供「检查技能状态」按钮 —— 它会通过 `/blender/api/skill` **向真实注册表核实**，
  而不是报告一个本地变量。这一点很重要，因为注册失败是静默的。
- 新增 `tools/smoke-skill.mjs`：直接对 profile 里真实的 `@deepseek-ai/dsh-skill` +
  `@deepseek-ai/cordis` 做集成测试；没有 DSH 依赖的环境（如 CI）会自行 SKIP。
- 静态检查新增两条不变量：宿主半边不得使用裸 `import('@deepseek-ai/*')`；
  `modeling_ops.py` 不得调用 `read_factory_settings`。两者都先剥掉注释再匹配，
  免得被说明文字误判。

[1.0.0]: https://github.com/Diamond-Minec/DSH-Blender/releases/tag/v1.0.0
