/* players/kugou-cdp.js — 酷狗专用适配器（SMTC 失效播放器的范例）
 * 酷狗不通过 SMTC 上报进度，故走 libcef 补丁后的 CDP 直连（只读 SuperCall(864)）。
 * 本文件仅把底层 kugou-cdp.js 的事件归一化为统一适配器事件。
 * 端口未开（未打补丁/酷狗未启动）时静默降级，由 registry 回退 SMTC/估算。
 */
'use strict';

const { createKugouCdp } = require('../kugou-cdp');

function createKugouCdpAdapter(onEvent, opts) {
  const inner = createKugouCdp((d) => {
    if (!onEvent) return;
    try {
      if (!d.ok) {
        onEvent({ ok: false, source: 'cdp', reason: d.reason || 'unavailable', ts: Date.now() });
        return;
      }
      if (d.status === 'nosong') {
        // 酷狗在运行但没歌：视为 stopped 且无曲目
        onEvent({
          ok: true, source: 'cdp', playerId: 'kugou', status: 'stopped',
          positionMs: 0, durationMs: 0, title: '', artist: '', album: '',
          cover: '', hash: '', updatedMs: d.ts || Date.now(), rate: 1, ts: d.ts || Date.now(),
        });
        return;
      }
      onEvent({
        ok: true,
        source: 'cdp',
        playerId: 'kugou',
        status: d.status,                 // playing / paused / stopped
        positionMs: Number(d.progressMs || 0),
        durationMs: Number(d.durationMs || 0),
        title: String(d.title || ''),
        artist: String(d.artist || ''),
        album: '',
        cover: String(d.cover || ''),     // 可能是 URL 或本地路径
        hash: String(d.hash || ''),
        updatedMs: Number(d.ts || Date.now()),
        rate: 1,
        ts: Number(d.ts || Date.now()),
      });
    } catch (e) { /* 忽略单次异常 */ }
  }, opts);

  return {
    start() { try { inner.start(); } catch (e) {} },
    stop() { try { inner.stop(); } catch (e) {} },
  };
}

module.exports = { createKugouCdpAdapter };
