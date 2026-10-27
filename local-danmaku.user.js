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
    offset: 0, // 弹幕偏移(秒)，正数为延后
    uiVisibility: 'always', // always | hover
    uiPosition: 'top-right', // top | top-left | top-right | mid-left | mid-right | list
  };

  const UI_PREFS_KEY = 'local-danmaku-ui';
  try {
    const saved = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}');
    if (['always', 'hover'].includes(saved.uiVisibility)) settings.uiVisibility = saved.uiVisibility;
    if (typeof saved.uiPosition === 'string') settings.uiPosition = saved.uiPosition;
  } catch (e) { /* 忽略损坏的配置 */ }
  function saveUiPrefs() {
    try {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({
        uiVisibility: settings.uiVisibility,
        uiPosition: settings.uiPosition,
      }));
    } catch (e) { /* 忽略存储失败 */ }
  }

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
          'position:relative;display:inline-block;vertical-align:middle;margin-right:8px;z-index:80;';
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
        uiRoot.style.cssText = `position:absolute;z-index:80;${PLAYER_POS_CSS[pos]}`;
        panelAlign(pos === 'top' ? 'center' : pos.endsWith('left') ? 'left' : 'right');
      };
      if (uiRoot.parentElement !== player) {
        if (getComputedStyle(player).position === 'static') player.style.position = 'relative';
        player.appendChild(uiRoot);
        placedKey = '';
      }
    } else {
      key = 'free';
      apply = () => {
        uiRoot.style.cssText = 'position:relative;z-index:80;margin:8px;';
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
    const show = locked || settings.uiVisibility === 'always' || panelOpen || nearUI;
    uiRoot.style.opacity = show ? '1' : '0';
    uiRoot.style.pointerEvents = show ? 'auto' : 'none';
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
    const t = danmakuTime();
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

  function bindVideoEvents() {
    const v = findVideo();
    if (!v || v._ldBound) return;
    v._ldBound = true;
    v.addEventListener('pause', () => setPaused(true));
    v.addEventListener('play', () => setPaused(false));
    v.addEventListener('seeking', () => seekTo(danmakuTime()));
    v.addEventListener('emptied', clearScreen);
  }

  async function loadFile(file) {
    const text = await file.text();
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
  function setBtn(t) { if (btnLabel) btnLabel.textContent = t; }

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
      saveUiPrefs();
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
    });
    row.append(title, output, input);
    settingsPanel.appendChild(row);
  }

  function openPanel() {
    panelOpen = true;
    settingsPanel.style.display = 'grid';
    refreshVisibility();
  }

  function closePanel() {
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

  function createUI() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xml,text/xml';
    input.style.display = 'none';
    input.onchange = () => input.files[0] && loadFile(input.files[0]);

    uiRoot = document.createElement('div');
    uiRoot.id = 'local-danmaku-controls';
    uiRoot.style.cssText = 'position:relative;z-index:80;margin:8px;pointer-events:auto;';

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
      'display:none;gap:6px;position:absolute;top:calc(100% + 6px);z-index:81;width:220px;' +
      'max-height:70vh;overflow:auto;overscroll-behavior:contain;box-sizing:border-box;padding:12px;' +
      'background:rgba(20,20,20,.94);color:#fff;border-radius:6px;' +
      'font-size:12px;line-height:1.4;cursor:default;text-align:left;';

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
    // 面板上的滚轮只滚动面板本身，不影响页面和播放器音量
    settingsPanel.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      settingsPanel.scrollTop += e.deltaY;
    }, { passive: false });
    document.addEventListener('mousedown', (e) => {
      if (panelOpen && !uiRoot.contains(e.target)) closePanel();
    }, true);
    // 避免点击/按键冒泡到播放器触发暂停或快捷键
    ['click', 'dblclick', 'mousedown', 'keydown', 'keyup'].forEach((type) => {
      uiRoot.addEventListener(type, (e) => e.stopPropagation());
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
