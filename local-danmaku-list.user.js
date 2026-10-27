// ==UserScript==
// @name         B站本地弹幕XML注入（含弹幕列表）
// @namespace    hinome_no_danmaku_list
// @version      1.0.0
// @description  读取本地弹幕 XML（录播姬/B站格式），叠加渲染到B站视频播放器上，并与视频进度同步；同时在原生弹幕列表区域显示本地弹幕行
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/list/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SCROLL_TIME = 8; // 滚动弹幕穿越时间(秒)
  const FIXED_TIME = 4;  // 顶部/底部弹幕停留时间(秒)
  const settings = {
    displayArea: 100,
    opacity: 90,
    fontScale: 100,
    speed: 100,
    scaleWithScreen: true,
    blockScroll: false,
    blockTop: false,
    blockBottom: false,
    blockColorful: false,
  };

  let danmakus = []; // {t, mode, size, color, text}
  let layer = null;
  let video = null;
  let idx = 0;
  let enabled = true;
  let lastTime = 0;
  let rafId = 0;
  let lanes = { scroll: [], top: [], bottom: [] };
  let listPanel = null;
  let listBody = null;
  let listTitle = null;
  let listKey = '';
  let listVersion = 0;
  const LIST_LIMIT = 100; // 列表最多显示当前时间之前的条数
  // B站弹幕列表容器（新旧版播放器），按顺序尝试
  const LIST_HOST_SELECTORS = ['.bpx-player-dm-list', '#danmukuBox .danmaku-wrap', '#danmukuBox', '.danmaku-box'];

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const list = [];
    doc.querySelectorAll('d').forEach((el) => {
      const p = (el.getAttribute('p') || '').split(',');
      const t = parseFloat(p[0]);
      if (isNaN(t)) return;
      const parsedColor = parseInt(p[3], 10);
      list.push({
        t,
        mode: parseInt(p[1], 10) || 1,
        size: parseInt(p[2], 10) || 25,
        color: Number.isNaN(parsedColor) ? 0xffffff : parsedColor,
        text: el.textContent,
      });
    });
    list.sort((a, b) => a.t - b.t);
    return list;
  }

  function addSettingToggle(label, key) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = settings[key];
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      if (input.checked && layer) {
        layer.querySelectorAll('[data-danmaku-position]').forEach((el) => {
          if (isBlocked(el.dataset.danmakuPosition, el.dataset.danmakuColorful === 'true')) {
            el.remove();
          }
        });
      }
    });
    const title = document.createElement('span');
    title.textContent = label;
    row.append(input, title);
    settingsPanel.appendChild(row);
  }

  function findVideo() {
    return document.querySelector('.bpx-player-video-wrap video, #bilibiliPlayer video, video');
  }

  function ensureLayer() {
    video = findVideo();
    if (!video) return false;
    const host = video.closest('.bpx-player-video-area, .bpx-player-container, #bilibiliPlayer') || video.parentElement;
    if (layer && layer.isConnected && layer.parentElement === host) return true;
    if (layer) layer.remove();
    layer = document.createElement('div');
    layer.id = 'local-danmaku-layer';
    layer.style.cssText =
      'position:absolute;top:0;left:0;width:100%;overflow:hidden;pointer-events:none;z-index:50;';
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(layer);
    applySettings();
    return true;
  }

  function applySettings() {
    if (layer) {
      layer.style.height = `${settings.displayArea}%`;
      layer.querySelectorAll('[data-danmaku-opacity]').forEach((el) => {
        el.style.opacity = settings.opacity / 100;
      });
    }
    if (settingsPanel) updateSettingsLabels();
  }

  function clearScreen() {
    if (layer) layer.innerHTML = '';
    lanes = { scroll: [], top: [], bottom: [] };
  }

  function seekTo(t) {
    clearScreen();
    let lo = 0, hi = danmakus.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (danmakus[mid].t < t) lo = mid + 1; else hi = mid;
    }
    idx = lo;
    lastTime = t;
  }

  function pickLane(arr, now, laneHeight, maxLanes, busyUntil) {
    for (let i = 0; i < maxLanes; i++) {
      if (!arr[i] || arr[i] <= now) {
        arr[i] = busyUntil;
        return i;
      }
    }
    return -1;
  }

  function isBlocked(position, colorful) {
    return (settings.blockScroll && position === 'scroll') ||
      (settings.blockTop && position === 'top') ||
      (settings.blockBottom && position === 'bottom') ||
      (settings.blockColorful && colorful);
  }

  function emit(d) {
    const w = layer.clientWidth;
    const h = layer.clientHeight;
    if (!w || !h) return;
    const playerHeight = layer.parentElement.clientHeight;
    const screenScale = settings.scaleWithScreen ? playerHeight / 600 : 1;
    const fontSize = Math.max(12, Math.round(d.size * (settings.fontScale / 100) * screenScale * 0.8 + 6));
    const laneH = fontSize + 4;
    const maxLanes = Math.max(1, Math.floor((h * 0.8) / laneH));
    const now = performance.now() / 1000;

    const el = document.createElement('div');
    el.textContent = d.text;
    el.style.cssText =
      `position:absolute;white-space:pre;font-weight:bold;font-family:SimHei,"Microsoft YaHei",sans-serif;` +
      `font-size:${fontSize}px;line-height:${laneH}px;opacity:${settings.opacity / 100};will-change:transform;` +
      `color:#${(d.color & 0xffffff).toString(16).padStart(6, '0')};` +
      'text-shadow:1px 0 1px #000,0 1px 1px #000,0 -1px 1px #000,-1px 0 1px #000;';
    layer.appendChild(el);
    el.dataset.danmakuOpacity = 'true';
    el.dataset.danmakuPosition = d.mode === 5 ? 'top' : d.mode === 4 ? 'bottom' : 'scroll';
    el.dataset.danmakuColorful = String((d.color & 0xffffff) !== 0xffffff);
    const tw = el.offsetWidth;

    if (d.mode === 4 || d.mode === 5) {
      const key = d.mode === 5 ? 'top' : 'bottom';
      const lane = pickLane(lanes[key], now, laneH, maxLanes, now + FIXED_TIME);
      if (lane < 0) return el.remove();
      el.style.left = `${(w - tw) / 2}px`;
      if (key === 'top') el.style.top = `${lane * laneH}px`;
      else el.style.bottom = `${lane * laneH}px`;
      const timer = el.animate(
        [{ transform: 'translateY(0)' }, { transform: 'translateY(0)' }],
        { duration: FIXED_TIME * 1000 }
      );
      timer.onfinish = () => el.remove();
      if (video.paused || !enabled) timer.pause();
      return;
    }

    // 滚动弹幕：按进入屏幕所需时间占用车道，避免重叠
    const duration = SCROLL_TIME * 100 / settings.speed;
    const speed = (w + tw) / duration;
    const clearTime = now + tw / speed + 0.3;
    const lane = pickLane(lanes.scroll, now, laneH, maxLanes, clearTime);
    if (lane < 0) return el.remove();
    el.style.top = `${lane * laneH}px`;
    el.style.left = '0';
    const anim = el.animate(
      [{ transform: `translateX(${w}px)` }, { transform: `translateX(${-tw}px)` }],
      { duration: duration * 1000, easing: 'linear', fill: 'forwards' }
    );
    anim.onfinish = () => el.remove();
    if (video.paused || !enabled) anim.pause();
  }

  function setPaused(paused) {
    if (!layer) return;
    layer.getAnimations({ subtree: true }).forEach((a) => (paused ? a.pause() : a.play()));
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (!enabled || !danmakus.length || !ensureLayer()) return;
    if (layer.style.display === 'none') return;
    const t = video.currentTime;
    if (Math.abs(t - lastTime) > 1.5 || t < lastTime - 0.1) seekTo(t);
    if (video.paused) return;
    let count = 0;
    while (idx < danmakus.length && danmakus[idx].t <= t) {
      const d = danmakus[idx];
      const position = d.mode === 5 ? 'top' : d.mode === 4 ? 'bottom' : 'scroll';
      const colorful = (d.color & 0xffffff) !== 0xffffff;
      if (!isBlocked(position, colorful) && t - d.t < 1.5 && count < 30) {
        emit(d);
        count++;
      }
      idx++;
    }
    lastTime = t;
  }

  function formatTime(t) {
    const sec = Math.floor(t);
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }

  // 公共播放器 API 不能写入原生弹幕列表，因此在原生列表容器内追加独立的“本地”区块
  function ensureListPanel() {
    if (listPanel && listPanel.isConnected) return true;
    let host = null;
    for (const sel of LIST_HOST_SELECTORS) {
      host = document.querySelector(sel);
      if (host) break;
    }
    if (!host) return false;
    listPanel = document.createElement('div');
    listPanel.id = 'local-danmaku-list';
    listPanel.style.cssText =
      'margin-top:8px;border:1px dashed #00a1d6;border-radius:6px;font-size:12px;color:#61666d;background:#f6f7f8;';
    listTitle = document.createElement('div');
    listTitle.style.cssText = 'padding:6px 10px;color:#00a1d6;font-weight:bold;border-bottom:1px dashed #00a1d6;';
    listBody = document.createElement('div');
    listBody.style.cssText = 'max-height:240px;overflow-y:auto;';
    listPanel.append(listTitle, listBody);
    host.appendChild(listPanel);
    listKey = '';
    return true;
  }

  function syncList() {
    if (!listVersion) return;
    if (!ensureListPanel()) return;
    listPanel.style.display = enabled ? '' : 'none';
    const v = findVideo();
    const t = v ? v.currentTime : 0;
    let lo = 0, hi = danmakus.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (danmakus[mid].t <= t) lo = mid + 1; else hi = mid;
    }
    const blockState = [settings.blockScroll, settings.blockTop, settings.blockBottom, settings.blockColorful].join();
    const key = `${listVersion}:${lo}:${blockState}`;
    if (key === listKey) return;
    listKey = key;
    listTitle.textContent = `本地弹幕（${danmakus.length}条，非平台弹幕）`;
    const stick = listBody.scrollHeight - listBody.scrollTop - listBody.clientHeight < 30;
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (let i = lo - 1; i >= 0 && shown < LIST_LIMIT; i--) {
      const d = danmakus[i];
      const position = d.mode === 5 ? 'top' : d.mode === 4 ? 'bottom' : 'scroll';
      if (isBlocked(position, (d.color & 0xffffff) !== 0xffffff)) continue;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;padding:3px 10px;line-height:18px;';
      const time = document.createElement('span');
      time.textContent = formatTime(d.t);
      time.style.cssText = 'flex:none;width:36px;';
      const tag = document.createElement('span');
      tag.textContent = '本地';
      tag.style.cssText = 'flex:none;padding:0 4px;border-radius:3px;background:#00a1d6;color:#fff;';
      const text = document.createElement('span');
      text.textContent = d.text;
      text.style.cssText = 'flex:1;min-width:0;word-break:break-all;color:#18191c;';
      row.append(time, tag, text);
      frag.prepend(row);
      shown++;
    }
    if (!shown) {
      const empty = document.createElement('div');
      empty.textContent = danmakus.length ? '当前播放位置之前暂无本地弹幕' : '导入的文件中没有弹幕';
      empty.style.cssText = 'padding:10px;text-align:center;';
      frag.appendChild(empty);
    }
    listBody.replaceChildren(frag);
    if (stick) listBody.scrollTop = listBody.scrollHeight;
  }

  function bindVideoEvents() {
    const v = findVideo();
    if (!v || v._ldBound) return;
    v._ldBound = true;
    v.addEventListener('pause', () => setPaused(true));
    v.addEventListener('play', () => setPaused(false));
    v.addEventListener('seeking', () => seekTo(v.currentTime));
    v.addEventListener('emptied', () => {
      clearScreen();
      listKey = '';
    });
    v.addEventListener('timeupdate', syncList);
    v.addEventListener('seeked', syncList);
  }

  async function loadFile(file) {
    const text = await file.text();
    danmakus = parseXml(text);
    listVersion++; // 导入新文件时替换旧列表
    if (listBody) listBody.scrollTop = 0;
    if (!ensureLayer()) return alert('未找到视频播放器');
    bindVideoEvents();
    seekTo(video.currentTime);
    if (!rafId) tick();
    syncList();
    setBtn(`本地弹幕: ${danmakus.length}条`);
  }

  let btn;
  let settingsPanel;
  function setBtn(t) { if (btn) btn.firstChild.textContent = t; }

  function updateSettingsLabels() {
    settingsPanel.querySelectorAll('input[type="range"]').forEach((input) => {
      const output = input.parentElement.querySelector('output');
      const value = settings[input.dataset.setting];
      output.textContent = input.dataset.setting === 'speed'
        ? `${(value / 100).toFixed(1)}x`
        : `${value}%`;
    });
  }

  function addSettingRow(label, key, min, max, step) {
    const row = document.createElement('label');
    row.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:4px 8px;align-items:center;';
    const title = document.createElement('span');
    title.textContent = label;
    const output = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = settings[key];
    input.dataset.setting = key;
    input.style.cssText = 'grid-column:1 / -1;width:100%;margin:0;accent-color:#00a1d6;';
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      applySettings();
    });
    row.append(title, output, input);
    settingsPanel.appendChild(row);
  }

  function createUI() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xml,text/xml';
    input.style.display = 'none';
    input.onchange = () => input.files[0] && loadFile(input.files[0]);

    btn = document.createElement('div');
    btn.style.cssText =
      'position:fixed;right:10px;bottom:80px;z-index:99999;background:#00a1d6;color:#fff;' +
      'padding:6px 10px;border-radius:6px;font-size:13px;cursor:pointer;user-select:none;opacity:.85;';
    const label = document.createElement('span');
    label.textContent = '导入本地弹幕XML';
    label.onclick = () => input.click();
    btn.appendChild(label);

    const toggle = document.createElement('span');
    toggle.textContent = ' [开]';
    toggle.style.marginLeft = '6px';
    toggle.onclick = (e) => {
      e.stopPropagation();
      enabled = !enabled;
      toggle.textContent = enabled ? ' [开]' : ' [关]';
      if (layer) layer.style.visibility = enabled ? 'visible' : 'hidden';
      if (enabled && video) setPaused(video.paused);
      else setPaused(true);
    };
    btn.appendChild(toggle);

    const settingsToggle = document.createElement('span');
    settingsToggle.textContent = ' [设置]';
    settingsToggle.style.marginLeft = '6px';
    settingsPanel = document.createElement('div');
    settingsPanel.style.cssText =
      'display:none;position:fixed;right:10px;bottom:112px;z-index:99999;width:220px;' +
      'padding:12px;background:rgba(20,20,20,.94);color:#fff;border-radius:6px;' +
      'font-size:12px;line-height:1.4;cursor:default;';
    addSettingRow('显示区域', 'displayArea', 25, 100, 25);
    addSettingRow('不透明度', 'opacity', 10, 100, 5);
    addSettingRow('弹幕字号', 'fontScale', 50, 200, 10);
    addSettingRow('弹幕速度', 'speed', 50, 200, 10);
    addSettingToggle('弹幕随屏幕缩放', 'scaleWithScreen');
    const separator = document.createElement('div');
    separator.textContent = '屏蔽弹幕';
    separator.style.cssText = 'margin-top:4px;padding-top:6px;border-top:1px solid #555;';
    settingsPanel.appendChild(separator);
    addSettingToggle('滚动', 'blockScroll');
    addSettingToggle('顶部', 'blockTop');
    addSettingToggle('底部', 'blockBottom');
    addSettingToggle('彩色', 'blockColorful');
    settingsToggle.onclick = (e) => {
      e.stopPropagation();
      settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'grid' : 'none';
    };
    btn.appendChild(settingsToggle);
    document.body.append(input, btn);
    document.body.appendChild(settingsPanel);
    updateSettingsLabels();
  }

  createUI();
  // 切换视频/分P或播放器重建后，重新挂载并同步原生列表中的本地区块，同时重新绑定视频事件
  setInterval(() => {
    if (!listVersion) return;
    bindVideoEvents();
    syncList();
  }, 1000);
})();
