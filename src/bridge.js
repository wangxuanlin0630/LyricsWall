/* src/bridge.js — 传输抽象层
 * 让同一套 src/ 前端既能跑在 Electron（IPC），也能跑在浏览器（WebSocket+fetch）。
 * 对外统一暴露 window.wallAPI：
 *   mode:'electron'|'web', isElectron
 *   onNowPlaying(cb)  统一播放状态事件
 *   onLines(cb)       歌词行广播
 *   startFollow()/stopFollow()
 *   toggleFullscreen()/openAudio()/openLrc()   （仅 electron，web 返回 null）
 *   searchLyrics(kw)/getLyrics(id)             （仅 electron）
 *   openInBrowser()/getServerUrl()
 */
(function (global) {
  'use strict';

  var isElectron = typeof global.electronAPI !== 'undefined';

  function makeWebBridge() {
    var stateCbs = [], lineCbs = [], configCbs = [], pinCbs = [];
    var ws = null;

    function connect() {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      try { ws = new WebSocket(proto + '//' + location.host + '/ws'); }
      catch (e) { setTimeout(connect, 1500); return; }
      ws.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.type === 'state') stateCbs.forEach(function (cb) { cb(m.data); });
        else if (m.type === 'lines') lineCbs.forEach(function (cb) { cb(m.data); });
        else if (m.type === 'config') configCbs.forEach(function (cb) { cb(m.data); });
        else if (m.type === 'pin') pinCbs.forEach(function (cb) { cb(m.data); });
      };
      ws.onclose = function () { setTimeout(connect, 1500); };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    }
    connect();

    return {
      mode: 'web',
      isElectron: false,
      onNowPlaying: function (cb) { stateCbs.push(cb); },
      onLines: function (cb) { lineCbs.push(cb); },
      startFollow: function () {},   // 网页为只读展示，跟随由桌面端控制
      stopFollow: function () {},
      toggleFullscreen: function () {
        // 浏览器全屏 API
        try {
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen();
          return !!document.fullscreenElement;
        } catch (e) { return false; }
      },
      openAudio: function () { return null; },
      openLrc: function () { return null; },
      searchLyrics: function () { return { error: '网页端不支持在线搜索，请在桌面端操作' }; },
      getLyrics: function () { return { error: '网页端不支持，请在桌面端操作' }; },
      openInBrowser: function () {},
      getServerUrl: function () { return Promise.resolve(location.origin); },
      // 网页为只读输出：配置由桌面总控广播而来，仅拉取/监听，不回写
      getConfig: function () {
        return fetch('/api/config').then(function (r) { return r.json(); }).catch(function () { return {}; });
      },
      setConfig: function () { return Promise.resolve(null); },
      onConfig: function (cb) { configCbs.push(cb); },
      // 网页为只读展示：手动指定由桌面总控广播而来，仅监听不回写
      setManualPin: function () {},
      realignProgress: function () {},   // 网页只读展示，不可回写进度对齐
      onManualPin: function (cb) { pinCbs.push(cb); },
      // 网页端不展示控制台选择器，活跃播放器枚举仅桌面需要
      getActivePlayers: function () { return Promise.resolve([]); },
      // 网页输出为只读展示，字体名由桌面 config 广播；如需选择，尽力用浏览器本地字体 API
      listFonts: function () {
        if (typeof queryLocalFonts === 'function') {
          return queryLocalFonts().then(function (d) {
            var seen = {}, out = [];
            (d || []).forEach(function (f) { var n = f && f.family; if (n && !seen[n]) { seen[n] = 1; out.push(n); } });
            return out;
          }).catch(function () { return []; });
        }
        return Promise.resolve([]);
      },
      // 网页端无控制台：背景图由桌面端选择，此处不可操作
      bgPick: function () { return Promise.resolve(null); },
      winMinimize: function () {},
      winMaximize: function () {},
      winClose: function () {}
    };
  }

  function makeElectronBridge() {
    var api = global.electronAPI;
    return {
      mode: 'electron',
      isElectron: true,
      onNowPlaying: function (cb) { api.onNowPlaying(cb); },
      onLines: function (cb) { if (api.onLines) api.onLines(cb); },
      startFollow: function () { api.startFollow(); },
      stopFollow: function () { api.stopFollow(); },
      toggleFullscreen: function () { return api.toggleFullscreen(); },
      openAudio: function () { return api.openAudio(); },
      openLrc: function () { return api.openLrc(); },
      searchLyrics: function (kw) { return api.searchLyrics(kw); },
      getLyrics: function (id) { return api.getLyrics(id); },
      openInBrowser: function () { if (api.openInBrowser) api.openInBrowser(); },
      getConfig: function () { return api.getConfig ? api.getConfig() : Promise.resolve({}); },
      setConfig: function (patch) { return api.setConfig ? api.setConfig(patch) : Promise.resolve(null); },
      onConfig: function (cb) { if (api.onConfig) api.onConfig(cb); },
      setManualPin: function (pin) { if (api.setManualPin) api.setManualPin(pin); },
      realignProgress: function (ms) { if (api.realignProgress) api.realignProgress(ms); },
      onManualPin: function (cb) { if (api.onManualPin) api.onManualPin(cb); },
      listFonts: function () { return api.listFonts ? api.listFonts() : Promise.resolve([]); },
      getActivePlayers: function () { return api.getActivePlayers ? api.getActivePlayers() : Promise.resolve([]); },
      bgPick: function () { return api.bgPick ? api.bgPick() : Promise.resolve(null); },
      winMinimize: function () { if (api.winMinimize) api.winMinimize(); },
      winMaximize: function () { if (api.winMaximize) api.winMaximize(); },
      winClose: function () { if (api.winClose) api.winClose(); },
      getServerUrl: function () {
        if (api.getServerUrl) return api.getServerUrl();
        return Promise.resolve('');
      }
    };
  }

  global.wallAPI = isElectron ? makeElectronBridge() : makeWebBridge();
})(window);
