/* pv-templates.js — 日式 PV 模板注册表（配合 pv-engine.js）
 * 复刻参考站 pv.pixjam.cn 的代表性字效风格，共 8 个模板：
 *   classic      经典金属逐字撒开
 *   blueBold     蓝色冲击（t=0）：鲜蓝底 + 超大白描边字 + 弹性飞入 + 奇偶错位
 *   cyberRuins   赛博废墟（t=3）：黑白 + 逐字白底卡片 + 网点/扫描线/颗粒/故障/暗角
 *   geometric    几何（t=4）：黄底 + 波浪差值字 + 同心方框 + 对角线
 *   rainCity     黑客帝国（t=5）：深青底 + 矩阵绿下落字 + 翻转 + 色差
 *   staggered    错落文字（t=10）：藏蓝 + 5 种布局循环 + 平滑插值 + 暗角
 *   girlyClouds  少女云朵（t=12）：浅粉 + 呼吸主字 + 45°条纹滚动 + 白云
 *   haruhikage   春日影（t=17）：灰蓝 + 蜡笔碎裂超大字 + 8 色随机 + 4 帧定格抖动
 *
 * 每个模板：{ label, bg, overlays?, postfx?, mount?, unmount?, build(ctx), update(ctx,dt) }
 */
(function (global) {
  'use strict';
  const PV = global.PVEngine;
  if (!PV) return;
  const ease = PV.ease;
  const clamp = PV.util.clamp;
  const rand = PV.util.rand;

  /* ---------- 共享工具 ---------- */
  // 竖直渐变填充（local 空间，逐字各自成渐变）；失败回退首色
  function gradient(stops) {
    try {
      const g = new PIXI.FillGradient({
        type: 'linear', start: { x: 0, y: 0 }, end: { x: 0, y: 1 }, textureSpace: 'local'
      });
      stops.forEach((s) => g.addColorStop(s[0], s[1]));
      return g;
    } catch (e) { return stops[0][1]; }
  }
  // 入场进度：age 已在引擎内按 speed 缩放
  function prog(age, delay, dur) {
    if (dur <= 0) return 1;
    return clamp((age - delay) / dur, 0, 1);
  }
  // 居中排布（自动换行）+ 自适应缩放：按实际行高总和校验，超高时对文字层统一缩小（关于画布中心），保证长句完整落在画面内
  function rowLayout(ctx, items, opt) {
    opt = opt || {};
    const fs = ctx.font.size;
    const gap = opt.gap != null ? opt.gap : fs * 0.06;
    const spaceW = opt.spaceW != null ? opt.spaceW : fs * 0.42;
    const maxW = opt.maxW != null ? opt.maxW : ctx.W * 0.88;
    const lineMul = opt.lineH != null ? opt.lineH : 1.24;
    const widths = items.map((it) => (it ? it.width : spaceW));
    const heights = items.map((it) => (it ? it.height : fs));
    // 横向换行
    const rows = []; let cur = []; let curW = 0;
    for (let i = 0; i < items.length; i++) {
      const w = widths[i];
      if (cur.length && curW + w > maxW) { rows.push(cur); cur = []; curW = 0; }
      cur.push({ i, w }); curW += w + gap;
    }
    if (cur.length) rows.push(cur);
    // 每行高度取行内最高字形，求总高
    const rowH = rows.map((r) => Math.max.apply(null, r.map((o) => heights[o.i])) * lineMul);
    const totalH = rowH.reduce((a, b) => a + b, 0);
    // 自适应：超高则整体缩小（下限防止过小不可读）
    const availH = ctx.H * 0.9;
    const S = clamp(Math.min(1, availH / Math.max(totalH, 1)), 0.3, 1);
    // 垂直居中（局部坐标），逐行累加行高
    let y = ctx.H / 2 - totalH / 2;
    const pos = [];
    rows.forEach((r, ri) => {
      const rowW = r.reduce((a, o) => a + o.w, 0) + gap * (r.length - 1);
      let x = ctx.W / 2 - rowW / 2;
      const cy = y + rowH[ri] / 2;
      r.forEach((o) => { pos[o.i] = { x: x + o.w / 2, y: cy }; x += o.w + gap; });
      y += rowH[ri];
    });
    // 对文字层施加统一适配缩放（关于画布中心），模板无需感知
    if (ctx.text) {
      ctx.text.scale.set(S);
      ctx.text.position.set(ctx.W / 2 * (1 - S), ctx.H / 2 * (1 - S));
    }
    return pos;
  }
  function signRand() { return Math.random() < 0.5 ? -1 : 1; }

  /* ================= classic 经典金属 ================= */
  PV.register('classic', {
    label: '经典金属',
    bg: null,
    build(ctx) {
      const st = ctx.state; st.items = [];
      ctx.chars.forEach((c) => {
        if (c.ch === ' ') { st.items.push(null); return; }
        const t = ctx.makeText(c.ch, {
          fontSize: ctx.font.size,
          fill: gradient([[0, 0xffffff], [0.36, 0xdcdfe3], [0.52, 0x9aa0a8], [0.64, 0x71767e], [1, 0xd8dce0]])
        });
        t._rot = rand(-28, 28) * Math.PI / 180;
        t._tx = rand(-0.3, 0.3); t._ty = rand(-0.5, 0.5);
        ctx.text.addChild(t); st.items.push(t);
      });
      st.pos = rowLayout(ctx, st.items);
    },
    update(ctx) {
      const st = ctx.state; if (!st.items || !st.pos) return;
      st.items.forEach((t, i) => {
        if (!t) return; const p = st.pos[i]; if (!p) return;
        const delay = i * 0.05, e = ease.backOut(prog(ctx.age, delay, 0.55));
        const tx = t._tx * ctx.font.size * (1 - e), ty = t._ty * ctx.font.size * (1 - e);
        const fl = Math.sin(ctx.time * 1.6 + i) * 3 * (ctx.params.motion || 1);
        t.position.set(p.x + tx, p.y + ty + fl);
        t.rotation = t._rot * (1 - e);
        t.scale.set((0.1 + 0.9 * e) * (1 + ctx.beat * 0.06));
        t.alpha = prog(ctx.age, delay, 0.3);
      });
    }
  });

  /* ================= blueBold 蓝色冲击 ================= */
  PV.register('blueBold', {
    label: '蓝色冲击',
    bg: 0x1447e6,
    postfx: { shake: 0.22 },
    mount(ctx) {
      const g = new PIXI.Graphics();
      g.rect(ctx.W * 0.04, ctx.H * 0.1, ctx.W * 0.2, ctx.H * 0.06).fill({ color: 0x0b2a99, alpha: 0.55 });
      g.rect(ctx.W * 0.74, ctx.H * 0.82, ctx.W * 0.22, ctx.H * 0.07).fill({ color: 0x0b2a99, alpha: 0.45 });
      g.poly([ctx.W * 0.86, ctx.H * 0.12, ctx.W * 0.98, ctx.H * 0.3, ctx.W * 0.8, ctx.H * 0.28])
        .fill({ color: 0x3f6bff, alpha: 0.5 });
      ctx.deco.addChild(g);
    },
    build(ctx) {
      const st = ctx.state; st.items = [];
      const fs = ctx.font.size * 1.22;
      ctx.chars.forEach((c, i) => {
        if (c.ch === ' ') { st.items.push(null); return; }
        const t = ctx.makeText(c.ch, {
          fontSize: fs, fontWeight: 900, fill: 0xffffff,
          style: { stroke: { color: 0x0a1a6b, width: fs * 0.13 } }
        });
        t._odd = i % 2 === 1; t._dir = signRand();
        ctx.text.addChild(t); st.items.push(t);
      });
      st.pos = rowLayout(ctx, st.items, { maxW: ctx.W * 0.84, lineH: 1.3 });
    },
    update(ctx) {
      const st = ctx.state; if (!st.items || !st.pos) return;
      const fs = ctx.font.size;
      st.items.forEach((t, i) => {
        if (!t) return; const p = st.pos[i]; if (!p) return;
        const delay = i * 0.055, e = ease.elasticOut(prog(ctx.age, delay, 0.85));
        const oy = t._odd ? fs * 0.16 : -fs * 0.16;
        t.position.set(p.x, p.y + oy + ctx.H * 0.5 * (1 - e));
        t.rotation = t._dir * (40 * Math.PI / 180) * (1 - e);
        t.scale.set(Math.max(0.01, e) * (1 + ctx.beat * 0.09));
        t.alpha = prog(ctx.age, delay, 0.2);
      });
    }
  });

  /* ================= cyberRuins 赛博废墟 ================= */
  PV.register('cyberRuins', {
    label: '赛博废墟',
    bg: 0x0a0a0a,
    overlays: ['dot', 'scanlines', 'grain', 'glitchbars', 'vignette'],
    postfx: { glitch: true },
    build(ctx) {
      const st = ctx.state; st.items = [];
      ctx.chars.forEach((c) => {
        if (c.ch === ' ') { st.items.push(null); return; }
        const fs = ctx.font.size * rand(0.82, 1.18);   // 字号 ±30% 随机
        const t = ctx.makeText(c.ch, { fontSize: fs, fontWeight: 900, fill: 0x111111 });
        const pad = fs * 0.3;
        const w = t.width + pad * 2, h = t.height + pad * 1.2;
        const cont = new PIXI.Container();
        const glow = new PIXI.Graphics();
        glow.rect(-w / 2 - 7, -h / 2 - 7, w + 14, h + 14).fill({ color: 0xffffff, alpha: 0.09 });
        const card = new PIXI.Graphics();
        card.rect(-w / 2, -h / 2, w, h).fill({ color: 0xf2f2f2 });
        cont.addChild(glow); cont.addChild(card); cont.addChild(t);
        cont._w = w; cont._phase = rand(0, 6.28); cont._glow = glow;
        ctx.text.addChild(cont); st.items.push(cont);
      });
      st.pos = rowLayout(ctx, st.items, { gap: ctx.font.size * 0.1 });
    },
    update(ctx) {
      const st = ctx.state; if (!st.items || !st.pos) return;
      st.items.forEach((cont, i) => {
        if (!cont) return; const p = st.pos[i]; if (!p) return;
        const delay = i * 0.045, e = ease.cubicOut(prog(ctx.age, delay, 0.5));
        const dy = (1 - e) * ctx.H * 0.16;
        const wob = Math.sin(ctx.time * 2.2 + cont._phase) * 4 * (ctx.params.motion || 1);
        cont.position.set(p.x, p.y + dy + wob);
        cont.scale.set(Math.max(0.01, e) * (1 + ctx.beat * 0.05));
        cont.rotation = Math.sin(ctx.time * 1.1 + cont._phase) * 0.02 * (ctx.params.motion || 1);
        cont.alpha = prog(ctx.age, delay, 0.25);
        if (cont._glow) cont._glow.alpha = 0.07 + ctx.beat * 0.16;
      });
    }
  });

  /* ================= geometric 几何 ================= */
  PV.register('geometric', {
    label: '几何黄',
    bg: 0xf2c200,
    overlays: ['hatch'],
    mount(ctx) {
      const g = new PIXI.Graphics();
      const cx = ctx.W / 2, cy = ctx.H / 2;
      for (let k = 1; k <= 4; k++) {
        const s = Math.min(ctx.W, ctx.H) * 0.12 * k;
        g.rect(cx - s / 2, cy - s / 2, s, s).stroke({ width: 3, color: 0x1a1a1a, alpha: 0.12 });
      }
      ctx.deco.addChild(g); ctx.state.deco = g;
    },
    build(ctx) {
      const st = ctx.state; st.items = [];
      ctx.chars.forEach((c, i) => {
        if (c.ch === ' ') { st.items.push(null); return; }
        const t = ctx.makeText(c.ch, { fontSize: ctx.font.size * 1.1, fontWeight: 900, fill: 0x111111 });
        try { t.blendMode = 'difference'; } catch (e) {}
        t._odd = i % 2 === 1;
        ctx.text.addChild(t); st.items.push(t);
      });
      st.pos = rowLayout(ctx, st.items, { maxW: ctx.W * 0.86 });
    },
    update(ctx) {
      const st = ctx.state; if (!st.items || !st.pos) return;
      const fs = ctx.font.size;
      st.items.forEach((t, i) => {
        if (!t) return; const p = st.pos[i]; if (!p) return;
        const delay = i * 0.04, e = ease.cubicOut(prog(ctx.age, delay, 0.5));
        const wave = Math.sin(p.x * 0.02 + ctx.time * 3) * fs * 0.18 * (ctx.params.motion || 1);
        const oy = t._odd ? fs * 0.22 : -fs * 0.22;
        t.position.set(p.x, p.y + oy + wave + fs * 0.6 * (1 - e));
        t.scale.set(Math.max(0.01, e) * (1 + ctx.beat * 0.05));
        t.alpha = prog(ctx.age, delay, 0.25);
      });
      if (st.deco) st.deco.rotation = Math.sin(ctx.time * 0.3) * 0.05;
    }
  });

  /* ================= rainCity 黑客帝国 ================= */
  PV.register('rainCity', {
    label: '矩阵雨城',
    bg: 0x02120f,
    postfx: { hue: 0.12 },
    mount(ctx) {
      const g = new PIXI.Graphics();
      g.rect(0, 0, ctx.W, ctx.H).fill({ color: 0x04231d, alpha: 0.6 });
      ctx.deco.addChild(g);
    },
    build(ctx) {
      const st = ctx.state; st.items = [];
      const fs = ctx.font.size * 1.05;
      ctx.chars.forEach((c) => {
        if (c.ch === ' ') { st.items.push(null); return; }
        const t = ctx.makeText(c.ch, {
          fontSize: fs, fontWeight: 800, fill: 0x39ff88,
          style: { stroke: { color: 0x001a0d, width: fs * 0.1 } }
        });
        t._speed = rand(0.7, 1.5); t._flip = rand(0, 6.28); t._rot = rand(-0.2, 0.2);
        ctx.text.addChild(t); st.items.push(t);
      });
      st.pos = rowLayout(ctx, st.items, { maxW: ctx.W * 0.86 });
    },
    update(ctx) {
      const st = ctx.state; if (!st.items || !st.pos) return;
      st.items.forEach((t, i) => {
        if (!t) return; const p = st.pos[i]; if (!p) return;
        const delay = i * 0.05;
        const e = ease.cubicOut(prog(ctx.age * t._speed, delay, 0.7));
        const startY = -ctx.H * 0.4;
        const y = startY + (p.y - startY) * e;
        t.position.set(p.x, y);
        // X 轴 3D 翻转错觉：scaleY 余弦摆动
        const flip = Math.cos(ctx.time * 2 * t._speed + t._flip);
        t.scale.set(1, Math.max(0.15, Math.abs(flip)) * (flip < 0 ? -1 : 1) * Math.max(0.01, e));
        t.rotation = t._rot * (1 - e) * 0.6;
        t.alpha = prog(ctx.age, delay, 0.3) * (0.75 + 0.25 * Math.abs(flip));
      });
    }
  });

  /* ================= staggered 错落文字 ================= */
  function staggerTargets(ctx, base, n, fs) {
    const W = ctx.W, H = ctx.H, cx = W / 2, out = [];
    // L0 居中行（base）
    out.push(base.map((p) => ({ x: p.x, y: p.y })));
    // L1 锯齿上下
    out.push(base.map((p, i) => ({ x: p.x, y: p.y + (i % 2 ? -fs * 0.55 : fs * 0.55) })));
    // L2 对角线
    const d = [];
    for (let i = 0; i < n; i++) {
      const f = n > 1 ? i / (n - 1) : 0.5;
      d.push({ x: W * 0.14 + f * W * 0.72, y: H * 0.24 + f * H * 0.52 });
    }
    out.push(d);
    // L3 竖排居中
    const v = []; const step = clamp(H * 0.8 / Math.max(1, n), fs * 0.7, fs * 1.3);
    const startY = H / 2 - (step * (n - 1)) / 2;
    for (let i = 0; i < n; i++) v.push({ x: cx, y: startY + i * step });
    out.push(v);
    // L4 波浪
    out.push(base.map((p, i) => ({ x: p.x, y: p.y + Math.sin(i * 0.7) * fs * 0.7 })));
    return out;
  }
  PV.register('staggered', {
    label: '错落文字',
    bg: 0x101a3a,
    overlays: ['vignette'],
    postfx: { hue: 0.05 },
    build(ctx) {
      const st = ctx.state; st.items = [];
      ctx.chars.forEach((c) => {
        if (c.ch === ' ') { st.items.push(null); return; }
        const t = ctx.makeText(c.ch, { fontSize: ctx.font.size, fontWeight: 800, fill: 0xffffff });
        t._dx = rand(-1, 1); t._dy = rand(-1, 1);
        ctx.text.addChild(t); st.items.push(t);
      });
      st.pos = rowLayout(ctx, st.items);
      st.n = ctx.chars.length;
      st.targets = staggerTargets(ctx, st.pos, st.n, ctx.font.size);
      st.li = 0; st.lt = 0;
      st.cur = st.pos.map((p) => (p ? { x: p.x, y: p.y } : null));
    },
    update(ctx, dt) {
      const st = ctx.state; if (!st.items || !st.cur) return;
      st.lt += dt;
      if (st.lt > 3.5) { st.lt = 0; st.li = (st.li + 1) % 5; }
      const tgt = st.targets[st.li] || st.pos;
      const k = clamp(dt * 2.4, 0, 1);   // lerp 平滑插值
      st.items.forEach((t, i) => {
        if (!t) return;
        const tp = tgt[i] || st.pos[i]; if (!tp) return;
        let c = st.cur[i]; if (!c) { c = st.cur[i] = { x: tp.x, y: tp.y }; }
        c.x += (tp.x - c.x) * k; c.y += (tp.y - c.y) * k;
        const drift = 3 * (ctx.params.motion || 1);
        t.position.set(
          c.x + Math.sin(ctx.time * 0.8 + i) * drift * t._dx,
          c.y + Math.cos(ctx.time * 0.7 + i) * drift * t._dy
        );
        const e = ease.cubicOut(prog(ctx.age, i * 0.04, 0.5));
        t.scale.set(Math.max(0.01, e) * (1 + ctx.beat * 0.05));
        t.alpha = prog(ctx.age, i * 0.04, 0.3);
      });
    }
  });

  /* ================= girlyClouds 少女云朵 ================= */
  PV.register('girlyClouds', {
    label: '少女云朵',
    bg: 0xffd6e7,
    mount(ctx) {
      const stripes = new PIXI.Graphics();
      ctx.deco.addChild(stripes);
      const clouds = new PIXI.Graphics();
      for (let i = 0; i < 5; i++) {
        const cx = rand(0.1, 0.9) * ctx.W, cy = rand(0.12, 0.85) * ctx.H, r = rand(0.05, 0.11) * Math.min(ctx.W, ctx.H);
        clouds.circle(cx, cy, r).fill({ color: 0xffffff, alpha: 0.85 });
        clouds.circle(cx + r * 0.8, cy + r * 0.2, r * 0.7).fill({ color: 0xffffff, alpha: 0.85 });
        clouds.circle(cx - r * 0.8, cy + r * 0.25, r * 0.6).fill({ color: 0xffffff, alpha: 0.85 });
      }
      ctx.deco.addChild(clouds);
      ctx.state.stripes = stripes; ctx.state.clouds = clouds;
      drawStripes(ctx);
    },
    build(ctx) {
      const st = ctx.state; st.items = [];
      const fs = ctx.font.size * 1.15;
      ctx.chars.forEach((c) => {
        if (c.ch === ' ') { st.items.push(null); return; }
        const t = ctx.makeText(c.ch, {
          fontSize: fs, fontWeight: 900, fill: 0xffffff,
          style: { stroke: { color: 0xff7ab0, width: fs * 0.1 } }
        });
        ctx.text.addChild(t); st.items.push(t);
      });
      st.pos = rowLayout(ctx, st.items, { maxW: ctx.W * 0.82 });
    },
    update(ctx, dt) {
      const st = ctx.state;
      if (st.stripes) { st.stripes.x -= dt * 40 * (ctx.params.motion || 1); if (st.stripes.x < -200) st.stripes.x += 200; }
      if (!st.items || !st.pos) return;
      const breathe = 1 + Math.sin(ctx.time * 1.8) * 0.05 * (ctx.params.motion || 1) + ctx.beat * 0.1;
      st.items.forEach((t, i) => {
        if (!t) return; const p = st.pos[i]; if (!p) return;
        const delay = i * 0.05, e = ease.backOut(prog(ctx.age, delay, 0.6));
        t.position.set(p.x, p.y);
        t.scale.set(Math.max(0.01, e) * breathe);
        t.alpha = prog(ctx.age, delay, 0.3);
      });
    }
  });
  function drawStripes(ctx) {
    const st = ctx.state, g = st.stripes; if (!g) return;
    g.clear();
    const s = 60;
    for (let x = -ctx.H; x < ctx.W + 400; x += s) {
      g.poly([x, ctx.H, x + ctx.H, 0, x + ctx.H + s * 0.5, 0, x + s * 0.5, ctx.H])
        .fill({ color: 0xffb3d1, alpha: 0.5 });
    }
  }

  /* ================= haruhikage 春日影 ================= */
  const CRAYON = [0xe74c3c, 0xf39c12, 0xf1c40f, 0x2ecc71, 0x1abc9c, 0x3498db, 0x9b59b6, 0xe67e22];
  PV.register('haruhikage', {
    label: '春日影',
    bg: 0x9fb2c6,
    build(ctx) {
      const st = ctx.state; st.items = [];
      const fs = ctx.font.size * 1.5;   // 超大蜡笔字
      ctx.chars.forEach((c) => {
        if (c.ch === ' ') { st.items.push(null); return; }
        const col = CRAYON[(Math.random() * CRAYON.length) | 0];
        const t = ctx.makeText(c.ch, {
          fontSize: fs * rand(0.9, 1.15), fontWeight: 900, fill: col,
          style: { stroke: { color: 0x2b2b2b, width: fs * 0.06 } }
        });
        t._ox = rand(-0.2, 0.2) * fs; t._oy = rand(-0.18, 0.18) * fs;
        t._rot = rand(-18, 18) * Math.PI / 180; t._col = col;
        ctx.text.addChild(t); st.items.push(t);
      });
      st.pos = rowLayout(ctx, st.items, { maxW: ctx.W * 0.86, lineH: 1.35 });
      st.frame = -1;
    },
    update(ctx) {
      const st = ctx.state; if (!st.items || !st.pos) return;
      // 4 帧定格循环：每 ~0.12s 换一帧，帧变时才更新抖动
      const f = Math.floor(ctx.time * 8);
      const frameChanged = f !== st.frame;
      if (frameChanged) st.frame = f;
      st.items.forEach((t, i) => {
        if (!t) return; const p = st.pos[i]; if (!p) return;
        const delay = i * 0.03, e = ease.quadOut(prog(ctx.age, delay, 0.35));
        if (frameChanged) {
          t._jx = rand(-4, 4); t._jy = rand(-4, 4); t._jr = rand(-3, 3) * Math.PI / 180;
        }
        t.position.set(p.x + t._ox + (t._jx || 0), p.y + t._oy + (t._jy || 0));
        t.rotation = t._rot + (t._jr || 0);
        t.scale.set(Math.max(0.01, e) * (1 + ctx.beat * 0.06));
        t.alpha = prog(ctx.age, delay, 0.2);
      });
    }
  });

})(typeof window !== 'undefined' ? window : globalThis);
