/* 碎片漂浮歌词动画引擎（核心）
 * 每一句歌词是一个独立对象：随机位置、随机旋转、飞入 -> 停留 -> 飘走淡出。
 * 同屏可同时存在多条歌词，层层叠叠形成碎片氛围感。
 */
(function (global) {
  'use strict';

  const DEFAULTS = {
    minFont: 3,          // 最小字号 (vmin)
    maxFont: 7,          // 最大字号 (vmin)
    minRotate: 8,        // 最小旋转角度
    maxRotate: 30,       // 最大旋转角度
    fadeIn: 0.9,         // 飞入时长 (秒)
    fadeOut: 1.6,        // 飘走时长 (秒)
    minHold: 2.2,        // 最短停留 (秒)
    maxHold: 7,          // 最长停留 (秒)
    startScale: 0.6,
    endScale: 1.2,
    maxConcurrent: 6,    // 同屏最多几条
    marginX: 12,         // 水平安全边距 (%)
    marginY: 14,         // 垂直安全边距 (%)
    colors: ['#ffffff'], // 文字颜色，可多彩
    glow: true           // 是否加发光
  };

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }
  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  class LyricsAnimator {
    constructor(stage, options = {}) {
      this.stage = stage;
      this.opts = Object.assign({}, DEFAULTS, options);
      this.active = new Set();
    }

    setOptions(options = {}) {
      Object.assign(this.opts, options);
    }

    /* 生成一条漂浮歌词
     * @param {string} text 歌词文本
     * @param {number} duration 该句在时间轴上的持续秒数（用于停留时长）
     */
    spawn(text, duration = 4) {
      if (!text || !text.trim()) return null;
      const o = this.opts;

      // 超出并发上限时，提前移除最早的一条
      while (this.active.size >= o.maxConcurrent) {
        const oldest = this.active.values().next().value;
        this._remove(oldest);
      }

      const el = document.createElement('div');
      el.className = 'lyric-fragment';
      el.textContent = text;

      el.style.fontSize = rand(o.minFont, o.maxFont).toFixed(2) + 'vmin';
      el.style.color = pick(o.colors);
      if (o.glow) el.style.textShadow = '0 0 18px rgba(255,255,255,0.35), 0 0 40px rgba(120,180,255,0.15)';

      // 先挂载测量真实宽高，再把中心落点夹紧，保证整条歌词留在舞台内不被裁
      el.style.left = '50%';
      el.style.top = '50%';
      el.style.visibility = 'hidden';
      this.stage.appendChild(el);
      const stageW = this.stage.clientWidth || window.innerWidth || 1;
      const stageH = this.stage.clientHeight || window.innerHeight || 1;
      const halfW = (el.offsetWidth || 0) / 2;
      const halfH = (el.offsetHeight || 0) / 2;
      const padX = Math.max(o.marginX, (halfW / stageW) * 100 + 2);
      const padY = Math.max(o.marginY, (halfH / stageH) * 100 + 2);
      const x = padX >= 50 ? 50 : rand(padX, 100 - padX);
      const y = padY >= 50 ? 50 : rand(padY, 100 - padY);
      el.style.left = x + '%';
      el.style.top = y + '%';
      el.style.visibility = '';

      const rot = (Math.random() < 0.5 ? -1 : 1) * rand(o.minRotate, o.maxRotate);

      // 飞入 / 飘走方向
      const inAngle = Math.random() * Math.PI * 2;
      const inDist = rand(18, 48);
      const inX = Math.cos(inAngle) * inDist;
      const inY = Math.sin(inAngle) * inDist;
      const outAngle = inAngle + rand(-1.2, 1.2);
      const outDist = rand(12, 34);
      const outX = Math.cos(outAngle) * outDist;
      const outY = Math.sin(outAngle) * outDist;

      const hold = clamp(duration, o.minHold, o.maxHold);
      const segIn = o.fadeIn;
      const segOut = o.fadeOut;
      const total = (segIn + hold + segOut) * 1000;
      const pIn = segIn / (segIn + hold + segOut);
      const pHold = (segIn + hold) / (segIn + hold + segOut);

      this.active.add(el);

      const anim = el.animate(
        [
          {
            opacity: 0,
            filter: 'blur(8px)',
            transform: `translate(-50%,-50%) translate(${inX.toFixed(1)}vmin, ${inY.toFixed(1)}vmin) rotate(${(rot * 0.4).toFixed(1)}deg) scale(${o.startScale})`,
            offset: 0
          },
          {
            opacity: 1,
            filter: 'blur(0px)',
            transform: `translate(-50%,-50%) rotate(${rot.toFixed(1)}deg) scale(1)`,
            offset: pIn
          },
          {
            opacity: 1,
            filter: 'blur(0px)',
            transform: `translate(-50%,-50%) rotate(${rot.toFixed(1)}deg) scale(1.02)`,
            offset: pHold
          },
          {
            opacity: 0,
            filter: 'blur(5px)',
            transform: `translate(-50%,-50%) translate(${outX.toFixed(1)}vmin, ${outY.toFixed(1)}vmin) rotate(${(rot * 1.5).toFixed(1)}deg) scale(${o.endScale})`,
            offset: 1
          }
        ],
        { duration: total, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' }
      );

      anim.onfinish = () => this._remove(el);
      el._anim = anim;
      return el;
    }

    /* 音频律动：让当前所有歌词随节拍轻微闪亮（不打断主漂浮动画） */
    pulse(strength = 1) {
      for (const el of this.active) {
        el.animate([{ filter: 'brightness(1.6)' }, { filter: 'brightness(1)' }], {
          duration: 200 * strength,
          easing: 'ease-out'
        });
      }
    }

    _remove(el) {
      if (!el) return;
      this.active.delete(el);
      if (el._anim) {
        try { el._anim.cancel(); } catch (e) {}
      }
      if (el.parentNode) el.parentNode.removeChild(el);
    }

    clear() {
      for (const el of Array.from(this.active)) this._remove(el);
      this.active.clear();
    }
  }

  global.LyricsAnimator = LyricsAnimator;
})(window);
