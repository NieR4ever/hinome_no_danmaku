// ==UserScript==
// @name         B站本地弹幕XML注入（原生弹幕引擎）
// @namespace    hinome_no_danmaku_inject
// @version      2.0.0
// @description  读取本地弹幕 XML（录播姬/B站格式），通过播放器自身的弹幕引擎 addList 接口加入，由B站原生系统负责渲染、屏蔽与设置；不拦截任何网络请求
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @grant        none
// @sandbox      MAIN
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DB_NAME = 'local-danmaku-inject';
  const STORE = 'files';
  const SUPPORTED_MODES = new Set([1, 4, 5, 6]); // 滚动/底部/顶部/逆向；高级弹幕(7+)需要特殊数据，跳过
  const ID_BASE = 9000000000000000000n; // 避免与平台弹幕 id 冲突
  const CHUNK = 500;

  let list = []; // 已转换为播放器弹幕数据格式
  let skipped = 0;
  let engine = null;
  let status = '导入本地弹幕XML';
  let injecting = false;

  // ---------- 解析 ----------
  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const out = [];
    let skip = 0;
    doc.querySelectorAll('d').forEach((el) => {
      const p = (el.getAttribute('p') || '').split(',');
      const stime = parseFloat(p[0]);
      const mode = parseInt(p[1], 10) || 1;
      if (isNaN(stime)) return;
      if (!SUPPORTED_MODES.has(mode)) {
        skip++;
        return;
      }
      const color = parseInt(p[3], 10);
      out.push({
        stime,
        mode,
        size: parseInt(p[2], 10) || 25,
        color: Number.isNaN(color) ? 0xffffff : color & 0xffffff,
        date: parseInt(p[4], 10) || 0,
        pool: parseInt(p[5], 10) || 0,
        text: el.textContent,
      });
    });
    out.sort((a, b) => a.stime - b.stime);
    return { list: out, skipped: skip };
  }

  // 字段与播放器渲染时使用的 textData 一致
  function toPlayerItem(d, i) {
    const id = String(ID_BASE + BigInt(i));
    return {
      stime: d.stime,
      mode: d.mode,
      rawMode: d.mode,
      size: d.size,
      color: d.color,
      text: d.text,
      date: d.date,
      weight: 11, // 高权重，避免被“弹幕密度”过滤
      pool: d.pool,
      dmid: id,
      id_str: id,
      uhash: 'local',
      uname: '',
      attr: 0,
      dmFrom: 0,
      likes: undefined,
      border: false,
      isHighLike: false,
      isMine: false,
      prefix: null,
      suffix: null,
      on: true,
    };
  }

  // ---------- 与播放器引擎对接 ----------
  function getEngine() {
    try {
      const dx = window.player && window.player.danmaku && window.player.danmaku.getDanmakuX();
      return dx && typeof dx.addList === 'function' ? dx : null;
    } catch (e) {
      return null;
    }
  }

  function hasId(dx, id) {
    const map = dx.manager && dx.manager.dmidMap;
    if (!map) return null; // 无法验证
    return map instanceof Map ? map.has(id) : id in map;
  }

  function isInjected(dx) {
    if (!list.length) return true;
    return hasId(dx, list[0].dmid) !== false && dx.__ldInjected === list;
  }

  function inject(dx) {
    if (injecting) return;
    injecting = true;
    try {
      const items = list.map(toPlayerItem);
      for (let i = 0; i < items.length; i += CHUNK) dx.addList(items.slice(i, i + CHUNK));
      dx.__ldInjected = list;
      const verified = hasId(dx, items[0] && items[0].dmid);
      status = verified === false
        ? '本地弹幕: 已调用注入但引擎未登记，可能接口已变化'
        : `本地弹幕: 已交给B站弹幕引擎 ${items.length}条${skipped ? `（跳过高级弹幕${skipped}条）` : ''}`;
      console.info('[本地弹幕] 已通过 addList 注入', items.length, '条，登记检查:', verified);
    } catch (e) {
      status = '本地弹幕: 注入失败，见控制台';
      console.warn('[本地弹幕] addList 注入失败', e);
    } finally {
      injecting = false;
    }
  }

  // 切换视频/分P后引擎会重建或清空；每秒检查一次，缺失时补注入
  function tick() {
    if (!list.length) return;
    const dx = getEngine();
    if (!dx) {
      status = '本地弹幕: 等待播放器弹幕引擎';
      return;
    }
    if (dx !== engine || !isInjected(dx)) {
      engine = dx;
      inject(dx);
    }
  }

  // ---------- 持久化 ----------
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbOp(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  function setData(parsed) {
    list = parsed.list;
    skipped = parsed.skipped;
    list.forEach((d, i) => (d.dmid = String(ID_BASE + BigInt(i))));
    engine = null;
    status = list.length ? `本地弹幕: ${list.length}条，等待注入` : '导入本地弹幕XML';
  }

  // ---------- 导入入口 ----------
  function createUI() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xml,text/xml';
    input.style.display = 'none';

    const btn = document.createElement('div');
    btn.style.cssText =
      'position:fixed;right:10px;bottom:80px;z-index:99999;background:#00a1d6;color:#fff;' +
      'padding:6px 10px;border-radius:6px;font-size:13px;cursor:pointer;user-select:none;opacity:.85;';
    const label = document.createElement('span');
    label.onclick = () => input.click();
    const clear = document.createElement('span');
    clear.textContent = ' [清除]';
    clear.style.marginLeft = '6px';
    clear.onclick = async (e) => {
      e.stopPropagation();
      await dbOp('readwrite', (s) => s.delete('current'));
      location.reload(); // 原生引擎不提供按条移除的公开接口，刷新页面最稳妥
    };
    btn.append(label, clear);

    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const parsed = parseXml(await file.text());
      await dbOp('readwrite', (s) => s.put({ name: file.name, ...parsed }, 'current'));
      if (engine) {
        location.reload(); // 已注入过旧文件时刷新，避免新旧弹幕叠加
        return;
      }
      setData(parsed);
    };

    document.body.append(input, btn);
    setInterval(() => {
      tick();
      label.textContent = status;
    }, 1000);
    label.textContent = status;
  }

  async function init() {
    try {
      const saved = await dbOp('readonly', (s) => s.get('current'));
      if (saved && Array.isArray(saved.list)) setData(saved);
    } catch (e) {
      // 无法读取时保持空列表
    }
    createUI();
  }

  console.info('[本地弹幕] 脚本已启动（原生引擎模式）');
  init();
})();
