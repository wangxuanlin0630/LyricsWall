/* LRC 歌词解析器
 * 支持标准 LRC：[mm:ss.xx]文本，一行可有多个时间戳。
 * 解析后返回按时间升序排列的数组：[{ time, text }]
 */
(function (global) {
  'use strict';

  // 匹配 [mm:ss] / [mm:ss.x] / [mm:ss.xx] / [mm:ss.xxx]
  const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  // 元信息标签，如 [ti:标题] [ar:歌手]
  const META_TAG = /^\[(ti|ar|al|by|offset|re|ve):(.*)\]$/i;

  function parse(lrcText) {
    const lines = String(lrcText || '').split(/\r\n|\n|\r/);
    const result = [];
    let offset = 0; // 毫秒，正值表示歌词整体提前
    const meta = {};

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      // 元信息
      const metaMatch = line.match(META_TAG);
      if (metaMatch && !/\d/.test(metaMatch[1])) {
        const key = metaMatch[1].toLowerCase();
        const val = metaMatch[2].trim();
        if (key === 'offset') offset = parseInt(val, 10) || 0;
        else meta[key] = val;
        continue;
      }

      // 时间戳 + 文本
      TIME_TAG.lastIndex = 0;
      const times = [];
      let m;
      let lastIndex = 0;
      while ((m = TIME_TAG.exec(line)) !== null) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        let frac = m[3] ? parseInt(m[3], 10) : 0;
        // 归一化小数部分到毫秒
        if (m[3]) {
          if (m[3].length === 1) frac *= 100;
          else if (m[3].length === 2) frac *= 10;
        }
        times.push(min * 60 + sec + frac / 1000);
        lastIndex = TIME_TAG.lastIndex;
      }

      if (!times.length) continue;

      const text = line.slice(lastIndex).trim();
      for (const t of times) {
        // offset 单位毫秒：正值提前 => 时间减去 offset
        const adjusted = Math.max(0, t - offset / 1000);
        result.push({ time: adjusted, text });
      }
    }

    result.sort((a, b) => a.time - b.time);

    // 计算每句持续时间（到下一句开始），最后一句给个默认值
    for (let i = 0; i < result.length; i++) {
      const next = result[i + 1];
      result[i].duration = next ? next.time - result[i].time : 5;
    }

    return { lines: result, meta };
  }

  global.LRC = { parse };
})(window);
