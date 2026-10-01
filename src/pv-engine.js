/* pv-engine.js — PixiJS v8 日式 PV 引擎核心（桌面 app.js 与 overlay 内联脚本共用）
 *
 * 职责：
 *  - PIXI.Application 生命周期（异步 init、WebGL 失败回退 onFallback）
 *  - 逐字分段 + 字体解析（等 document.fonts.ready）
 *  - 缓动库 / 节拍时钟（BPM 合成 + 真实 beat 注入 pulse）
 *  - 叠加层（半调网点 / 扫描线 / 胶片颗粒 / 暗角 / 对角线 / 故障条）
 *  - 后期特效（色相偏移 / 故障抖动 / 根容器 shake-zoom-tilt）
 *  - 模板注册表装配（模板见 pv-templates.js）
 *  - Alpha 透明输出、ResizeObserver 驱动 resize
 *
 * 模板契约（PVEngine.register(id, def)）：
 *   def = {
 *     id, label,
 *     bg: number | fn(ctx) -> number,        // 背景色（透明模式自动隐藏 bgLayer）
 *     overlays: ['scanlines','grain',...],    // 默认叠加层 id
 *     postfx: { hue:0, glitch:false, shake:0, zoom:0 },
 *     mount(ctx)   -> void,                    // 建装饰，状态存 ctx.state
 *     unmount(ctx) -> void,
 *     build(ctx)   -> void,                    // 用 ctx.chars 建文字到 ctx.text
 *     update(ctx, dt) -> void                  // 每帧
 *   }
 *
 * ctx 提供：app, root, bg, deco, text, overlay 容器；ease；getter beat/time/params/
 *   transparent/age；font{family,size,weight}；chars[{ch,i,n}]；W/H；makeText(ch,opts)。
 */
