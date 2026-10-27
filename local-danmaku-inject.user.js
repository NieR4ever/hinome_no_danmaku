// ==UserScript==
// @name         B站本地弹幕XML注入（原生弹幕系统）
// @namespace    hinome_no_danmaku_inject
// @version      1.0.0
// @description  读取本地弹幕 XML（录播姬/B站格式），合并进B站弹幕分段响应，由B站原生弹幕渲染、弹幕列表、屏蔽与设置接管
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const SEG_MS = 360000; // 弹幕分段长度（6分钟）
  const SEG_RE = /\/x\/v2\/dm\/(?:wbi\/)?web\/seg\.so/;
  const DB_NAME = 'local-danmaku-inject';
  const STORE = 'files';

  let danmakus = []; // {t(ms), mode, size, color, ctime, pool, text}
  let loaded = false;
  const stats = { seen: 0, merged: 0, added: 0, incompatible: 0, error: '' };
  const ready = loadSaved();

  // ---------- 解析 ----------
  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const list = [];
    doc.querySelectorAll('d').forEach((el) => {
      const p = (el.getAttribute('p') || '').split(',');
      const t = parseFloat(p[0]);
      if (isNaN(t)) return;
      const color = parseInt(p[3], 10);
      list.push({
        t: Math.round(t * 1000),
        mode: parseInt(p[1], 10) || 1,
        size: parseInt(p[2], 10) || 25,
        color: Number.isNaN(color) ? 0xffffff : color,
        ctime: parseInt(p[4], 10) || 0,
        pool: parseInt(p[5], 10) || 0,
        text: el.textContent,
      });
    });
    list.sort((a, b) => a.t - b.t);
    return list;
  }

  // ---------- protobuf 编码（DanmakuElem，作为 DmSegMobileReply.elems 追加） ----------
  const enc = new TextEncoder();

  function varint(out, value) {
    let v = BigInt(value);
    if (v < 0n) v += 1n << 64n;
    while (v > 0x7fn) {
      out.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    out.push(Number(v));
  }

  function putVarintField(out, field, value) {
    varint(out, field << 3);
    varint(out, value);
  }

  function putStringField(out, field, str) {
    const bytes = enc.encode(str);
    varint(out, (field << 3) | 2);
    varint(out, bytes.length);
    for (const b of bytes) out.push(b);
  }

  function encodeElem(d, i) {
    const body = [];
    const id = 9000000000000000000n + BigInt(i); // 避免与平台弹幕 id 冲突
    putVarintField(body, 1, id);
    putVarintField(body, 2, d.t);
    putVarintField(body, 3, d.mode);
    putVarintField(body, 4, d.size);
    putVarintField(body, 5, d.color & 0xffffff);
    putStringField(body, 6, 'local');
    putStringField(body, 7, d.text);
    putVarintField(body, 8, d.ctime);
    putVarintField(body, 9, 11); // 高权重，避免被“弹幕密度”过滤掉
    putVarintField(body, 11, d.pool);
    putStringField(body, 12, String(id));
    const out = [];
    varint(out, (1 << 3) | 2);
    varint(out, body.length);
    for (const b of body) out.push(b);
    return out;
  }

  function lowerBound(t) {
    let lo = 0, hi = danmakus.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (danmakus[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // 最小 wire 格式扫描：只检查响应是否为结构完整的 protobuf，且弹幕条目(字段1)含
  // progress(2)/content(7)；不符合预期时返回 ok:false，脚本不改动响应，避免弄坏原生弹幕
  function readVarint(bytes, pos) {
    let result = 0, shift = 0;
    for (let i = 0; i < 10; i++) {
      if (pos >= bytes.length) return null;
      const b = bytes[pos++];
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return [result, pos];
      shift += 7;
    }
    return null;
  }

  function scanFields(bytes, start, end, onField) {
    let pos = start;
    while (pos < end) {
      const tag = readVarint(bytes, pos);
      if (!tag) return false;
      pos = tag[1];
      const field = Math.floor(tag[0] / 8);
      const wire = tag[0] % 8;
      let valueStart = pos;
      if (wire === 0) {
        const v = readVarint(bytes, pos);
        if (!v) return false;
        pos = v[1];
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 5) {
        pos += 4;
      } else if (wire === 2) {
        const len = readVarint(bytes, pos);
        if (!len) return false;
        valueStart = len[1];
        pos = valueStart + len[0];
      } else {
        return false;
      }
      if (pos > end) return false;
      if (onField) onField(field, wire, valueStart, pos);
    }
    return pos === end;
  }

  function checkReply(bytes) {
    let elemCount = 0;
    let schemaOk = true;
    const ok = scanFields(bytes, 0, bytes.length, (field, wire, s, e) => {
      if (field !== 1 || wire !== 2) return;
      elemCount++;
      if (elemCount > 3) return; // 抽样检查前几条
      const seen = new Set();
      const inner = scanFields(bytes, s, e, (f) => seen.add(f));
      if (!inner || !seen.has(2) || !seen.has(7)) schemaOk = false;
    });
    return { ok: ok && schemaOk, elemCount };
  }

  // 仅追加到响应末尾：protobuf 中重复字段可直接拼接，无需解码平台数据
  function merge(buffer, url) {
    stats.seen++;
    let seg;
    try {
      seg = parseInt(new URL(url, location.href).searchParams.get('segment_index'), 10);
    } catch (e) {
      stats.error = '无法解析分段参数';
      return buffer;
    }
    if (!seg || seg < 1 || !danmakus.length) return buffer;
    const orig = new Uint8Array(buffer);
    if (!checkReply(orig).ok) {
      stats.incompatible++;
      stats.error = '弹幕响应格式与预期不符，已跳过';
      console.warn('[本地弹幕] 弹幕响应格式与预期不符，未注入', url);
      return buffer;
    }
    const from = lowerBound((seg - 1) * SEG_MS);
    const to = lowerBound(seg * SEG_MS);
    if (from >= to) return buffer;
    const extra = [];
    for (let i = from; i < to; i++) {
      for (const b of encodeElem(danmakus[i], i)) extra.push(b);
    }
    const merged = new Uint8Array(orig.length + extra.length);
    merged.set(orig, 0);
    merged.set(extra, orig.length);
    stats.merged++;
    stats.added += to - from;
    console.info(`[本地弹幕] 分段 ${seg} 注入 ${to - from} 条`);
    return merged.buffer;
  }

  // ---------- 请求拦截 ----------
  // 拦截 Response.prototype 而不是 window.fetch：播放器即使缓存了原生 fetch 也会走这里，
  // 并且保留原始 Response 对象（url、headers 等不变）
  const resProto = Response.prototype;
  const nativeArrayBuffer = resProto.arrayBuffer;
  async function mergedBuffer(res) {
    const buf = await nativeArrayBuffer.call(res);
    try {
      await ready;
      return merge(buf, res.url);
    } catch (e) {
      stats.error = String(e);
      return buf;
    }
  }
  function isSegResponse(res) {
    return res.ok && SEG_RE.test(res.url || '');
  }
  resProto.arrayBuffer = function () {
    return isSegResponse(this) ? mergedBuffer(this) : nativeArrayBuffer.apply(this, arguments);
  };
  const nativeBlob = resProto.blob;
  resProto.blob = function () {
    if (!isSegResponse(this)) return nativeBlob.apply(this, arguments);
    const type = this.headers.get('content-type') || '';
    return mergedBuffer(this).then((buf) => new Blob([buf], { type }));
  };
  if (resProto.bytes) {
    const nativeBytes = resProto.bytes;
    resProto.bytes = function () {
      if (!isSegResponse(this)) return nativeBytes.apply(this, arguments);
      return mergedBuffer(this).then((buf) => new Uint8Array(buf));
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._ldUrl = String(url);
    return xhrOpen.apply(this, arguments);
  };
  const responseDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
  const xhrMerged = new WeakMap();
  Object.defineProperty(XMLHttpRequest.prototype, 'response', {
    configurable: true,
    enumerable: responseDesc.enumerable,
    get() {
      const value = responseDesc.get.call(this);
      const url = this.responseURL || this._ldUrl;
      if (!url || !SEG_RE.test(url) || !(value instanceof ArrayBuffer)) return value;
      if (this.readyState !== 4 || this.status !== 200) return value;
      if (!xhrMerged.has(this)) {
        let out = value;
        try {
          if (loaded) out = merge(value, url);
          else stats.error = '本地弹幕尚未载入完成，XHR 请求已跳过';
        } catch (e) {
          stats.error = String(e);
        }
        xhrMerged.set(this, out);
      }
      return xhrMerged.get(this);
    },
  });

  // 诊断：统计页面实际发出的弹幕分段请求，用于区分“未被拦截”(如在 Worker 中请求)和“格式不符”
  let perfSeen = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (SEG_RE.test(e.name)) perfSeen++;
    }).observe({ type: 'resource', buffered: true });
  } catch (e) {
    // 不支持时忽略
  }

  function statusText() {
    if (!danmakus.length) return '导入本地弹幕XML';
    if (stats.merged) return `本地弹幕: 已注入${stats.added}条`;
    if (stats.incompatible) return '本地弹幕: 格式不符，未注入';
    if (perfSeen && !stats.seen) return '本地弹幕: 请求未被拦截';
    return `本地弹幕: ${danmakus.length}条，等待弹幕请求`;
  }

  // ---------- 持久化（刷新页面后弹幕分段会重新请求） ----------
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

  async function loadSaved() {
    try {
      const saved = await dbOp('readonly', (s) => s.get('current'));
      if (saved && Array.isArray(saved.list)) danmakus = saved.list;
    } catch (e) {
      // 无法读取时保持空列表
    }
    loaded = true;
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
    const refreshLabel = () => {
      label.textContent = statusText();
      label.title = stats.error || `已拦截弹幕请求 ${stats.seen} 次，页面共发出 ${perfSeen} 次`;
    };
    setInterval(refreshLabel, 1000);
    label.onclick = () => input.click();
    const clear = document.createElement('span');
    clear.textContent = ' [清除]';
    clear.style.marginLeft = '6px';
    clear.onclick = async (e) => {
      e.stopPropagation();
      await dbOp('readwrite', (s) => s.delete('current'));
      location.reload();
    };
    btn.append(label, clear);

    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const list = parseXml(await file.text());
      await dbOp('readwrite', (s) => s.put({ name: file.name, list }, 'current'));
      danmakus = list;
      refreshLabel();
      location.reload(); // 重新请求弹幕分段，由原生系统载入
    };

    document.body.append(input, btn);
    ready.then(refreshLabel);
  }

  if (document.body) createUI();
  else document.addEventListener('DOMContentLoaded', createUI);
})();
