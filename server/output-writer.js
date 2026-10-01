/* server/output-writer.js — 信息输出（功能 4）+ OBS Text Source 适配
 *
 * 状态变化时节流(~1s)写两个文件到 output/：
 *   nowplaying.json  结构化当前播放信息
 *   nowplaying.txt   按模板渲染的纯文本，供 OBS "文本(从文件读取)" 源直接读取
 * 模板文件 output/template.txt 可自定义，占位符：
 *   {title} {artist} {album} {progress} {duration} {status} {player}
 * 只写自己 output/ 目录，不触碰其它文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const THROTTLE_MS = 1000;
const DEFAULT_TEMPLATE = '{title} - {artist}\n{progress} / {duration} ({status})';

function fmtTime(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return String(m).padStart(2, '0') + ':' + ss;
}

function createOutputWriter(opts = {}) {
  const outDir = opts.outDir || path.join(__dirname, '..', 'output');
  let lastWrite = 0;
  let timer = null;
  let pending = null;

  function ensureDir() {
    try { if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
  }

  function readTemplate() {
    const tp = path.join(outDir, 'template.txt');
    try {
      if (fs.existsSync(tp)) {
        const t = fs.readFileSync(tp, 'utf-8');
        if (t && t.trim()) return t.replace(/\r/g, '');
      }
    } catch (e) {}
    return DEFAULT_TEMPLATE;
  }

  function writeNow(state) {
    ensureDir();
    const tpl = readTemplate();
    const text = tpl
      .replace(/\{title\}/g, state.title || '')
      .replace(/\{artist\}/g, state.artist || '')
      .replace(/\{album\}/g, state.album || '')
      .replace(/\{progress\}/g, fmtTime(state.positionMs))
      .replace(/\{duration\}/g, fmtTime(state.durationMs))
      .replace(/\{status\}/g, state.status || '')
      .replace(/\{player\}/g, state.playerId || '');
    try { fs.writeFileSync(path.join(outDir, 'nowplaying.txt'), text, 'utf-8'); } catch (e) {}
    try {
      fs.writeFileSync(path.join(outDir, 'nowplaying.json'), JSON.stringify({
        ok: !!state.ok,
        player: state.playerId || '',
        source: state.source || '',
        status: state.status || '',
        title: state.title || '',
        artist: state.artist || '',
        album: state.album || '',
        progressMs: state.positionMs || 0,
        durationMs: state.durationMs || 0,
        progress: fmtTime(state.positionMs),
        duration: fmtTime(state.durationMs),
        cover: state.cover || '',
        hash: state.hash || '',
        ts: Date.now(),
      }, null, 2), 'utf-8');
    } catch (e) {}
  }

  return {
    // main 在每次统一状态事件时调用；内部节流
    update(state) {
      pending = state;
      const now = Date.now();
      if (now - lastWrite >= THROTTLE_MS) {
        lastWrite = now;
        writeNow(pending);
        pending = null;
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          lastWrite = Date.now();
          if (pending) { writeNow(pending); pending = null; }
        }, THROTTLE_MS - (now - lastWrite));
      }
    },
    ensureDir,
    outDir,
  };
}

module.exports = { createOutputWriter, fmtTime };