(function (global) {
  'use strict';

  const PVEngine = {};
  const registry = {};

  PVEngine.register = function (id, def) { def.id = id; registry[id] = def; return def; };
  PVEngine.has = function (id) { return Object.prototype.hasOwnProperty.call(registry, id); };
  PVEngine.list = function () {
    return Object.keys(registry).map((id) => ({ id, label: registry[id].label || id }));
  };

  /* ---------------- 缓动库 ---------------- */
  const ease = {
    linear: (t) => t,
    quadOut: (t) => 1 - (1 - t) * (1 - t),
    cubicOut: (t) => 1 - Math.pow(1 - t, 3),
    cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    backOut: (t) => { const s = 1.70158; const u = t - 1; return 1 + u * u * ((s + 1) * u + s); },
    elasticOut: (t) => {
      if (t <= 0) return 0; if (t >= 1) return 1;
      const p = 0.42;
      return Math.pow(2, -10 * t) * Math.sin(((t - p / 4) * (2 * Math.PI)) / p) + 1;
    },
    // 入场过冲量：sin 包络，用于缩放/位移的弹性点缀
    overshoot: (t, amt) => Math.sin(Math.min(1, Math.max(0, t)) * Math.PI) * (amt || 0.05)
  };
  PVEngine.ease = ease;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  PVEngine.util = { clamp, rand };

  /* ---------------- 内部状态 ---------------- */
  let app = null;
  let ready = false;
  let creating = null;         // init Promise
  let canvas = null;
  let container = null;
  let getFont = () => '';
  let onFallback = () => {};
  let ro = null;               // ResizeObserver

  let root = null, bgLayer = null, decoLayer = null, textLayer = null, overlayLayer = null;
  let postFilter = null;

  let curId = null, curDef = null;
  let chars = [];
  let curText = null;
  let pendingText = null;

  let time = 0;                // 引擎累计秒
  let age = 0;                 // 距上次 setText 秒数
  let beatPhase = 0;
  let beatIntensity = 0;

  let transparent = false;
  let params = {
    speed: 1, motion: 1, bgAlpha: 1, bpm: 120, beat: 0.5, size: 1,
    fx: { grain: false, scan: false, glitch: false }
  };
  let fontInfo = { family: 'sans-serif', size: 64, weight: 800 };
  let fontsReadyPromise = null;

  /* ---------------- 纹理生成 ---------------- */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    return c;
  }
  function noiseTexture(size) {
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  function vignetteTexture(w, h) {
    const c = makeCanvas(Math.max(2, w | 0), Math.max(2, h | 0));
    const g = c.getContext('2d');
    const cx = c.width / 2, cy = c.height / 2;
    const r = Math.sqrt(cx * cx + cy * cy);
    const grd = g.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(0.7, 'rgba(0,0,0,0.25)');
    grd.addColorStop(1, 'rgba(0,0,0,0.72)');
    g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  /* ---------------- 叠加层 ---------------- */
  // 每个叠加层：build(ctx) -> DisplayObject；update?(obj, ctx, dt)
  const overlays = {
    scanlines: {
      build(ctx) {
        const g = new PIXI.Graphics();
        const step = 3;
        for (let y = 0; y < ctx.H; y += step) {
          g.rect(0, y, ctx.W, 1).fill({ color: 0x000000, alpha: 0.16 });
        }
        return g;
      }
    },
    dot: {
      build(ctx) {
        const g = new PIXI.Graphics();
        const step = 7;
        for (let y = step / 2; y < ctx.H; y += step) {
          for (let x = step / 2; x < ctx.W; x += step) {
            g.circle(x, y, 0.9).fill({ color: 0x000000, alpha: 0.12 });
          }
        }
        return g;
      }
    },
    hatch: {
      build(ctx) {
        const g = new PIXI.Graphics();
        const step = 12;
        for (let x = -ctx.H; x < ctx.W; x += step) {
          g.moveTo(x, ctx.H).lineTo(x + ctx.H, 0).stroke({ width: 1, color: 0x000000, alpha: 0.10 });
        }
        return g;
      }
    },
    grain: {
      build(ctx) {
        const size = 128;
        const tex = PIXI.Texture.from(noiseTexture(size));
        const sp = new PIXI.Sprite(tex);
        sp.width = ctx.W; sp.height = ctx.H;
        sp.alpha = 0.06;
        sp._noise = { size, frame: 0 };
        return sp;
      },
      update(obj, ctx, dt) {
        const n = obj._noise; if (!n) return;
        n.frame++;
        if (n.frame % 2 === 0) {
          try { obj.texture = PIXI.Texture.from(noiseTexture(n.size)); } catch (e) {}
        }
      }
    },
    vignette: {
      build(ctx) {
        const tex = PIXI.Texture.from(vignetteTexture(ctx.W, ctx.H));
        const sp = new PIXI.Sprite(tex);
        sp.width = ctx.W; sp.height = ctx.H; sp.alpha = 0.55;
        return sp;
      }
    },
    glitchbars: {
      build(ctx) {
        const g = new PIXI.Graphics();
        g._t = 0;
        return g;
      },
      update(obj, ctx, dt) {
        obj._t -= dt;
        if (obj._t > 0) return;
        obj._t = rand(0.12, 0.5);
        obj.clear();
        const n = (Math.random() * 4) | 0;
        for (let i = 0; i < n; i++) {
          const y = rand(0, ctx.H), h = rand(2, 16);
          obj.rect(0, y, ctx.W, h).fill({ color: Math.random() < 0.5 ? 0xffffff : 0x00ffff, alpha: rand(0.04, 0.14) });
        }
      }
    }
  };
  PVEngine.overlays = overlays;

  let activeOverlays = [];   // [{def, obj}]

  function rebuildOverlays() {
    if (!ready || !overlayLayer) return;
    overlayLayer.removeChildren().forEach((c) => { try { c.destroy(); } catch (e) {} });
    activeOverlays = [];
    const set = {};
    (curDef && curDef.overlays ? curDef.overlays : []).forEach((id) => { set[id] = true; });
    if (params.fx.grain) set.grain = true;
    if (params.fx.scan) { set.scanlines = true; }
    if (params.fx.glitch) set.glitchbars = true;
    Object.keys(set).forEach((id) => {
      const def = overlays[id]; if (!def) return;
      let obj = null;
      try { obj = def.build(ctx); } catch (e) { return; }
      if (!obj) return;
      overlayLayer.addChild(obj);
      activeOverlays.push({ def, obj });
    });
  }

  /* ---------------- ctx ---------------- */
  const ctx = {
    get app() { return app; },
    get root() { return root; },
    get bg() { return bgLayer; },
    get deco() { return decoLayer; },
    get text() { return textLayer; },
    get overlay() { return overlayLayer; },
    get W() { return app ? app.screen.width : (container ? container.clientWidth : 0); },
    get H() { return app ? app.screen.height : (container ? container.clientHeight : 0); },
    get chars() { return chars; },
    get time() { return time; },
    get age() { return age; },
    get beat() { return beatIntensity; },
    get params() { return params; },
    get transparent() { return transparent; },
    get font() { return fontInfo; },
    ease,
    util: PVEngine.util,
    state: {},
    // 便捷建字：字体自动套用，opts 覆盖 style 字段
    makeText(ch, opts) {
      const o = opts || {};
      const style = new PIXI.TextStyle(Object.assign({
        fontFamily: fontInfo.family,
        fontSize: o.fontSize != null ? o.fontSize : fontInfo.size,
        fontWeight: o.fontWeight != null ? o.fontWeight : fontInfo.weight,
        fill: o.fill != null ? o.fill : 0xffffff,
        letterSpacing: o.letterSpacing || 0
      }, o.style || {}));
      const t = new PIXI.Text({ text: ch, style });
      t.anchor && t.anchor.set(0.5);
      return t;
    }
  };
  PVEngine.ctx = ctx;

  /* ---------------- 节拍时钟 ---------------- */
  function updateBeat(dt) {
    const bps = Math.max(0.1, (params.bpm || 120) / 60);
    const prev = beatPhase;
    beatPhase += dt * bps;
    if (Math.floor(beatPhase) !== Math.floor(prev)) {
      beatIntensity = Math.max(beatIntensity, clamp(params.beat, 0, 1));
    }
    // 指数衰减
    beatIntensity *= Math.exp(-dt * 5.5);
    if (beatIntensity < 0.001) beatIntensity = 0;
  }
  PVEngine.pulse = function (v) {
    beatIntensity = clamp(v == null ? 1 : v, 0, 1.5);
  };

  /* ---------------- 后期特效 ---------------- */
  function applyPostfx(dt) {
    const pf = (curDef && curDef.postfx) || {};
    // 色相偏移
    const hue = pf.hue || 0;
    if (hue) {
      if (!postFilter) { postFilter = new PIXI.ColorMatrixFilter(); root.filters = [postFilter]; }
      postFilter.hue((hue * time * 20) % 360, false);
    } else if (postFilter) {
      root.filters = null; postFilter.destroy && postFilter.destroy(); postFilter = null;
    }
    // 根容器 shake / zoom（节拍驱动）
    let sx = 0, sy = 0, sc = 1;
    const shake = pf.shake || 0;
    if (shake) {
      const m = shake * beatIntensity * 18;
      sx = rand(-m, m); sy = rand(-m, m);
    }
    const zoom = pf.zoom || 0;
    if (zoom) sc = 1 + zoom * beatIntensity;
    // glitch：整体随机水平抖动
    if (params.fx.glitch && Math.random() < 0.06) sx += rand(-14, 14);
    root.x = sx; root.y = sy;
    root.scale.set(sc);
  }

  /* ---------------- 主循环 ---------------- */
  function tick(ticker) {
    const dt = Math.min(0.05, (ticker.deltaMS || 16) / 1000) * (params.speed || 1);
    time += dt; age += dt;
    updateBeat(dt);
    if (curDef && curDef.update) {
      try { curDef.update(ctx, dt); } catch (e) { /* 模板异常不崩引擎 */ }
    }
    for (let i = 0; i < activeOverlays.length; i++) {
      const o = activeOverlays[i];
      if (o.def.update) { try { o.def.update(o.obj, ctx, dt); } catch (e) {} }
    }
    applyPostfx(dt);
  }

  /* ---------------- 字体 ---------------- */
  function ensureFonts() {
    if (fontsReadyPromise) return fontsReadyPromise;
    if (document.fonts && document.fonts.ready) {
      fontsReadyPromise = document.fonts.ready.then(() => true).catch(() => true);
    } else {
      fontsReadyPromise = Promise.resolve(true);
    }
    return fontsReadyPromise;
  }
  function resolveFont() {
    let fam = 'sans-serif';
    try { fam = getFont() || 'sans-serif'; } catch (e) {}
    fontInfo.family = fam;
    // 基准字号随画布高度缩放（模板可再乘系数）
    const h = ctx.H || 600;
    fontInfo.size = Math.round(clamp(h * 0.14, 26, 200) * (params.size || 1));
    fontInfo.weight = 800;
  }

  /* ---------------- 生命周期 ---------------- */
  PVEngine.create = function (opts) {
    opts = opts || {};
    canvas = opts.canvas || document.getElementById('pvCanvas');
    getFont = typeof opts.getFont === 'function' ? opts.getFont : () => '';
    onFallback = typeof opts.onFallback === 'function' ? opts.onFallback : () => {};
    container = canvas && canvas.parentElement ? canvas.parentElement : document.body;

    if (creating) return creating;
    if (!global.PIXI || !canvas) { onFallback(); return Promise.resolve(false); }

    creating = (async () => {
      try {
        app = new PIXI.Application();
        await app.init({
          canvas,
          resizeTo: container,
          antialias: true,
          background: 0x000000,
          backgroundAlpha: transparent ? 0 : 1,
          preference: 'webgl'
        });
      } catch (e) {
        try { if (app) app.destroy(true); } catch (_) {}
        app = null; creating = null;
        onFallback();
        return false;
      }

      root = new PIXI.Container();
      bgLayer = new PIXI.Container();
      decoLayer = new PIXI.Container();
      textLayer = new PIXI.Container();
      overlayLayer = new PIXI.Container();
      root.addChild(bgLayer); root.addChild(decoLayer);
      root.addChild(textLayer); root.addChild(overlayLayer);
      app.stage.addChild(root);

      app.ticker.add(tick);
      ready = true;

      // 容器尺寸变化 → resize
      if (global.ResizeObserver) {
        try {
          ro = new ResizeObserver(() => PVEngine.resize());
          ro.observe(container);
        } catch (e) {}
      }

      resolveFont();
      await ensureFonts();
      if (pendingText != null) { const t = pendingText; pendingText = null; PVEngine.setText(t); }
      return true;
    })();
    return creating;
  };

  PVEngine.isActive = function () { return ready && !!app; };

  // 暂停/恢复：离开 PV 视图时停 ticker 但保留 WebGL 上下文，
  // 避免切回时对同一 canvas 重新 init 因上下文失效而失败回退老版 CSS 字
  PVEngine.setPaused = function (on) {
    if (!ready || !app || !app.ticker) return;
    try { if (on) app.ticker.stop(); else app.ticker.start(); } catch (e) {}
  };

  function clearLayer(layer) {
    if (!layer) return;
    layer.removeChildren().forEach((c) => { try { c.destroy(); } catch (e) {} });
  }

  // 统一装配：清空各层 → 画背景 → mount 装饰 → 叠加层 → 重建文字
  function assemble() {
    if (!ready || !curDef) return;
    ctx.state = {};
    clearLayer(bgLayer); clearLayer(decoLayer); clearLayer(textLayer);
    const bgc = typeof curDef.bg === 'function' ? curDef.bg(ctx) : curDef.bg;
    if (bgc != null && bgLayer) {
      const g = new PIXI.Graphics();
      g.rect(0, 0, ctx.W, ctx.H).fill({ color: bgc });
      g._bgfill = true; g._color = bgc;
      g.alpha = transparent ? 0 : params.bgAlpha;
      g.visible = !transparent;
      bgLayer.addChild(g);
    }
    try { curDef.mount && curDef.mount(ctx); } catch (e) {}
    rebuildOverlays();
    const t = ctx._lastText || '';
    curText = t; age = 0;
    chars = Array.from(t).map((ch, i, arr) => ({ ch, i, n: arr.length }));
    ensureFonts().then(() => {
      resolveFont();
      clearLayer(textLayer);
      try { curDef.build && curDef.build(ctx); } catch (e) {}
    });
  }

  PVEngine.setTemplate = function (id) {
    if (!ready) { return; }
    if (id === curId) return;
    if (curDef) { try { curDef.unmount && curDef.unmount(ctx); } catch (e) {} }
    const def = registry[id] || registry['classic'] || null;
    curDef = def; curId = def ? def.id : null;
    assemble();
  };

  PVEngine.setText = function (text) {
    const t = text || '';
    ctx._lastText = t;
    if (!ready) { pendingText = t; return; }
    if (t === curText) return;
    curText = t; age = 0;
    // 分段：按字符（空格保留占位）
    chars = Array.from(t).map((ch, i, arr) => ({ ch, i, n: arr.length }));
    if (!curDef) return;
    ensureFonts().then(() => {
      resolveFont();
      textLayer.removeChildren().forEach((c) => { try { c.destroy(); } catch (e) {} });
      try { curDef.build && curDef.build(ctx); } catch (e) {}
    });
  };

  PVEngine.setParams = function (p) {
    if (!p) return;
    const prevSize = params.size, prevBpmAlpha = params.bgAlpha;
    if (p.speed != null) params.speed = clamp(p.speed, 0.2, 4);
    if (p.motion != null) params.motion = clamp(p.motion, 0, 3);
    if (p.bgAlpha != null) params.bgAlpha = clamp(p.bgAlpha, 0, 1);
    if (p.bpm != null) params.bpm = clamp(p.bpm, 30, 300);
    if (p.beat != null) params.beat = clamp(p.beat, 0, 1);
    if (p.size != null) params.size = clamp(p.size, 0.4, 3);
    if (p.fx) params.fx = Object.assign(params.fx, p.fx);
    if (bgLayer) {
      bgLayer.children.forEach((c) => { if (c._bgfill) c.alpha = transparent ? 0 : params.bgAlpha; });
    }
    if (ready && p.size != null && p.size !== prevSize) {
      // 字号变化 → 重新排版
      const t = curText; curText = null; PVEngine.setText(t || '');
    }
    if (ready) rebuildOverlays();
    void prevBpmAlpha;
  };

  PVEngine.setTransparent = function (on) {
    transparent = !!on;
    if (app && app.renderer && app.renderer.background) {
      app.renderer.background.alpha = transparent ? 0 : 1;
    }
    if (bgLayer) {
      bgLayer.visible = !transparent;
      bgLayer.children.forEach((c) => { if (c._bgfill) c.alpha = transparent ? 0 : params.bgAlpha; });
    }
  };

  PVEngine.setFont = function (fn) {
    if (typeof fn === 'function') getFont = fn;
    if (!ready) return;
    fontsReadyPromise = null;
    ensureFonts().then(() => {
      resolveFont();
      const t = curText; curText = null; PVEngine.setText(t || '');
    });
  };

  PVEngine.resize = function () {
    if (!ready || !app) return;
    const w = container ? container.clientWidth : 0;
    const h = container ? container.clientHeight : 0;
    if (w > 0 && h > 0) {
      try { app.renderer.resize(w, h); } catch (e) {}
    }
    resolveFont();
    assemble();
  };

  PVEngine.destroy = function () {
    if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
    if (curDef) { try { curDef.unmount && curDef.unmount(ctx); } catch (e) {} }
    curDef = null; curId = null;
    if (app) { try { app.destroy(true, { children: true }); } catch (e) {} }
    app = null; ready = false; creating = null;
    root = bgLayer = decoLayer = textLayer = overlayLayer = null;
    postFilter = null; activeOverlays = [];
    chars = []; curText = null; pendingText = null;
    beatIntensity = 0; beatPhase = 0;
  };

  global.PVEngine = PVEngine;
})(typeof window !== 'undefined' ? window : globalThis);
