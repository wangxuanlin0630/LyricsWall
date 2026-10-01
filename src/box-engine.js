/* box-engine.js — 3D 长方体歌词块引擎（Three.js + GSAP，桌面 app.js 与 overlay 内联共用）
 *
 * 规格：
 *  - 每句歌词 = 一个扁长 BoxGeometry（长宽比 6:1~10:1，厚度适中），表面 CanvasTexture 歌词文字
 *  - MeshPhysicalMaterial 半透明 + 自发光（emissive=发光色，强度可配），透明度可配（默认 .85）
 *  - 随机位置（拒绝采样避免重叠）/ 随机欧拉旋转（各轴 ±上限）/ 近大远小
 *  - 生命周期（GSAP）：到点淡入+远处漂入 → 停留自转+微漂移呼吸 → 到期淡出+旋转加速+向外飘散 → 回收
 *  - 同屏上限可配（超出最旧者提前离场）；对象池复用 mesh/材质/纹理；FPS 低自动降级
 *  - 背景为容器 CSS 深色径向渐变（透明输出时由调用方隐藏）；glow 用加色 Sprite 光晕
 *
 * API：BoxEngine.create({canvas,getFont,onFallback}) / setLyrics(lines) / setTime(sec) /
 *       setParams(p) / setTransparent(on) / setPaused(on) / reset() / resize() / destroy() / isActive()
 */
