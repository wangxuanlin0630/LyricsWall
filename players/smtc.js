/* players/smtc.js — SMTC 通用适配器（多平台零漂移基线）
 * 启动 tools/nowplaying-watch.ps1 常驻进程，枚举系统媒体会话，
 * 把输出归一化为统一适配器事件。对 SMTC 上报 position 的播放器
 * （QQ/网易云/酷我/汽水/Spotify/Apple/PotPlayer/Foobar 等）即获得零漂移 + 拖动感知。
 * 只读，不控制播放器；进程崩溃自动重启。
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const RESTART_MS = 1500;

// SMTC PlaybackStatus 枚举 → 统一状态
function mapStatusInt(n) {
  if (n === 4) return 'playing';
  if (n === 5) return 'paused';
  return 'stopped';
}

function createSmtcAdapter(onEvent) {
  let proc = null;
  let running = false;
  let restartTimer = null;
  let preferredPattern = '';    // 首选播放器过滤正则（传给 watch 脚本 $args[0]）；空=不偏好
  let activeSourceIds = [];     // 最近一轮看到的所有已注册会话 sourceId

  function emit(ev) { if (onEvent) { try { onEvent(ev); } catch (e) {} } }

  function scheduleRestart() {
    if (!running || restartTimer) return;
    restartTimer = setTimeout(() => { restartTimer = null; if (running) launch(); }, RESTART_MS);
  }

  function launch() {
    let script = path.join(__dirname, '..', 'tools', 'nowplaying-watch.ps1');
    // 打包后 tools 被 asarUnpack 解包为真实文件；外部 powershell.exe 无法读取 app.asar 归档内路径，需重定向到 app.asar.unpacked
    script = script.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    try {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
      if (preferredPattern) args.push(preferredPattern);   // watch 脚本按此正则只认首选播放器的会话
      proc = spawn('powershell.exe', args, { windowsHide: true });
    } catch (e) {
      proc = null;
      scheduleRestart();
      return;
    }

    let buffer = '';
    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let d;
        try { d = JSON.parse(line); } catch (e) { continue; }
        if (!d || typeof d !== 'object') continue;
        if (Array.isArray(d.sessions)) activeSourceIds = d.sessions.map((x) => String(x));
        if (!d.ok) {
          emit({ ok: false, source: 'smtc', reason: d.reason || 'none', ts: Date.now() });
          continue;
        }
        emit({
          ok: true,
          source: 'smtc',
          sourceId: String(d.sourceId || ''),
          status: mapStatusInt(d.status),
          positionMs: Number(d.position || 0),
          durationMs: Number(d.duration || 0),
          title: String(d.title || ''),
          artist: String(d.artist || ''),
          album: String(d.album || ''),
          cover: d.coverPath ? String(d.coverPath) : '',
          // KuGou.ini 的 hash 仅在当前会话确为酷狗时附加；否则会把酷狗上次歌曲的 hash 泄漏给网易云/QQ 导致歌词错配
          hash: (/kugou|kgmusic|\bkg\b/i.test(String(d.sourceId || '')) && d.krcHash) ? String(d.krcHash) : '',
          updatedMs: Number(d.lastUpdated || 0),
          rate: Number(d.rate || 1) > 0 ? Number(d.rate) : 1,
          ts: Date.now(),
        });
      }
    });

    proc.on('error', () => { proc = null; scheduleRestart(); });
    proc.on('exit', () => { proc = null; scheduleRestart(); });
  }

  return {
    start() { if (running) return; running = true; launch(); },
    stop() {
      running = false;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (proc) { try { proc.kill(); } catch (e) {} proc = null; }
    },
    // 设置首选播放器过滤正则；变化时杀进程，exit 回调会自动以新参数重启
    setPreferred(pattern) {
      const p = String(pattern || '');
      if (p === preferredPattern) return;
      preferredPattern = p;
      if (!running) return;
      if (proc) { try { proc.kill(); } catch (e) {} }   // → exit → scheduleRestart → launch（新 pattern）
      else if (!restartTimer) { launch(); }
    },
    getActiveSourceIds() { return activeSourceIds.slice(); },
  };
}

module.exports = { createSmtcAdapter, mapStatusInt };
