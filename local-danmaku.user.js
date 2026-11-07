// ==UserScript==
// @name         B站本地弹幕XML注入
// @namespace    hinome_no_danmaku
// @version      1.2.2
// @description  读取本地弹幕 XML（录播姬/B站格式），叠加渲染到B站视频播放器上，并与视频进度同步
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/list/*
// @updateURL    https://raw.githubusercontent.com/NieR4ever/hinome_no_danmaku/main/local-danmaku.user.js
// @downloadURL  https://raw.githubusercontent.com/NieR4ever/hinome_no_danmaku/main/local-danmaku.user.js
// @connect      raw.githubusercontent.com
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const SCROLL_TIME = 8; // 滚动弹幕穿越时间(秒)
  const FIXED_TIME = 4;  // 顶部/底部弹幕停留时间(秒)
  const EMOTICONS_URL =
    'https://raw.githubusercontent.com/NieR4ever/hinome_no_danmaku/main/emoticons.json';
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
    blockEmoticonOnly: false,
    offset: 0, // 弹幕偏移(秒)，正数为延后
    uiVisibility: 'always', // always | hover
    uiPosition: 'top-right', // top | top-left | top-right | mid-left | mid-right | list
  };

  let enabled = true;
  const UI_PREFS_KEY = 'local-danmaku-ui';
  try {
    const saved = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}');
    for (const [key, min, max] of [
      ['displayArea', 25, 100],
      ['opacity', 10, 100],
      ['fontScale', 50, 200],
      ['speed', 50, 200],
    ]) {
      if (Number.isFinite(saved[key]) && saved[key] >= min && saved[key] <= max) {
        settings[key] = saved[key];
      }
    }
    for (const key of ['scaleWithScreen', 'blockScroll', 'blockTop', 'blockBottom', 'blockColorful', 'blockEmoticonOnly']) {
      if (typeof saved[key] === 'boolean') settings[key] = saved[key];
    }
    if (['always', 'hover'].includes(saved.uiVisibility)) settings.uiVisibility = saved.uiVisibility;
    if (['top', 'top-left', 'top-right', 'mid-left', 'mid-right', 'list'].includes(saved.uiPosition)) {
      settings.uiPosition = saved.uiPosition;
    }
    if (typeof saved.enabled === 'boolean') enabled = saved.enabled;
  } catch (e) { /* 忽略损坏的配置 */ }
  function saveSettings() {
    try {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ ...settings, offset: undefined, enabled }));
    } catch (e) { /* 忽略存储失败 */ }
  }

  const WORDS_KEY = 'local-danmaku-block-words';
  let blockWords = [];
  try {
    const w = JSON.parse(localStorage.getItem(WORDS_KEY) || '[]');
    if (Array.isArray(w)) blockWords = w.filter((x) => typeof x === 'string');
  } catch (e) { /* 忽略损坏的配置 */ }
  let blockMatchers = [];
  // 每行一个屏蔽词（不区分大小写）；形如 /正则/ 的行按正则匹配
  function compileBlockWords() {
    blockMatchers = [];
    blockWords.forEach((line) => {
      const w = line.trim();
      if (!w) return;
      const m = /^\/(.+)\/([gimsuy]*)$/.exec(w);
      if (m) {
        try {
          const re = new RegExp(m[1], m[2].replace('g', '').replace('y', ''));
          blockMatchers.push((t) => re.test(t));
          return;
        } catch (e) { /* 非法正则按普通文本处理 */ }
      }
      const lower = w.toLowerCase();
      blockMatchers.push((t) => t.toLowerCase().includes(lower));
    });
  }
  function hasBlockedWord(text) {
    return blockMatchers.some((f) => f(text));
  }
  compileBlockWords();

  let danmakus = []; // {t, mode, size, color, text}
  let emoticons = new Map();
  let emoticonsPromise = null;
  let emoticonsLoadHandled = null;
  let layer = null;
  let video = null;
  let idx = 0;
  let importId = 0;
  let lastTime = 0;
  let rafId = 0;
  let lanes = { scroll: [], top: [], bottom: [] };

  function loadEmoticons() {
    if (!emoticonsPromise) {
      emoticonsPromise = new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: EMOTICONS_URL,
          timeout: 15000,
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`HTTP ${response.status}`));
              return;
            }
            try {
              resolve(JSON.parse(response.responseText));
            } catch (error) {
              reject(error);
            }
          },
          onerror: () => reject(new Error('网络请求失败')),
          ontimeout: () => reject(new Error('请求超时')),
        });
      })
        .then((entries) => {
          if (!Array.isArray(entries)) throw new Error('映射文件格式无效');
          const mapping = new Map();
          entries.forEach(({ text, url }) => {
            if (typeof text !== 'string' || !text || typeof url !== 'string') {
              throw new Error('映射条目格式无效');
            }
            const imageUrl = new URL(url);
            if (imageUrl.protocol !== 'https:' || imageUrl.hostname !== 'i0.hdslb.com') {
              throw new Error(`无效的表情图片地址：${url}`);
            }
            const token = text.startsWith('[') && text.endsWith(']') ? text : `[${text}]`;
            if (!mapping.has(token) || text === token) mapping.set(token, imageUrl.href);
          });
          emoticons = mapping;
        })
        .catch((error) => {
          emoticonsPromise = null;
          throw new Error(`加载表情映射失败：${error.message}`);
        });
    }
    return emoticonsPromise;
  }

  function emoticonUrl(token) {
    return emoticons.get(token) ||
      (token.startsWith('[https://i0.hdslb.com/') ? token.slice(1, -1) : null);
  }

  function isEmoticonOnly(text) {
    let start = 0;
    let found = false;
    for (const match of text.matchAll(/\[([^\[\]]+)\]/g)) {
      if (text.slice(start, match.index).trim() || !emoticonUrl(match[0])) return false;
      found = true;
      start = match.index + match[0].length;
    }
    return found && !text.slice(start).trim();
  }

  function appendTextWithEmoticons(container, text) {
    let start = 0;
    for (const match of text.matchAll(/\[([^\[\]]+)\]/g)) {
      const token = match[0];
      const index = match.index;
      const url = emoticonUrl(token);
      if (!url) continue;
      if (index > start) container.appendChild(document.createTextNode(text.slice(start, index)));
      const image = document.createElement('img');
      image.src = url;
      image.alt = token;
      image.title = token;
      image.style.cssText = 'height:1em;width:auto;vertical-align:-0.15em;';
      container.appendChild(image);
      start = index + token.length;
    }
    if (start < text.length) container.appendChild(document.createTextNode(text.slice(start)));
  }

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
          if (isBlocked(el.dataset.danmakuPosition, el.dataset.danmakuColorful === 'true', el.dataset.danmakuText)) {
            el.remove();
          }
        });
      }
      saveSettings();
    });
    const title = document.createElement('span');
    title.textContent = label;
    row.append(input, title);
    settingsPanel.appendChild(row);
  }

  function findVideo() {
    return document.querySelector('.bpx-player-video-wrap video, #bilibiliPlayer video, video');
  }

  // 找到侧栏里“弹幕列表”文字所在的元素
  function findListTitle() {
    const scope = document.querySelector('#danmukuBox, .danmaku-wrap, .bui-collapse-header');
    const root = scope ? (scope.closest('#danmukuBox, .danmaku-wrap') || scope) : null;
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeValue.trim() === '弹幕列表' && !uiRoot.contains(n)) return n.parentElement;
    }
    return null;
  }

  const PLAYER_POS_CSS = {
    top: 'top:10px;left:50%;transform:translateX(-50%);',
    'top-left': 'top:10px;left:10px;',
    'top-right': 'top:10px;right:10px;',
    'mid-left': 'top:50%;left:10px;transform:translateY(-50%);',
    'mid-right': 'top:50%;right:10px;transform:translateY(-50%);',
  };

  function positionUI() {
    if (!uiRoot) return;

    video = findVideo();
    const player = video
      ? video.closest('.bpx-player-container, #bilibiliPlayer, .bpx-player-video-area')
      : document.querySelector('.bpx-player-container, #bilibiliPlayer');
    const title = settings.uiPosition === 'list' ? findListTitle() : null;
    let key;
    let apply;

    if (title && title.parentElement) {
      key = 'list';
      apply = () => {
        uiRoot.style.cssText =
          'position:relative;display:inline-block;vertical-align:middle;margin-right:8px;z-index:2147483000;';
        panelAlign('left');
      };
      if (uiRoot.nextElementSibling !== title || uiRoot.parentElement !== title.parentElement) {
        title.before(uiRoot);
        placedKey = '';
      }
    } else if (player) {
      const pos = PLAYER_POS_CSS[settings.uiPosition] ? settings.uiPosition : 'top-right';
      key = `player:${pos}`;
      apply = () => {
        uiRoot.style.cssText = `position:absolute;z-index:2147483000;${PLAYER_POS_CSS[pos]}`;
        panelAlign(pos.endsWith('right') ? 'right' : 'left');
      };
      if (uiRoot.parentElement !== player) {
        if (getComputedStyle(player).position === 'static') player.style.position = 'relative';
        player.appendChild(uiRoot);
        placedKey = '';
      }
    } else {
      key = 'free';
      apply = () => {
        uiRoot.style.cssText = 'position:relative;z-index:2147483000;margin:8px;';
        panelAlign('left');
      };
    }

    if (key !== placedKey) {
      placedKey = key;
      apply();
      refreshVisibility();
    }
  }

  function panelAlign(side) {
    if (!settingsPanel) return;
    settingsPanel.style.left = side === 'left' ? '0' : side === 'center' ? '50%' : 'auto';
    settingsPanel.style.right = side === 'right' ? '0' : 'auto';
    settingsPanel.style.transform = side === 'center' ? 'translateX(-50%)' : 'none';
  }

  function refreshVisibility() {
    if (!uiRoot) return;
    const locked = placedKey === 'list';
    const show = locked || settings.uiVisibility === 'always' || panelOpen || nearUI || !!notice;
    uiRoot.style.opacity = show ? '1' : '0';
    uiRoot.style.pointerEvents = show ? 'auto' : 'none';
    fitPanel();
    if (visibilitySelect) {
      visibilitySelect.disabled = locked;
      visibilitySelect.value = locked ? 'always' : settings.uiVisibility;
    }
  }

  // 鼠标靠近按钮大致位置时才显示
  function onMouseMove(e) {
    if (settings.uiVisibility === 'always' || !uiRoot || !btn) return;
    const r = btn.getBoundingClientRect();
    const m = 80;
    const near = e.clientX > r.left - m && e.clientX < r.right + m &&
      e.clientY > r.top - m && e.clientY < r.bottom + m;
    if (near !== nearUI) {
      nearUI = near;
      refreshVisibility();
    }
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

  // 应用偏移后的弹幕时间轴
  function danmakuTime() {
    return video.currentTime - settings.offset;
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

  function isBlocked(position, colorful, text) {
    return (settings.blockScroll && position === 'scroll') ||
      (settings.blockTop && position === 'top') ||
      (settings.blockBottom && position === 'bottom') ||
      (settings.blockColorful && colorful) ||
      (settings.blockEmoticonOnly && isEmoticonOnly(text));
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
    appendTextWithEmoticons(el, d.text);
    el.style.cssText =
      `position:absolute;white-space:pre;font-weight:bold;font-family:SimHei,"Microsoft YaHei",sans-serif;` +
      `font-size:${fontSize}px;line-height:${laneH}px;opacity:${settings.opacity / 100};will-change:transform;` +
      `color:#${(d.color & 0xffffff).toString(16).padStart(6, '0')};` +
      'text-shadow:1px 0 1px #000,0 1px 1px #000,0 -1px 1px #000,-1px 0 1px #000;';
    layer.appendChild(el);
    el.dataset.danmakuOpacity = 'true';
    el.dataset.danmakuPosition = d.mode === 5 ? 'top' : d.mode === 4 ? 'bottom' : 'scroll';
    el.dataset.danmakuColorful = String((d.color & 0xffffff) !== 0xffffff);
    el.dataset.danmakuText = d.text;
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
    const t = danmakuTime();
    if (Math.abs(t - lastTime) > 1.5 || t < lastTime - 0.1) seekTo(t);
    if (video.paused) return;
    let count = 0;
    while (idx < danmakus.length && danmakus[idx].t <= t) {
      const d = danmakus[idx];
      const position = d.mode === 5 ? 'top' : d.mode === 4 ? 'bottom' : 'scroll';
      const colorful = (d.color & 0xffffff) !== 0xffffff;
      if (!isBlocked(position, colorful, d.text) && !hasBlockedWord(d.text) && t - d.t < 1.5 && count < 30) {
        emit(d);
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
    v.addEventListener('seeking', () => seekTo(danmakuTime()));
    v.addEventListener('emptied', clearScreen);
  }

  function refreshVisibleEmoticons() {
    if (!layer) return;
    layer.querySelectorAll('[data-danmaku-position]').forEach((el) => {
      const text = el.dataset.danmakuText;
      if (![...text.matchAll(/\[([^\[\]]+)\]/g)].some((match) => emoticons.has(match[0]))) return;
      if (isBlocked(el.dataset.danmakuPosition, el.dataset.danmakuColorful === 'true', text)) {
        el.remove();
        return;
      }
      el.replaceChildren();
      appendTextWithEmoticons(el, text);
      if (el.dataset.danmakuPosition === 'scroll') {
        const animation = el.getAnimations()[0];
        if (animation) {
          animation.effect.setKeyframes([
            { transform: `translateX(${layer.clientWidth}px)` },
            { transform: `translateX(${-el.offsetWidth}px)` },
          ]);
        }
      } else {
        el.style.left = `${(layer.clientWidth - el.offsetWidth) / 2}px`;
      }
    });
  }

  function startEmoticonsLoading() {
    if (emoticonsLoadHandled) return;
    emoticonsLoadHandled = loadEmoticons().then(refreshVisibleEmoticons, (error) => {
      emoticonsLoadHandled = null;
      console.error(error);
      showNotice(`${error.message}，将仅解析图片链接。`);
    });
  }

  async function loadFile(file) {
    const currentImport = ++importId;
    startEmoticonsLoading();
    const text = await file.text();
    if (currentImport !== importId) return;
    danmakus = parseXml(text);
    if (!ensureLayer()) return alert('未找到视频播放器');
    bindVideoEvents();
    seekTo(danmakuTime());
    if (!rafId) tick();
    setBtn(`本地弹幕: ${danmakus.length}条`);
  }

  let uiRoot;
  let btn;
  let btnLabel;
  let settingsPanel;
  let placedKey = '';
  let panelOpen = false;
  let nearUI = false;
  let visibilitySelect;
  let notice = null;
  let noticeTimer = 0;
  function setBtn(t) { if (btnLabel) btnLabel.textContent = t; }

  function positionNotice() {
    if (!notice) return;
    const rootBounds = uiRoot.getBoundingClientRect();
    const anchor = (panelOpen ? settingsPanel : btn).getBoundingClientRect();
    const side = !panelOpen && placedKey === 'player:top'
      ? (window.innerWidth - anchor.right >= 294 || window.innerWidth - anchor.right >= anchor.left ? 'right' : 'left')
      : !panelOpen && ['player:top-left', 'player:mid-left'].includes(placedKey) ? 'right'
      : !panelOpen && ['player:top-right', 'player:mid-right'].includes(placedKey) ? 'left'
        : null;
    const availableWidth = side === 'right' ? window.innerWidth - anchor.right - 14
      : side === 'left' ? anchor.left - 14 : window.innerWidth - 16;
    const width = panelOpen ? anchor.width : Math.min(280, Math.max(0, availableWidth));
    const left = side === 'right' ? anchor.right + 6
      : side === 'left' ? anchor.left - width - 6
        : Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    notice.style.width = `${width}px`;
    notice.style.left = `${left - rootBounds.left}px`;
    const noticeTop = placedKey === 'player:top'
      ? (anchor.top + anchor.bottom - notice.offsetHeight) / 2 : anchor.top;
    const top = panelOpen ? anchor.top : side
      ? Math.max(8, Math.min(noticeTop, window.innerHeight - notice.offsetHeight - 8))
      : anchor.bottom + 6;
    notice.style.top = `${top - rootBounds.top}px`;
  }

  function closeNotice() {
    clearTimeout(noticeTimer);
    if (!notice) return;
    notice.remove();
    notice = null;
    refreshVisibility();
  }

  function showNotice(message) {
    closeNotice();
    notice = document.createElement('div');
    notice.setAttribute('role', 'alert');
    notice.style.cssText =
      'position:absolute;z-index:2147483002;box-sizing:border-box;overflow:hidden;' +
      'padding:9px 30px 12px 10px;background:#333;color:#fff;border-radius:6px;' +
      'font-size:12px;line-height:1.4;text-align:left;white-space:normal;overflow-wrap:anywhere;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:auto;';
    const text = document.createElement('span');
    text.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭提示');
    close.textContent = '×';
    close.style.cssText =
      'position:absolute;top:3px;right:5px;border:0;background:transparent;color:inherit;' +
      'font-size:18px;line-height:20px;cursor:pointer;';
    close.onclick = closeNotice;
    const progress = document.createElement('div');
    progress.style.cssText =
      'position:absolute;bottom:0;left:0;width:100%;height:3px;background:#00a1d6;transform-origin:left;';
    notice.append(text, close, progress);
    uiRoot.appendChild(notice);
    refreshVisibility();
    positionNotice();
    progress.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], {
      duration: 2000, easing: 'linear', fill: 'forwards',
    });
    noticeTimer = setTimeout(closeNotice, 2000);
  }

  function addSelectRow(label, key, options) {
    const row = document.createElement('label');
    row.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:center;';
    const title = document.createElement('span');
    title.textContent = label;
    const select = document.createElement('select');
    select.style.cssText = 'min-width:0;background:#333;color:#fff;border:1px solid #666;border-radius:4px;padding:2px;';
    options.forEach(([value, text]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      select.appendChild(opt);
    });
    select.value = settings[key];
    if (key === 'uiVisibility') visibilitySelect = select;
    select.addEventListener('change', () => {
      settings[key] = select.value;
      saveSettings();
      placedKey = '';
      nearUI = true;
      positionUI();
      refreshVisibility();
    });
    row.append(title, select);
    settingsPanel.appendChild(row);
  }

  function updateSettingsLabels() {
    settingsPanel.querySelectorAll('input[type="range"][data-setting]').forEach((input) => {
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
      saveSettings();
    });
    row.append(title, output, input);
    settingsPanel.appendChild(row);
  }

  // 限制面板高度，使其不超出播放器（或视口）下沿，超出部分在面板内滚动
  function fitPanel() {
    if (!panelOpen) {
      positionNotice();
      return;
    }
    const host = uiRoot.parentElement;
    const inPlayer = host && placedKey.startsWith('player');
    if (placedKey === 'list') {
      const buttonBounds = btn.getBoundingClientRect();
      const rootBounds = uiRoot.getBoundingClientRect();
      const panelWidth = settingsPanel.offsetWidth;
      const left = Math.max(8, Math.min(
        buttonBounds.left,
        window.innerWidth - panelWidth - 8
      ));
      const top = buttonBounds.bottom + 6;
      settingsPanel.style.left = `${left - rootBounds.left}px`;
      settingsPanel.style.right = 'auto';
      settingsPanel.style.top = `${top - rootBounds.top}px`;
      settingsPanel.style.transform = 'none';
      settingsPanel.style.maxHeight =
        `${Math.max(0, window.innerHeight - Math.max(8, top) - 8)}px`;
      positionNotice();
      return;
    }
    if (inPlayer && (placedKey.startsWith('player:mid-') || placedKey === 'player:top')) {
      const bounds = host.getBoundingClientRect();
      const buttonBounds = btn.getBoundingClientRect();
      const panelWidth = settingsPanel.offsetWidth;
      const minLeft = Math.max(8, bounds.left + 8);
      const maxLeft = Math.min(window.innerWidth - panelWidth - 8, bounds.right - panelWidth - 8);
      const gap = 6;
      const preferRight = placedKey !== 'player:mid-right';
      const rightSideLeft = buttonBounds.right + gap;
      const leftSideLeft = buttonBounds.left - panelWidth - gap;
      const fitsRight = rightSideLeft <= maxLeft;
      const fitsLeft = leftSideLeft >= minLeft;
      const left = preferRight && fitsRight
        ? rightSideLeft
        : !preferRight && fitsLeft
          ? leftSideLeft
          : fitsRight
            ? rightSideLeft
            : Math.max(minLeft, Math.min(leftSideLeft, maxLeft));
      const atTop = placedKey === 'player:top';
      const minTop = atTop ? 8 : Math.max(8, bounds.top + 8);
      const maxBottom = atTop ? window.innerHeight - 8 : Math.min(window.innerHeight - 8, bounds.bottom - 8);
      settingsPanel.style.maxHeight = `${Math.max(0, maxBottom - minTop)}px`;
      const panelHeight = settingsPanel.offsetHeight;
      const top = Math.max(minTop, Math.min(
        buttonBounds.top + buttonBounds.height / 2 - panelHeight / 2,
        maxBottom - panelHeight
      ));
      const rootBounds = uiRoot.getBoundingClientRect();
      settingsPanel.style.left = `${left - rootBounds.left}px`;
      settingsPanel.style.right = 'auto';
      settingsPanel.style.top = `${top - rootBounds.top}px`;
      settingsPanel.style.transform = 'none';
      positionNotice();
      return;
    }
    const limit = inPlayer ? host.getBoundingClientRect().bottom : window.innerHeight;
    settingsPanel.style.top = 'calc(100% + 6px)';
    const top = settingsPanel.getBoundingClientRect().top;
    settingsPanel.style.maxHeight = `${Math.max(120, Math.min(limit, window.innerHeight) - top - 8)}px`;
    positionNotice();
  }

  function openPanel() {
    panelOpen = true;
    settingsPanel.style.display = 'grid';
    fitPanel();
    refreshVisibility();
  }

  let showMainMenu = () => {};

  function closePanel() {
    showMainMenu();
    panelOpen = false;
    settingsPanel.style.display = 'none';
    refreshVisibility();
  }

  function addOffsetRow() {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:4px 8px;align-items:center;';
    const title = document.createElement('span');
    title.textContent = '弹幕偏移';
    const help = document.createElement('span');
    help.textContent = '?';
    help.title = '滑块可在 -5 到 5 秒之间调节；需要更大偏移时，在右侧文本框输入秒数后按回车或点击别处。' +
      '正数表示弹幕延后出现，负数表示提前出现，例如输入 30 或 -12.5。';
    help.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;' +
      'margin-left:4px;border:1px solid #aaa;border-radius:50%;font-size:10px;cursor:help;';
    title.appendChild(help);
    const box = document.createElement('span');
    box.style.cssText = 'display:flex;align-items:center;gap:2px;';
    const text = document.createElement('input');
    text.type = 'text';
    text.inputMode = 'decimal';
    text.style.cssText =
      'width:52px;background:#333;color:#fff;border:1px solid #666;border-radius:4px;padding:1px 3px;text-align:right;';
    const unit = document.createElement('span');
    unit.textContent = 's';
    box.append(text, unit);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = -5;
    slider.max = 5;
    slider.step = 0.1;
    slider.style.cssText = 'grid-column:1 / -1;width:100%;margin:0;accent-color:#00a1d6;';
    const sync = () => {
      text.value = String(Math.round(settings.offset * 100) / 100);
      slider.value = Math.max(-5, Math.min(5, settings.offset));
    };
    const apply = (v) => {
      if (!Number.isFinite(v)) return sync();
      settings.offset = v;
      sync();
      if (video && danmakus.length) seekTo(danmakuTime());
    };
    slider.addEventListener('input', () => apply(Number(slider.value)));
    text.addEventListener('change', () => apply(parseFloat(text.value)));
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter') text.blur(); });
    sync();
    row.append(title, box, slider);
    settingsPanel.appendChild(row);
  }

  // 二级菜单：把主面板内容收进 mainView，屏蔽词编辑放到 subView
  function buildBlockWordsMenu() {
    const mainView = document.createElement('div');
    mainView.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr);gap:6px;';
    while (settingsPanel.firstChild) mainView.appendChild(settingsPanel.firstChild);

    const entry = document.createElement('div');
    entry.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;cursor:pointer;' +
      'margin-top:4px;padding-top:6px;border-top:1px solid #555;';
    const entryCount = document.createElement('span');
    const entryTitle = document.createElement('span');
    entryTitle.textContent = '屏蔽词';
    const arrow = document.createElement('span');
    arrow.append(entryCount, ' ›');
    entry.append(entryTitle, arrow);
    const updateCount = () => {
      const n = blockWords.filter((x) => x.trim()).length;
      entryCount.textContent = n ? `${n}个` : '';
    };
    updateCount();
    mainView.appendChild(entry);

    const subView = document.createElement('div');
    subView.style.cssText = 'display:none;grid-template-columns:minmax(0,1fr);gap:6px;min-width:0;';
    const back = document.createElement('div');
    back.textContent = '‹ 屏蔽词';
    back.style.cssText = 'cursor:pointer;color:#00a1d6;';
    const hint = document.createElement('div');
    hint.textContent = '每行一个屏蔽词，不区分大小写；/正则/ 形式按正则匹配。点击“应用”后生效并保存。';
    hint.style.cssText = 'color:#aaa;white-space:normal;overflow-wrap:anywhere;word-break:break-word;min-width:0;';
    const area = document.createElement('textarea');
    area.value = blockWords.join('\n');
    area.rows = 8;
    area.spellcheck = false;
    area.style.cssText =
      'display:block;width:100%;min-width:0;max-width:100%;box-sizing:border-box;resize:vertical;background:#333;color:#fff;' +
      'border:1px solid #666;border-radius:4px;padding:4px;font-size:12px;';
    const apply = () => {
      blockWords = area.value.split('\n').map((x) => x.trim()).filter(Boolean);
      try { localStorage.setItem(WORDS_KEY, JSON.stringify(blockWords)); } catch (e) { /* 忽略存储失败 */ }
      compileBlockWords();
      updateCount();
      if (layer) {
        Array.from(layer.children).forEach((el) => {
          if (hasBlockedWord(el.dataset.danmakuText)) el.remove();
        });
      }
    };
    const applyBtn = document.createElement('div');
    applyBtn.textContent = '应用';
    applyBtn.style.cssText =
      'justify-self:end;padding:3px 16px;background:#00a1d6;color:#fff;border-radius:4px;' +
      'cursor:pointer;user-select:none;';
    applyBtn.onclick = () => {
      apply();
      applyBtn.textContent = '已应用';
      setTimeout(() => { applyBtn.textContent = '应用'; }, 1000);
    };
    subView.append(back, hint, area, applyBtn);

    const show = (sub) => {
      mainView.style.display = sub ? 'none' : 'grid';
      subView.style.display = sub ? 'grid' : 'none';
      fitPanel();
    };
    showMainMenu = () => {
      area.value = blockWords.join('\n'); // 未应用的修改不保留
      show(false);
    };
    entry.onclick = () => show(true);
    back.onclick = () => showMainMenu();
    settingsPanel.append(mainView, subView);
  }

  function createUI() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xml,text/xml';
    input.style.display = 'none';
    input.onchange = async () => {
      if (!input.files[0]) return;
      try {
        await loadFile(input.files[0]);
      } catch (error) {
        console.error(error);
        alert(error.message);
      }
    };

    uiRoot = document.createElement('div');
    uiRoot.id = 'local-danmaku-controls';
    uiRoot.style.cssText = 'position:relative;z-index:2147483000;margin:8px;pointer-events:auto;';

    // 圆角方形图标按钮：点击展开/收起面板
    btn = document.createElement('div');
    btn.title = '本地弹幕';
    btn.style.cssText =
      'display:flex;align-items:center;justify-content:center;width:28px;height:28px;' +
      'box-sizing:border-box;background:#00a1d6;color:#fff;border-radius:6px;cursor:pointer;' +
      'user-select:none;box-shadow:0 1px 4px rgba(0,0,0,.4);';
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
      '<path d="M8 9h8M8 13h5"/></svg>';
    btn.onclick = () => (panelOpen ? closePanel() : openPanel());

    settingsPanel = document.createElement('div');
    settingsPanel.style.cssText =
      'display:none;gap:6px;position:absolute;top:calc(100% + 6px);z-index:2147483001;width:220px;' +
      'max-height:70vh;overflow:auto;overscroll-behavior:contain;box-sizing:border-box;padding:12px;pointer-events:auto;' +
      'background:rgba(20,20,20,.94);color:#fff;border-radius:6px;' +
      'font-size:12px;line-height:1.4;cursor:default;text-align:left;white-space:normal;';

    const info = document.createElement('div');
    info.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';
    btnLabel = document.createElement('span');
    btnLabel.textContent = '未导入本地弹幕';
    const importBtn = document.createElement('span');
    importBtn.textContent = '导入XML';
    importBtn.style.cssText = 'cursor:pointer;color:#00a1d6;white-space:nowrap;';
    importBtn.onclick = () => input.click();
    info.append(btnLabel, importBtn);
    settingsPanel.appendChild(info);

    const enableRow = document.createElement('label');
    enableRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const enableBox = document.createElement('input');
    enableBox.type = 'checkbox';
    enableBox.checked = enabled;
    enableBox.addEventListener('change', () => {
      enabled = enableBox.checked;
      saveSettings();
      if (layer) layer.style.visibility = enabled ? 'visible' : 'hidden';
      if (enabled && video) setPaused(video.paused);
      else setPaused(true);
    });
    const enableText = document.createElement('span');
    enableText.textContent = '显示本地弹幕';
    enableRow.append(enableBox, enableText);
    settingsPanel.appendChild(enableRow);

    addSelectRow('按钮显示', 'uiVisibility', [['always', '始终显示'], ['hover', '鼠标靠近显示']]);
    addSelectRow('按钮位置', 'uiPosition', [
      ['top', '播放器上方'],
      ['top-left', '播放器左上'],
      ['top-right', '播放器右上'],
      ['mid-left', '播放器左中'],
      ['mid-right', '播放器右中'],
      ['list', '弹幕列表左边'],
    ]);
    const separator0 = document.createElement('div');
    separator0.style.cssText = 'border-top:1px solid #555;';
    settingsPanel.appendChild(separator0);
    addOffsetRow();
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
    addSettingToggle('纯表情', 'blockEmoticonOnly');
    buildBlockWordsMenu();
    // 面板上的滚轮只滚动面板本身，不影响页面和播放器音量
    settingsPanel.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      settingsPanel.scrollTop += e.deltaY;
    }, { passive: false });
    window.addEventListener('resize', fitPanel);
    document.addEventListener('mousedown', (e) => {
      if (panelOpen && !uiRoot.contains(e.target)) closePanel();
    }, true);
    // 避免点击/按键冒泡到播放器触发暂停或快捷键
    ['click', 'dblclick', 'mousedown', 'keydown', 'keyup'].forEach((type) => {
      uiRoot.addEventListener(type, (e) => e.stopPropagation());
    });
    ['mousemove', 'mouseover', 'pointermove', 'pointerover'].forEach((type) => {
      settingsPanel.addEventListener(type, (e) => e.stopPropagation());
    });

    uiRoot.append(input, btn, settingsPanel);
    document.body.appendChild(uiRoot);
    positionUI();
    updateSettingsLabels();
    document.addEventListener('mousemove', onMouseMove, { passive: true });

    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        positionUI();
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  createUI();
})();