(function (global) {
  'use strict';

  const BoxEngine = {};
  let renderer = null, scene = null, camera = null;
  let canvas = null, container = null;
  let viewW = 16, viewH = 9, baseZ = 14;   // 可见范围/摄像机基准距离（resize 按宽高比重算）
  let getFont = () => '';
  let onFallback = () => {};
  let ro = null;
  let ready = false, creating = null, paused = false, transparent = false;
  let rafId = 0;

  let params = {
    size: 1, spacing: 0, color: '#ffffff', glowColor: '#78b4ff', glow: 0.9,
    alpha: 0.85, max: 5, stay: 4, in: 1, out: 1.2, rot: 25, spin: 15, echo: 3
  };

  const pool = [];          // 空闲槽
  const active = [];        // 在场槽
  let lines = [];           // [{time,text}]
  let spawned = new Set();  // 已触发句下标（reset 清空）
  let curT = 0, lastT = -1;
  let glowTex = null;

  // FPS 降级：0=满血 1=pixelRatio 1  2=pixelRatio .75 + 关光晕
  let fpsEma = 60, fpsCheckT = 0, degrade = 0, goodT = 0;

  const V3 = () => new THREE.Vector3();
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }

  /* ---------------- 光晕贴图（径向渐变，随发光色重建） ---------------- */
  let glowTexColor = '';
  function getGlowTexture(color) {
    if (glowTex && glowTexColor === color) return glowTex;
    const s = 128, c = document.createElement('canvas');
    c.width = s; c.height = s;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, hexToRgba(color, 0.34));
    grd.addColorStop(0.45, hexToRgba(color, 0.14));
    grd.addColorStop(1, hexToRgba(color, 0));
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
    if (glowTex) glowTex.dispose();
    glowTex = new THREE.CanvasTexture(c);
    glowTexColor = color;
    return glowTex;
  }
  function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return 'rgba(120,180,255,' + a + ')';
    const n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  // 板面底色：发光色混白 76% 得浅色调（参考效果＝浅色板面+深色字）
  function paleTint(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return '#cfe4f2';
    const n = parseInt(m[1], 16);
    const f = (v) => Math.round(v * 0.24 + 255 * 0.76);
    return 'rgb(' + f((n >> 16) & 255) + ',' + f((n >> 8) & 255) + ',' + f(n & 255) + ')';
  }

  /* ---------------- 对象池槽 ---------------- */
  const UNIT_BOX = () => new THREE.BoxGeometry(1, 1, 1);
  let unitGeo = null;

  function makeSlot() {
    const cv = document.createElement('canvas');
    cv.height = 160; cv.width = 960;
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 4;
    const matFace = new THREE.MeshPhysicalMaterial({
      map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: params.glow,
      transparent: true, opacity: 0, roughness: 0.35, metalness: 0.05, depthWrite: false
    });
    const matSide = new THREE.MeshPhysicalMaterial({
      color: 0x0d1420, transparent: true, opacity: 0, roughness: 0.5, metalness: 0.15, depthWrite: false
    });
    // 两端暗色端盖；上下长窄面与前后大面共用板纹理（窄面拉伸后＝沿长度延伸的小字）
    const mesh = new THREE.Mesh(unitGeo, [matSide, matSide, matFace, matFace, matFace, matFace]);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(params.glowColor), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    const group = new THREE.Group();
    group.add(sprite); group.add(mesh);
    return {
      group, mesh, sprite, cv, ctx: cv.getContext('2d'), tex, matFace, matSide,
      phase: 'idle', exitAt: 0, spinBoost: 0, drift: { x: 0, y: 0 }, basePos: V3(),
      rotVel: { x: 0, y: 0 }, phaseT: rand(0, 6.28), scaleBase: 1,
      cluster: 0, targetOpac: 0.85, slotIdx: 0, dimL: 0, dimH: 0, dimT: 0, rotMax: 0
    };
  }
  function acquire() {
    let s = pool.pop();
    if (!s) s = makeSlot();
    return s;
  }
  function recycle(s) {
    if (s.group.parent) scene.remove(s.group);
    gsap.killTweensOf(s.matFace); gsap.killTweensOf(s.matSide);
    gsap.killTweensOf(s.sprite.material); gsap.killTweensOf(s.group.position);
    gsap.killTweensOf(s.group.scale); gsap.killTweensOf(s.rotVel);
    s.matFace.opacity = 0; s.matSide.opacity = 0; s.sprite.material.opacity = 0;
    s.phase = 'idle'; s.spinBoost = 0; s.rotVel.x = 0; s.rotVel.y = 0; s.cluster = 0;
    pool.push(s);
  }

  /* ---------------- 文字纹理绘制 ---------------- */
  function drawText(s, text) {
    const g = s.ctx;
    const H = 160;
    const px = Math.round(96 * clamp(params.size, 0.4, 2.5));
    let fam = 'sans-serif';
    try { fam = getFont() || 'sans-serif'; } catch (e) {}
    g.font = '600 ' + px + 'px ' + fam;
    try { g.letterSpacing = (params.spacing || 0) + 'px'; } catch (e) {}
    const tw = g.measureText(text).width;
    // 目标长宽比夹紧 8~16（参考效果＝超长板条），反推画布宽（文字居中、两侧留 pad）
    const aspect = clamp((tw + px * 1.6) / H, 8, 16);
    const W = Math.round(H * aspect);
    if (s.cv.width !== W) { s.cv.width = W; }
    g.clearRect(0, 0, W, H);
    // 浅色板面（发光色混白），干净无描边；透明度交给材质 opacity 统一控制
    g.fillStyle = paleTint(params.glowColor);
    g.fillRect(0, 0, W, H);
    g.font = '600 ' + px + 'px ' + fam;
    try { g.letterSpacing = (params.spacing || 0) + 'px'; } catch (e) {}
    g.fillStyle = params.color || '#101826';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, W / 2, H / 2 + px * 0.04);
    s.tex.needsUpdate = true;
    return aspect;
  }

  /* ---------------- 生成 / 生命周期 ---------------- */
  // 固定构图槽位（视频同款）：主板正中、回声板对称偏移环绕、深度逐层推后；
  // 位置完全确定性不随机，奇偶簇镜像翻转避免呆板；整簇质心≈画面中心
  const CLUSTER_SLOTS = [
    [0, 0, 0], [0.42, -0.44, -3.6], [-0.46, 0.5, -6.2], [0.5, 0.54, -8.2], [-0.52, -0.52, -10]
  ];
  const CLUSTER_SCALE = [1, 0.72, 0.58, 0.5, 0.44];
  // 各槽滚转基准系数（×旋转上限）：后两块拉到大角度反向交叉，杜绝随机到同角度时平行完全重叠
  const SLOT_ROLL = [0, 0.85, -0.92, 0.6, -0.66];
  function slotPos(e, cluster, mx, my) {
    const sl = CLUSTER_SLOTS[e % CLUSTER_SLOTS.length];
    const flip = (cluster % 2) ? -1 : 1;
    return V3().set(
      clamp(sl[0] * flip * viewW * 0.3, -mx, mx),
      clamp(sl[1] * viewH * 0.3, -my, my),
      sl[2]
    );
  }

  let clusterSeq = 0;

  function spawn(idx) {
    const line = lines[idx];
    if (!line || !line.text) return;
    const cap = effectiveMax();
    // 同句歌词重复多块（视频同款回声簇）；重复数夹紧到同屏上限
    const echoes = Math.min(Math.round(clamp(params.echo || 1, 1, 5)), cap);
    if (active.length + echoes > cap) forceExitOldestCluster();
    const cluster = ++clusterSeq;
    for (let e = 0; e < echoes; e++) {
      spawnOne(idx, line, cluster, e);
    }
    spawned.add(idx);
  }

  // e=槽位下标（0=主板，其余回声板）；缩放/位置均由槽位表确定性给出
  function spawnOne(idx, line, cluster, e) {
    const s = acquire();
    const aspect = drawText(s, line.text);
    const mul = CLUSTER_SCALE[e % CLUSTER_SCALE.length];
    // 世界尺寸：高基准 1.55 * size * mul，长 = 高 * 长宽比，厚度适中
    const H = 1.55 * clamp(params.size, 0.4, 2.5) * mul;
    const L = H * aspect;
    const T = H * 0.42;
    const rr = (params.rot || 0) * Math.PI / 180 * (mul < 1 ? 1.25 : 1);
    // 按旋转后投影半长夹紧中心点范围：整块（含文字）留在画面内，不裁字
    const projHalf = (L * Math.cos(rr) + H * Math.sin(rr)) / 2;
    const mx = Math.min(10, Math.max(0, viewW / 2 - projHalf - 0.4));
    const my = Math.min(6, Math.max(0, viewH / 2 - H * 1.6 - 0.4));
    const pos = slotPos(e, cluster, mx, my);
    const near = 1 + pos.z * 0.045;              // 近大远小
    s.scaleBase = near;
    s.basePos.copy(pos);
    s.slotIdx = e; s.dimL = L; s.dimH = H; s.dimT = T; s.rotMax = rr;   // 供 relayout 自适应重排
    s.group.position.set(pos.x * 1.55, pos.y * 1.55, pos.z - 9);   // 入场起点：远处
    s.group.scale.set(L * 0.82 * near, H * 0.82 * near, T * 0.82 * near);
    // 滚转＝槽位确定性基准（大角度错落交叉，主导构图）+ 小抖动；
    // 俯仰/偏航收窄到 ±0.3rr 只补立体感，避免随机到与滚转叠加后两块平行贴合
    const rollBase = (SLOT_ROLL[e % SLOT_ROLL.length] || 0) * rr;
    s.group.rotation.set(rand(-rr, rr) * 0.3, rand(-rr, rr) * 0.3, rollBase + rand(-rr * 0.18, rr * 0.18));
    s.sprite.scale.set(L * 1.3 * near, H * 2.4 * near, 1);
    s.sprite.position.set(0, 0, -T * 0.6);
    applySlotColors(s);
    scene.add(s.group);
    active.push(s);
    s._lineIdx = idx;          // 供 setParams 重绘纹理用
    s.cluster = cluster;
    s.phase = 'in';
    s.exitAt = Math.max(line.time, curT) + clamp(params.stay, 1, 30);
    // GSAP 入场：淡入 + 漂移到目标位 + 缩放归位（光晕只留微弱一层；回声板更透）
    const din = clamp(params.in, 0.2, 4);
    const opac = params.alpha * (mul < 1 ? 0.8 : 1);
    s.targetOpac = opac;
    gsap.to(s.matFace, { opacity: opac, duration: din, ease: 'power2.out' });
    gsap.to(s.matSide, { opacity: opac * 0.95, duration: din, ease: 'power2.out' });
    gsap.to(s.sprite.material, { opacity: 0.32 * (mul < 1 ? 0.7 : 1), duration: din, ease: 'power2.out' });
    gsap.to(s.group.position, { x: pos.x, y: pos.y, z: pos.z, duration: din, ease: 'power2.out' });
    gsap.to(s.group.scale, { x: L * near, y: H * near, z: T * near, duration: din, ease: 'power2.out' });
  }

  function startExit(s, force) {
    if (s.phase === 'out') return;
    s.phase = 'out';
    const dout = clamp(params.out, 0.2, 4) * (force ? 0.6 : 1);
    const dir = s.basePos.clone();
    if (dir.lengthSq() < 0.01) dir.set(0, 1, 0);
    dir.normalize();
    s.rotVel.y = (Math.random() < 0.5 ? -1 : 1) * 2.2;   // 离场旋转加速
    s.rotVel.x = rand(-0.8, 0.8);
    gsap.to(s.matFace, { opacity: 0, duration: dout, ease: 'power1.in' });
    gsap.to(s.matSide, { opacity: 0, duration: dout, ease: 'power1.in' });
    gsap.to(s.sprite.material, { opacity: 0, duration: dout, ease: 'power1.in' });
    gsap.to(s.group.position, {
      x: s.basePos.x + dir.x * 5, y: s.basePos.y + dir.y * 3.4, z: s.basePos.z - 4,
      duration: dout, ease: 'power1.in'
    });
    gsap.delayedCall(dout + 0.05, () => {
      const i = active.indexOf(s);
      if (i >= 0) active.splice(i, 1);
      recycle(s);
    });
  }
  // 超上限时最旧的整簇（同句所有板）提前离场，保持“一句一簇”的视频构图
  function forceExitOldestCluster() {
    let oldest = null;
    for (let i = 0; i < active.length; i++) {
      const s = active[i];
      if (s.phase === 'out') continue;
      if (oldest === null || s.cluster < active[oldest].cluster) oldest = i;
    }
    if (oldest === null) return;
    const cid = active[oldest].cluster;
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].cluster === cid && active[i].phase !== 'out') startExit(active[i], true);
    }
  }
  function effectiveMax() {
    let m = Math.round(clamp(params.max, 2, 8));
    if (degrade >= 2) m = Math.max(2, m - 1);
    return m;
  }

  /* ---------------- 每帧 ---------------- */
  let prevNow = 0;
  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (paused || !ready) return;
    const dt = Math.min(0.05, (now - prevNow) / 1000 || 0.016);
    prevNow = now;
    // FPS 监控与自动降级/恢复
    fpsEma = fpsEma * 0.92 + (1 / Math.max(dt, 0.001)) * 0.08;
    fpsCheckT += dt;
    if (fpsCheckT > 2) {
      fpsCheckT = 0;
      if (fpsEma < 45 && degrade < 2) applyDegrade(degrade + 1);
      else if (fpsEma > 55) { goodT += 2; if (goodT > 6 && degrade > 0) { applyDegrade(degrade - 1); goodT = 0; } }
      else goodT = 0;
    }
    // 停留态：缓慢自转 + 微漂移呼吸；到期离场
    const spinRad = (params.spin || 0) * Math.PI / 180 / 60;
    for (let i = active.length - 1; i >= 0; i--) {
      const s = active[i];
      if (s.phase === 'in' && s.matFace.opacity >= s.targetOpac * 0.99) s.phase = 'stay';
      if (s.phase !== 'out') {
        s.group.rotation.y += (spinRad + s.rotVel.y) * dt * 60 * 0.016;
        s.group.rotation.x += s.rotVel.x * dt * 0.5;
        if (s.phase === 'stay') {
          s.group.position.y = s.basePos.y + Math.sin(now / 1000 * 0.6 + s.phaseT) * 0.14;
          s.group.position.x = s.basePos.x + Math.cos(now / 1000 * 0.45 + s.phaseT) * 0.1;
          s.sprite.material.opacity = 0.28 + Math.sin(now / 1000 * 1.4 + s.phaseT) * 0.07;
        }
        if (curT >= s.exitAt) startExit(s, false);
      } else {
        s.group.rotation.y += s.rotVel.y * dt;
        s.group.rotation.x += s.rotVel.x * dt;
      }
    }
    // 摄像机极缓慢漂移营造空间感
    camera.position.x = Math.sin(now / 1000 * 0.05) * 0.5;
    camera.position.y = Math.cos(now / 1000 * 0.04) * 0.3;
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }
  function applyDegrade(lv) {
    degrade = lv;
    if (!renderer) return;
    if (lv === 0) renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    else if (lv === 1) renderer.setPixelRatio(1);
    else renderer.setPixelRatio(0.75);
    for (let i = 0; i < active.length; i++) active[i].sprite.visible = lv < 2;
  }

  /* ---------------- 参数下发 ---------------- */
  function applySlotColors(s) {
    s.matFace.emissiveIntensity = params.glow;
    s.matSide.color.set(0x0d1420);
    s.sprite.material.map = getGlowTexture(params.glowColor);
    s.sprite.material.needsUpdate = true;
  }

  /* ---------------- 公共 API ---------------- */
  BoxEngine.create = function (opts) {
    opts = opts || {};
    canvas = opts.canvas || document.getElementById('boxCanvas');
    getFont = typeof opts.getFont === 'function' ? opts.getFont : () => '';
    onFallback = typeof opts.onFallback === 'function' ? opts.onFallback : () => {};
    container = canvas && canvas.parentElement ? canvas.parentElement : document.body;
    if (creating) return creating;
    if (!global.THREE || !global.gsap || !canvas) { onFallback(); return Promise.resolve(false); }
    creating = (async () => {
      try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      } catch (e) {
        renderer = null; creating = null; onFallback(); return false;
      }
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
      camera.position.set(0, 0, 14);
      scene.add(new THREE.AmbientLight(0x8899bb, 0.85));
      const dl = new THREE.DirectionalLight(0xffffff, 0.9);
      dl.position.set(4, 6, 8);
      scene.add(dl);
      const dl2 = new THREE.DirectionalLight(0x6688ff, 0.35);
      dl2.position.set(-5, -3, 4);
      scene.add(dl2);
      unitGeo = UNIT_BOX();
      ready = true;
      resize();
      if (global.ResizeObserver) {
        try { ro = new ResizeObserver(() => resize()); ro.observe(container); } catch (e) {}
      }
      prevNow = performance.now();
      rafId = requestAnimationFrame(tick);
      return true;
    })();
    return creating;
  };
  BoxEngine.isActive = function () { return ready && !!renderer; };
  // 调试快照：排查“无方块”时看歌词行数/已触发数/在场数/时间/画布尺寸
  BoxEngine.getDebug = function () {
    return {
      ready, paused, lines: lines.length, spawned: spawned.size, active: active.length,
      curT, lastT, degrade, fps: Math.round(fpsEma),
      slots: active.map((s) => [s.slotIdx, +s.basePos.x.toFixed(2), +s.basePos.y.toFixed(2), +s.basePos.z.toFixed(2)]),
      cw: canvas ? canvas.width : 0, ch: canvas ? canvas.height : 0,
      containerW: container ? container.clientWidth : 0, containerH: container ? container.clientHeight : 0
    };
  };
  BoxEngine.setPaused = function (on) { paused = !!on; };
  BoxEngine.setTransparent = function (on) { transparent = !!on; };
  BoxEngine.setLyrics = function (ls) {
    lines = Array.isArray(ls) ? ls : [];
    spawned = new Set();
    // 换词时清场重建
    for (let i = active.length - 1; i >= 0; i--) { const s = active[i]; active.splice(i, 1); recycle(s); }
  };
  BoxEngine.reset = function () {
    spawned = new Set();
    for (let i = active.length - 1; i >= 0; i--) { const s = active[i]; active.splice(i, 1); recycle(s); }
    lastT = -1;
  };
  BoxEngine.setTime = function (t) {
    if (!ready) return;
    curT = t;
    // 拖动/跳变检测：回退或大跨度前进 → 清场重来
    if (lastT >= 0 && (t < lastT - 0.3 || t > lastT + 2.5)) BoxEngine.reset();
    lastT = t;
    // 到点生成
    for (let i = 0; i < lines.length; i++) {
      if (spawned.has(i)) continue;
      const lt = lines[i].time;
      if (lt <= t && t < lt + clamp(params.stay, 1, 30) + clamp(params.out, 0.2, 4)) spawn(i);
      else if (lt > t) break;    // 已排序：后面更晚，跳过循环无意义但需标记过期
    }
    // 过期未生成句直接标记，避免回溯堆积
    for (let i = 0; i < lines.length; i++) {
      if (!spawned.has(i) && lines[i].time + clamp(params.stay, 1, 30) < t) spawned.add(i);
    }
  };
  BoxEngine.setParams = function (p) {
    if (!p) return;
    const redraw = (p.size != null && p.size !== params.size) ||
      (p.spacing != null && p.spacing !== params.spacing) ||
      (p.color != null && p.color !== params.color) ||
      (p.glowColor != null && p.glowColor !== params.glowColor);   // 板面底色跟发光色，变了要重绘
    Object.assign(params, p);
    params.size = clamp(params.size, 0.4, 2.5);
    params.max = Math.round(clamp(params.max, 2, 8));
    for (let i = 0; i < active.length; i++) applySlotColors(active[i]);
    if (redraw) {
      // 字号/字距/文字色变化：重绘在场纹理（几何尺寸不变，可接受）
      for (let i = 0; i < active.length; i++) {
        const idx = active[i]._lineIdx;
        if (idx != null && lines[idx]) drawText(active[i], lines[idx].text);
      }
    }
  };
  BoxEngine.resize = resize;
  function resize() {
    if (!ready || !renderer) return;
    const w = container ? container.clientWidth : 0;
    const h = container ? container.clientHeight : 0;
    if (w > 0 && h > 0) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // 摄像机按宽高比拉远：保证可见宽度容得下最长板条（竖屏不拉远必然裁字）
      const tanF = Math.tan(camera.fov * Math.PI / 360);
      const targetW = clamp(26 * params.size, 16, 44);
      baseZ = clamp(targetW / (2 * tanF * camera.aspect), 12, 46);
      camera.position.z = baseZ;
      viewH = 2 * baseZ * tanF;
      viewW = viewH * camera.aspect;
      relayout();   // 视口变化：在场块按槽位重新居中自适应
    }
  }
  // 自适应居中：按各块槽位重算夹紧范围与目标位，平滑归位（停留态 x/y 由呼吸逻辑跟 basePos 自动跟上）
  function relayout() {
    for (let i = 0; i < active.length; i++) {
      const s = active[i];
      if (s.phase === 'out' || !s.dimL) continue;
      const projHalf = (s.dimL * Math.cos(s.rotMax) + s.dimH * Math.sin(s.rotMax)) / 2;
      const mx = Math.min(10, Math.max(0, viewW / 2 - projHalf - 0.4));
      const my = Math.min(6, Math.max(0, viewH / 2 - s.dimH * 1.6 - 0.4));
      const pos = slotPos(s.slotIdx, s.cluster, mx, my);
      const near = 1 + pos.z * 0.045;
      gsap.killTweensOf(s.group.position); gsap.killTweensOf(s.basePos);
      if (s.phase === 'in') {
        s.basePos.copy(pos);
        gsap.to(s.group.position, { x: pos.x, y: pos.y, z: pos.z, duration: 0.4, ease: 'power2.out' });
      } else {
        // 停留态：补间 basePos 让呼吸逻辑平滑跟上 x/y；z 归位到 position
        s.basePos.z = pos.z;
        gsap.to(s.basePos, { x: pos.x, y: pos.y, duration: 0.4, ease: 'power2.out' });
        gsap.to(s.group.position, { z: pos.z, duration: 0.4, ease: 'power2.out' });
      }
      gsap.killTweensOf(s.group.scale);
      gsap.to(s.group.scale, { x: s.dimL * near, y: s.dimH * near, z: s.dimT * near, duration: 0.4, ease: 'power2.out' });
    }
  }
  BoxEngine.destroy = function () {
    if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    for (let i = active.length - 1; i >= 0; i--) { const s = active[i]; active.splice(i, 1); recycle(s); }
    pool.forEach((s) => {
      try { s.tex.dispose(); s.matFace.dispose(); s.matSide.dispose(); s.sprite.material.dispose(); } catch (e) {}
    });
    pool.length = 0;
    if (unitGeo) { try { unitGeo.dispose(); } catch (e) {} unitGeo = null; }
    if (glowTex) { try { glowTex.dispose(); } catch (e) {} glowTex = null; glowTexColor = ''; }
    if (renderer) { try { renderer.dispose(); } catch (e) {} }
    renderer = null; scene = null; camera = null;
    ready = false; paused = false; creating = null;
    spawned = new Set(); lines = []; lastT = -1;
  };

  global.BoxEngine = BoxEngine;
})(typeof window !== 'undefined' ? window : globalThis);
