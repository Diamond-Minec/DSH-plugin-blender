/**
 * dsh-plugin-blender — 浏览器半边（设置页）。
 *
 * 形态照官方 ui-plugin 规范：window.__ModuleLoader__ 注册的惰性工厂，id 等于包名；
 * React 从浏览器模块表 require。数据全走宿主注册的同源路由 /blender/api/*。
 *
 * 文案原则：给普通人看，不用术语。
 * 样式原则：不写死颜色，容器与文字用 currentColor + color-mix 跟随宿主主题；
 *           只有状态圆点用固定色（属于图形而非界面配色）。
 *
 * @module dsh-plugin-blender/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-blender',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;
    const API = '/blender/api';

    const CSS = `
.bd-wrap{display:flex;flex-direction:column;gap:14px;color:inherit;font-size:13.5px;line-height:1.7}
.bd-h{margin:0;font-size:15px;font-weight:600;color:inherit}
.bd-desc{margin:0;color:inherit;opacity:.72;font-size:12.5px}
.bd-card{border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:11px;
  padding:12px 14px;background:color-mix(in srgb,currentColor 3%,transparent);
  display:flex;flex-direction:column;gap:9px}
.bd-card.good{border-color:color-mix(in srgb,currentColor 26%,transparent);
  background:color-mix(in srgb,currentColor 6%,transparent)}
.bd-big{font-size:14.5px;font-weight:600;display:flex;align-items:center;gap:8px}
.bd-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;display:inline-block}
.bd-row{display:flex;align-items:center;gap:9px;font-size:13px}
.bd-between{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.bd-kv{display:flex;flex-direction:column;gap:2px;min-width:0}
.bd-name{font-weight:500}
.bd-val{color:inherit;opacity:.62;font-size:12px;word-break:break-all}
.bd-btn{padding:7px 16px;border-radius:9px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);
  background:color-mix(in srgb,currentColor 11%,transparent);color:inherit;cursor:pointer;
  font:inherit;font-size:12.5px;white-space:nowrap;display:inline-block;text-align:center;
  text-decoration:none;box-sizing:border-box}
.bd-btn:hover{background:color-mix(in srgb,currentColor 19%,transparent)}
.bd-btn[disabled]{opacity:.45;cursor:default}
.bd-btn-main{border-color:color-mix(in srgb,currentColor 42%,transparent);
  background:color-mix(in srgb,currentColor 20%,transparent);font-weight:600}
.bd-btn-mini{padding:4px 11px;font-size:12px}
.bd-choice{display:flex;gap:9px;flex-wrap:wrap}
.bd-opt{padding:10px 14px;border-radius:10px;cursor:pointer;text-align:left;
  border:1px solid color-mix(in srgb,currentColor 22%,transparent);
  background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;font:inherit;font-size:12.5px;
  flex:1 1 190px;min-width:0}
.bd-opt[data-on="1"]{border-color:color-mix(in srgb,currentColor 55%,transparent);
  background:color-mix(in srgb,currentColor 16%,transparent);font-weight:600}
.bd-opt small{display:block;font-weight:400;opacity:.65;font-size:11.5px;margin-top:3px;line-height:1.5}
.bd-in{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:10px;
  border:1px solid color-mix(in srgb,currentColor 22%,transparent);
  background:color-mix(in srgb,currentColor 4%,transparent);color:inherit;font:inherit;font-size:13px;outline:none}
.bd-in:focus{border-color:color-mix(in srgb,currentColor 45%,transparent)}
.bd-note{border-radius:9px;padding:9px 12px;font-size:12.5px;
  border:1px solid color-mix(in srgb,currentColor 20%,transparent);
  background:color-mix(in srgb,currentColor 5%,transparent)}
.bd-note.bad{border-color:color-mix(in srgb,currentColor 34%,transparent)}
.bd-note.ok{border-color:color-mix(in srgb,currentColor 30%,transparent);
  background:color-mix(in srgb,currentColor 8%,transparent)}
.bd-pre{margin:0;padding:10px 12px;border-radius:9px;overflow:auto;max-height:220px;
  background:color-mix(in srgb,currentColor 6%,transparent);font-size:11.5px;line-height:1.55;
  white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace}
.bd-list{display:flex;flex-direction:column;gap:6px}
.bd-item{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:7px 11px;border-radius:9px;
  border:1px solid color-mix(in srgb,currentColor 14%,transparent);
  background:color-mix(in srgb,currentColor 3%,transparent)}
.bd-item b{font-weight:550;font-size:12.5px}
.bd-meta{color:inherit;opacity:.55;font-size:11.5px}
.bd-adv summary{cursor:pointer;font-size:12.5px;opacity:.75;user-select:none}
.bd-adv[open] summary{margin-bottom:10px}
.bd-grid{display:flex;flex-direction:column;gap:10px}
.bd-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:9px}
.bd-gallery img{width:100%;height:auto;border-radius:9px;display:block;
  border:1px solid color-mix(in srgb,currentColor 16%,transparent)}
.bd-steps{margin:0;padding-left:20px;font-size:12.5px;color:inherit;opacity:.85}
.bd-steps li{margin:3px 0}
`;

    /* ------------------------------------------------------------ 小工具 -- */

    const post = (sub, body) =>
      fetch(`${API}/${sub}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then((r) => r.json());
    const get = (sub) => fetch(`${API}/${sub}`, { cache: 'no-store' }).then((r) => r.json());
    const fileUrl = (p) => `${API}/file?path=${encodeURIComponent(p)}`;
    const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
    const fmtTime = (ms) => {
      if (!ms) return '';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    function Dot({ ok }) {
      const color = ok === true ? '#2ea043' : ok === false ? '#f85149' : '#d29922';
      return h('span', { className: 'bd-dot', style: { background: color } });
    }

    const DEMO_MODEL = [
      { op: 'primitive', kind: 'cylinder', name: 'base', radius: 0.7, depth: 0.25, location: [0, 0, 0.125] },
      { op: 'material', targets: ['base'], name: 'stone', base_color: [0.45, 0.44, 0.42], metallic: 0, roughness: 0.8 },
      { op: 'primitive', kind: 'cube', name: 'column', size: 0.55, location: [0, 0, 1.1], scale: [1, 1, 1.8] },
      { op: 'material', targets: ['column'], name: 'steel', base_color: [0.35, 0.38, 0.42], metallic: 0.9, roughness: 0.25 },
      { op: 'bevel', target: 'column', width: 0.02, segments: 2 },
      { op: 'primitive', kind: 'sphere', name: 'orb', radius: 0.42, location: [0, 0, 2.35], shading: 'smooth' },
      { op: 'material', targets: ['orb'], name: 'glass_blue', base_color: [0.2, 0.6, 0.9], metallic: 0.1, roughness: 0.1 },
      { op: 'primitive', kind: 'torus', name: 'crown', major_radius: 0.5, minor_radius: 0.05, location: [0, 0, 2.35] },
      { op: 'material', targets: ['crown'], name: 'brass', base_color: [0.8, 0.6, 0.22], metallic: 1.0, roughness: 0.25 },
    ];

    /* -------------------------------------------------------------- 状态卡 -- */

    function HealthCard({ data, onReload }) {
      if (!data) return h('div', { className: 'bd-card' }, h('div', { className: 'bd-desc' }, '正在检查…'));
      const s = data.status;
      const canApp = s.ready.app;
      const canTerm = s.ready.terminal;
      const headline = canApp
        ? 'Blender 已经连上了：可以让 DSH 在你眼前实时建模'
        : canTerm
          ? 'Blender 找到了，但还没连上界面 —— 现在只能用后台模式'
          : '还没找到 Blender，先在下面指定它的位置';

      const rows = [
        {
          ok: s.blender.found,
          name: 'Blender 本体',
          value: s.blender.found
            ? `${s.blender.path}${s.blender.version ? `（版本 ${s.blender.version}）` : ''}`
            : '没找到。装在别处的话，到下面「高级」里填一下 blender.exe 的完整路径。',
        },
        {
          ok: s.addon.complete,
          name: '桥接组件（让界面能实时建模）',
          value: s.addon.complete
            ? `已装好：${s.addon.target}`
            : s.addon.installed
              ? '装了一半，建议重新装一次'
              : '还没装。点下面的按钮一次装好，装完重启 Blender 即可。',
        },
        {
          ok: s.bridge.alive,
          name: '和 Blender 的连接',
          value: s.bridge.alive
            ? `已连上（端口 ${s.bridge.port}）`
            : s.addon.complete
              ? `没连上。Blender 开着吗？装完桥接组件后要重启一次 Blender。`
              : '还没装桥接组件，所以连不上。',
        },
        {
          ok: s.skills.count > 0,
          name: 'DSH 里的建模技能',
          value: s.skills.count > 0
            ? `已注册 ${s.skills.count} 个：${s.skills.names.join('、')}（DSH 会用它们知道怎么建模）`
            : '没注册上。可能这个 profile 没装技能服务。',
        },
        {
          ok: s.outDir.writable,
          name: '模型存到哪儿',
          value: s.outDir.path,
        },
      ];

      return h(
        'div',
        { className: `bd-card${canApp ? ' good' : ''}` },
        h('div', { className: 'bd-big' }, h(Dot, { ok: canApp || canTerm }), headline),
        h('div', { className: 'bd-grid' },
          rows.map((row) =>
            h('div', { className: 'bd-row', key: row.name },
              h(Dot, { ok: row.ok }),
              h('div', { className: 'bd-kv' },
                h('span', { className: 'bd-name' }, row.name),
                h('span', { className: 'bd-val' }, row.value))))),
        h('div', { className: 'bd-between' },
          h('span', { className: 'bd-desc' }, '改完设置后点右边重新检查一次。'),
          h('button', { className: 'bd-btn bd-btn-mini', onClick: onReload }, '重新检查')),
      );
    }

    /* -------------------------------------------------------- 装桥接组件 -- */

    function SetupBlock({ data, onDone }) {
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);

      const s = data && data.status;
      const installed = s && s.addon && s.addon.complete;

      const install = () => {
        setBusy(true);
        setResult(null);
        post('install-addon')
          .then((r) => { setBusy(false); setResult(r); if (r.ok && onDone) onDone(); })
          .catch((e) => { setBusy(false); setResult({ ok: false, error: String(e) }); });
      };

      const startBlender = () => {
        post('start-blender')
          .then((r) => setResult(r.ok ? { ok: true, note: 'Blender 正在启动，等它起来再点「重新检查」。' } : r))
          .catch((e) => setResult({ ok: false, error: String(e) }));
      };

      return h(
        'div',
        { className: 'bd-card' },
        h('div', { className: 'bd-between' },
          h('div', { className: 'bd-kv' },
            h('span', { className: 'bd-name' }, installed ? '桥接组件已经装好了' : '需要装一下桥接组件'),
            h('span', { className: 'bd-desc' },
              installed
                ? '想重装或换了 Blender 版本时，可以再点一次。'
                : '装一次就行：它让 DSH 能连上 Blender，你才能看到建模的每一步。')),
          h('div', { className: 'bd-choice' },
            h('button', { className: 'bd-btn bd-btn-main', disabled: busy, onClick: install },
              busy ? '正在装…' : installed ? '重新安装' : '安装桥接组件'),
            h('button', { className: 'bd-btn', onClick: startBlender }, '启动 Blender'))),

        !installed
          ? h('div', { className: 'bd-kv' },
              h('span', { className: 'bd-desc' }, '装完之后：'),
              h('ol', { className: 'bd-steps' },
                h('li', null, '把 Blender 完全关掉再重新打开（让它认出新组件）'),
                h('li', null, '打开后看到左侧多了个「DSH」面板，说明装成功了'),
                h('li', null, '回到这里点「重新检查」，状态变绿就能实时建模了')))
          : null,

        result
          ? h('div', { className: `bd-note${result.ok ? ' ok' : ' bad'}` },
              result.ok
                ? h('div', { className: 'bd-kv' },
                    h('span', null, result.note || '装好了。'),
                    result.target ? h('span', { className: 'bd-val' }, `位置：${result.target}`) : null,
                    result.blender ? h('span', { className: 'bd-val' }, `对应 Blender：${result.blender}`) : null)
                : h('span', null, result.error || '没成功'),
              result.details ? h('pre', { className: 'bd-pre' }, String(result.details)) : null)
          : null,
      );
    }

    /* ------------------------------------------------------------ 默认设置 -- */

    function SettingsBlock({ cfg, status, onSaved }) {
      const [form, setForm] = useState(null);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState('');

      useEffect(() => {
        if (cfg) {
          setForm({
            mode: cfg.mode || 'app',
            autoPreview: cfg.autoPreview !== false,
            previewWidth: cfg.previewWidth || 640,
            previewHeight: cfg.previewHeight || 480,
            bridgePort: cfg.bridgePort || 8765,
            blenderPath: cfg.blenderPath || '',
            outDir: cfg.outDir || '',
          });
        }
      }, [cfg]);

      if (!form) return null;
      const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));

      const save = () => {
        setBusy(true);
        setMsg('');
        post('config', form)
          .then((r) => { setBusy(false); setMsg(r.ok ? '已保存，马上生效，不用重启。' : r.error || '保存失败'); if (r.ok && onSaved) onSaved(r); })
          .catch((e) => { setBusy(false); setMsg(String(e)); });
      };

      const appReady = status && status.ready && status.ready.app;

      return h(
        'div',
        { className: 'bd-card' },
        h('div', { className: 'bd-kv' },
          h('span', { className: 'bd-name' }, '默认用哪种方式建模'),
          h('span', { className: 'bd-desc' }, '下面两个都是给 DSH 看的默认值。你也可以直接说「我要看着建」「后台建就行」，它会照办。')),

        h('div', { className: 'bd-choice' },
          h('button', {
            className: 'bd-opt', 'data-on': form.mode === 'app' ? '1' : '0',
            onClick: () => set({ mode: 'app' }),
          }, '看着建（推荐）',
            h('small', null, 'Blender 开着，你能实时看到每一块模型怎么长出来。适合探索、给你看、边看边调。')),
          h('button', {
            className: 'bd-opt', 'data-on': form.mode === 'terminal' ? '1' : '0',
            onClick: () => set({ mode: 'terminal' }),
          }, '后台建',
            h('small', null, '不开 Blender 也能建，只有最后结果。适合一次做很多个、或者你不想被打断。'))),

        !appReady
          ? h('div', { className: 'bd-note' },
              '「看着建」需要 Blender 开着且装好桥接组件 —— 现在还不能用。先按上面装一下，或者先用「后台建」。')
          : null,

        h('div', { className: 'bd-between' },
          h('div', { className: 'bd-kv' },
            h('span', { className: 'bd-name' }, '建完自动渲染预览图'),
            h('span', { className: 'bd-desc' }, '开着的话，DSH 会拿到预览图并自己检查像不像、比例对不对，不像就改。关掉会更快但成品质感会下降。')),
          h('button', {
            className: 'bd-opt', 'data-on': form.autoPreview ? '1' : '0',
            style: { flex: '0 0 auto' },
            onClick: () => set({ autoPreview: !form.autoPreview }),
          }, form.autoPreview ? '开着' : '关着')),

        h('details', { className: 'bd-adv' },
          h('summary', null, '高级（东西装在别处了才需要改）'),
          h('div', { className: 'bd-grid' },
            h('div', null,
              h('span', { className: 'bd-desc' }, 'Blender 装在哪儿（填 blender.exe 的完整路径）'),
              h('input', { className: 'bd-in', value: form.blenderPath, placeholder: '留空 = 自动找（含 Steam 库）',
                onChange: (e) => set({ blenderPath: e.target.value }) })),
            h('div', null,
              h('span', { className: 'bd-desc' }, '模型和预览图存到哪个文件夹'),
              h('input', { className: 'bd-in', value: form.outDir, placeholder: '留空 = DSH 目录下的 blender-output',
                onChange: (e) => set({ outDir: e.target.value }) })),
            h('div', null,
              h('span', { className: 'bd-desc' }, '预览图尺寸（宽 × 高）'),
              h('div', { className: 'bd-choice' },
                h('input', { className: 'bd-in', type: 'number', value: form.previewWidth, style: { flex: '1 1 90px' },
                  onChange: (e) => set({ previewWidth: Number(e.target.value) }) }),
                h('input', { className: 'bd-in', type: 'number', value: form.previewHeight, style: { flex: '1 1 90px' },
                  onChange: (e) => set({ previewHeight: Number(e.target.value) }) }))),
            h('div', null,
              h('span', { className: 'bd-desc' }, '实时建模用的连接端口'),
              h('input', { className: 'bd-in', type: 'number', value: form.bridgePort,
                onChange: (e) => set({ bridgePort: Number(e.target.value) }) })))),

        h('div', { className: 'bd-between' },
          h('span', { className: 'bd-desc' }, msg),
          h('button', { className: 'bd-btn bd-btn-main', disabled: busy, onClick: save },
            busy ? '保存中…' : '保存设置')),
      );
    }

    /* ---------------------------------------------------------- 技能安装 -- */

    function SkillBlock({ data, onReload }) {
      const [busy, setBusy] = useState(false);
      const [report, setReport] = useState(null);
      const status = data && data.status;
      const reg = (status && status.skills && status.skills.registry) || null;
      const info = report || reg;

      const recheck = () => {
        setBusy(true);
        get('skill')
          .then((r) => { setBusy(false); setReport(r && r.skill ? r.skill : null); if (onReload) onReload(); })
          .catch(() => setBusy(false));
      };

      const ok = !!(info && info.visible);
      const names = (info && info.bundledNames) || (status && status.skills && status.skills.names) || [];

      return h(
        'div',
        { className: `bd-card${ok ? ' good' : ''}` },
        h('div', { className: 'bd-between' },
          h('div', { className: 'bd-kv' },
            h('span', { className: 'bd-big' }, h(Dot, { ok }), ok ? '建模技能已经装进 DSH 了' : '建模技能还没生效'),
            h('span', { className: 'bd-desc' },
              '这个技能是插件替你装的，不用手动配置 —— 装好之后 DSH 就知道怎么建模、怎么自查。')),
          h('button', { className: 'bd-btn bd-btn-mini', disabled: busy, onClick: recheck },
            busy ? '检查中…' : '检查技能状态')),

        h('div', { className: 'bd-grid' },
          h('div', { className: 'bd-row' },
            h(Dot, { ok: info ? info.registryAvailable : null }),
            h('div', { className: 'bd-kv' },
              h('span', { className: 'bd-name' }, '技能服务'),
              h('span', { className: 'bd-val' },
                info && info.registryAvailable
                  ? '这个 profile 里可用'
                  : '这个 profile 里没有技能服务，技能装不进去（不影响建模本身）'))),

          h('div', { className: 'bd-row' },
            h(Dot, { ok: info ? info.inCatalog : null }),
            h('div', { className: 'bd-kv' },
              h('span', { className: 'bd-name' }, '出现在 DSH 的技能目录里'),
              h('span', { className: 'bd-val' },
                info && info.inCatalog
                  ? '在。DSH 一眼就能看到它。'
                  : '不在。可能插件刚更新过，重启一次 DSH 就会注册上。'))),

          h('div', { className: 'bd-row' },
            h(Dot, { ok: info ? info.loadable : null }),
            h('div', { className: 'bd-kv' },
              h('span', { className: 'bd-name' }, '说明书能正常加载'),
              h('span', { className: 'bd-val' },
                info && info.loadable
                  ? `能，正文 ${info.contentLength} 字。DSH 真正动手前会读它。`
                  : '还读不到。'))),

          h('div', { className: 'bd-row' },
            h(Dot, { ok: names.length > 0 }),
            h('div', { className: 'bd-kv' },
              h('span', { className: 'bd-name' }, '技能名'),
              h('span', { className: 'bd-val' }, names.length ? names.join('、') : '（插件里没找到技能文件）')))),

        info && info.error
          ? h('div', { className: 'bd-note bad' }, info.error)
          : null,

        // 这句在两种状态下都要说清楚，否则用户会一直找一个不存在的「安装」按钮
        h('div', { className: 'bd-note' },
          '技能是插件在加载时自动注册的，没有单独的「安装」按钮 —— 装插件就等于装了技能。',
          !ok && !busy
            ? ' 如果你刚更新过插件，请把 DSH 完全退出再重新打开一次，然后回来点「检查技能状态」。'
            : ''),

        h('details', { className: 'bd-adv' },
          h('summary', null, '技能文件在哪'),
          h('div', { className: 'bd-kv' },
            h('span', { className: 'bd-val' }, (info && info.bundledDir) || (status && status.skills && status.skills.dir) || '未知'),
            info && info.catalogNames && info.catalogNames.length
              ? h('span', { className: 'bd-val' }, `当前技能目录里共 ${info.catalogNames.length} 个：${info.catalogNames.join('、')}`)
              : null)),
      );
    }

    /* -------------------------------------------------------------- 试一下 -- */

    function TryBlock({ data, onMade }) {
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      const [elapsed, setElapsed] = useState(0);
      const cfg = data && data.config;
      const status = data && data.status;

      useEffect(() => {
        if (!busy) return undefined;
        const start = Date.now();
        const id = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
        return () => clearInterval(id);
      }, [busy]);

      const run = (mode) => {
        setBusy(true);
        setResult(null);
        setElapsed(0);
        post('run', { title: '试一下', instructions: DEMO_MODEL, mode, render: true })
          .then((r) => { setBusy(false); setResult(r); if (r.ok && onMade) onMade(); })
          .catch((e) => { setBusy(false); setResult({ ok: false, error: String(e) }); });
      };

      const openFolder = () => post('reveal', { path: cfg && cfg.outDir }).catch(() => {});

      return h(
        'div',
        { className: 'bd-card' },
        h('div', { className: 'bd-kv' },
          h('span', { className: 'bd-name' }, '试一下：建个简单的小塔'),
          h('span', { className: 'bd-desc' },
            '不用自己想模型 —— 这里内置了一个样例，点一下就能看到整条链路跑通：建模型 → 存 .blend → 渲染预览图。')),

        h('div', { className: 'bd-between' },
          h('span', { className: 'bd-desc' },
            busy ? `正在建…… 已经等了 ${elapsed} 秒` : '大约十几秒。用「看着建」时会让你在 Blender 里看到过程。'),
          h('div', { className: 'bd-choice' },
            h('button', {
              className: 'bd-btn bd-btn-main',
              disabled: busy || !(status && status.ready.app),
              title: status && status.ready.app ? '' : '需要 Blender 开着且装好桥接组件',
              onClick: () => run('app'),
            }, busy ? '正在建…' : '看着建'),
            h('button', {
              className: 'bd-btn', disabled: busy || !(status && status.ready.terminal),
              onClick: () => run('terminal'),
            }, '后台建'))),

        result
          ? h('div', { className: `bd-note${result.ok ? ' ok' : ' bad'}` },
              result.ok
                ? h('div', { className: 'bd-kv' },
                    h('span', null, `建好了，用了 ${result.mode === 'app' ? '「看着建」' : '「后台建」'}。`),
                    result.blend ? h('span', { className: 'bd-val' }, `模型文件：${result.blend}`) : null,
                    result.summary
                      ? h('span', { className: 'bd-val' },
                          `共 ${result.summary.count} 个部件：${result.summary.objects.map((o) => o.name).join('、')}`)
                      : null)
                : h('pre', { className: 'bd-pre' }, result.error || '没成功'),
              result.renderError ? h('span', { className: 'bd-val' }, `（预览图渲染失败：${result.renderError}）`) : null)
          : null,

        result && result.ok && (result.previews || []).length
          ? h('div', { className: 'bd-kv' },
              h('span', { className: 'bd-desc' }, '渲染出来的预览图（DSH 就是看这些图自己检查的）：'),
              h('div', { className: 'bd-gallery' },
                result.previews.map((p) => h('img', { key: p, src: fileUrl(p), alt: '预览图', loading: 'lazy' }))),
              h('div', { className: 'bd-between' },
                h('span', { className: 'bd-desc' }, `存到：${cfg && cfg.outDir}`),
                h('button', { className: 'bd-btn bd-btn-mini', onClick: openFolder }, '打开文件夹')))
          : null,
      );
    }

    /* ------------------------------------------------------------ 产物列表 -- */

    function OutputsBlock({ outputs, outDir, onShow }) {
      if (!outputs || !outputs.length) {
        return h('div', { className: 'bd-card' },
          h('span', { className: 'bd-desc' }, `还没有产出。模型会存到：${outDir || '未知'}`));
      }
      return h(
        'div',
        { className: 'bd-card' },
        h('span', { className: 'bd-desc' }, `最近产出（${outDir}）`),
        h('div', { className: 'bd-list' },
          outputs.slice(0, 12).map((o) =>
            h('div', { className: 'bd-item', key: o.path },
              h('div', { className: 'bd-kv' },
                h('b', null, o.name),
                h('span', { className: 'bd-meta' }, `${o.kind === 'blend' ? '模型文件' : '预览图'} · ${fmtSize(o.size)} · ${fmtTime(o.modified)}`)),
              h('div', { className: 'bd-choice' },
                o.kind === 'image'
                  ? h('button', { className: 'bd-btn bd-btn-mini', onClick: () => onShow(o.path) }, '查看')
                  : null,
                h('button', { className: 'bd-btn bd-btn-mini', onClick: () => post('reveal', { path: o.path }).catch(() => {}) }, '在文件夹里显示'))))),
      );
    }

    /* ---------------------------------------------------------------- 主体 -- */

    function App() {
      const [data, setData] = useState(null);
      const [outputs, setOutputs] = useState([]);
      const [outDir, setOutDir] = useState('');
      const [err, setErr] = useState('');
      const [tick, setTick] = useState(0);
      const [viewing, setViewing] = useState('');

      const reload = useCallback(() => setTick((n) => n + 1), []);

      useEffect(() => {
        let alive = true;
        get('status')
          .then((r) => { if (alive) { setData(r); setErr(''); } })
          .catch((e) => { if (alive) setErr(String(e)); });
        get('outputs')
          .then((r) => { if (alive && r && r.ok) { setOutputs(r.outputs); setOutDir(r.outDir); } })
          .catch(() => {});
        return () => { alive = false; };
      }, [tick]);

      return h(
        'div',
        { className: 'bd-wrap' },
        h('style', null, CSS),
        h('p', { className: 'bd-h' }, 'Blender 建模'),
        h('p', { className: 'bd-desc' },
          '让 DSH 连上 Blender 建模：可以在你眼前实时建（你能看到每一步），也可以在后台批量建。建完自动渲染预览图，DSH 会看图自己改。'),

        err ? h('div', { className: 'bd-note bad' }, `连不上插件后台：${err}`) : null,

        h(HealthCard, { data, onReload: reload }),
        h(SkillBlock, { data, onReload: reload }),
        h(SetupBlock, { data, onDone: reload }),
        h(SettingsBlock, { cfg: data && data.config, status: data && data.status, onSaved: (r) => setData(r) }),
        h(TryBlock, { data, onMade: reload }),

        viewing
          ? h('div', { className: 'bd-card' },
              h('div', { className: 'bd-between' },
                h('span', { className: 'bd-name' }, '预览图'),
                h('button', { className: 'bd-btn bd-btn-mini', onClick: () => setViewing('') }, '收起')),
              h('img', { src: fileUrl(viewing), alt: '预览图', style: { width: '100%', borderRadius: '10px' } }))
          : null,

        h(OutputsBlock, { outputs, outDir, onShow: setViewing }),

        h('p', { className: 'bd-desc' },
          '说明：全部在本机完成，不会上传你的模型。装一次桥接组件后，DSH 就能实时驱动 Blender。'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'blender', order: 535, label: () => 'Blender 建模' },
            () => h(App),
          ),
        );
      },
    };
  },
});
