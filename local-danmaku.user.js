// ==UserScript==
// @name         B站本地弹幕XML注入
// @namespace    hinome_no_danmaku
// @version      1.0.0
// @description  读取本地弹幕 XML（录播姬/B站格式），叠加渲染到B站视频播放器上，并与视频进度同步
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
  const FONT_SCALE = 1;
  const OPACITY = 0.9;

  let danmakus = []; // {t, mode, size, color, text}
  let layer = null;
  let video = null;
  let idx = 0;
  let enabled = true;
  let lastTime = 0;
  let rafId = 0;
  let lanes = { scroll: [], top: [], bottom: [] };

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const list = [];
    doc.querySelectorAll('d').forEach((el) => {
      const p = (el.getAttribute('p') || '').split(',');
      const t = parseFloat(p[0]);
      if (isNaN(t)) return;
      list.push({
        t,
        mode: parseInt(p[1], 10) || 1,
        size: parseInt(p[2], 10) || 25,
        color: parseInt(p[3], 10) || 0xffffff,
        text: el.textContent,
      });
    });
    list.sort((a, b) => a.t - b.t);
    return list;
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
      'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:50;';
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(layer);
    return true;
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

  function emit(d) {
    const w = layer.clientWidth;
    const h = layer.clientHeight;
    if (!w || !h) return;
    const fontSize = Math.max(12, Math.round(d.size * FONT_SCALE * (h / 600 > 1 ? h / 600 : 1) * 0.8 + 6));
    const laneH = fontSize + 4;
    const maxLanes = Math.max(1, Math.floor((h * 0.8) / laneH));
    const now = performance.now() / 1000;

    const el = document.createElement('div');
    el.textContent = d.text;
    el.style.cssText =
      `position:absolute;white-space:pre;font-weight:bold;font-family:SimHei,"Microsoft YaHei",sans-serif;` +
      `font-size:${fontSize}px;line-height:${laneH}px;opacity:${OPACITY};will-change:transform;` +
      `color:#${(d.color & 0xffffff).toString(16).padStart(6, '0')};` +
      'text-shadow:1px 0 1px #000,0 1px 1px #000,0 -1px 1px #000,-1px 0 1px #000;';
    layer.appendChild(el);
    const tw = el.offsetWidth;

    if (d.mode === 4 || d.mode === 5) {
      const key = d.mode === 5 ? 'top' : 'bottom';
      const lane = pickLane(lanes[key], now, laneH, maxLanes, now + FIXED_TIME);
      if (lane < 0) return el.remove();
      el.style.left = `${(w - tw) / 2}px`;
      if (key === 'top') el.style.top = `${lane * laneH}px`;
      else el.style.bottom = `${lane * laneH}px`;
      setTimeout(() => el.remove(), FIXED_TIME * 1000);
      el._fixed = { born: now };
      return;
    }

    // 滚动弹幕：按进入屏幕所需时间占用车道，避免重叠
    const speed = (w + tw) / SCROLL_TIME;
    const clearTime = now + tw / speed + 0.3;
    const lane = pickLane(lanes.scroll, now, laneH, maxLanes, clearTime);
    if (lane < 0) return el.remove();
    el.style.top = `${lane * laneH}px`;
    el.style.left = '0';
    const anim = el.animate(
      [{ transform: `translateX(${w}px)` }, { transform: `translateX(${-tw}px)` }],
      { duration: SCROLL_TIME * 1000, easing: 'linear', fill: 'forwards' }
    );
    anim.onfinish = () => el.remove();
    if (video.paused) anim.pause();
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
      if (t - danmakus[idx].t < 1.5 && count < 30) {
        emit(danmakus[idx]);
        count++;
      }
      idx++;
    }
    lastTime = t;
  }

  function bindVideoEvents() {
    const v = findVideo();
    if (!v || v._ldBound) return;
    v._ldBound = true;
    v.addEventListener('pause', () => setPaused(true));
    v.addEventListener('play', () => setPaused(false));
    v.addEventListener('seeking', () => seekTo(v.currentTime));
    v.addEventListener('emptied', clearScreen);
  }

  async function loadFile(file) {
    const text = await file.text();
    danmakus = parseXml(text);
    if (!ensureLayer()) return alert('未找到视频播放器');
    bindVideoEvents();
    seekTo(video.currentTime);
    if (!rafId) tick();
    setBtn(`本地弹幕: ${danmakus.length}条`);
  }

  let btn;
  function setBtn(t) { if (btn) btn.firstChild.textContent = t; }

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
      if (layer) layer.style.display = enabled ? '' : 'none';
      if (enabled && video) seekTo(video.currentTime);
    };
    btn.appendChild(toggle);
    document.body.append(input, btn);
  }

  createUI();
})();
