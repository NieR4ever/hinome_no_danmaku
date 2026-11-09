const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'local-danmaku.user.js'), 'utf8')
  .replace('  createUI();\n})();', `  globalThis.testApi = {
    loadEmoticons, appendTextWithEmoticons, isEmoticonOnly, isBlocked, addSettingToggle,
    loadFile, showNotice, refreshVisibility, startEmoticonsLoading,
    openPanel, closePanel, updateRangeProgress,
    setPlayback: (hooks) => {
      parseXml = hooks.parseXml; ensureLayer = hooks.ensureLayer;
      bindVideoEvents = hooks.bindVideoEvents; seekTo = hooks.seekTo; tick = hooks.tick;
      video = { currentTime: 0 };
    },
    setUI: (root, button, panel, open, key = '') => {
      uiRoot = root; btn = button; settingsPanel = panel; panelOpen = open;
      placedKey = key;
    },
    getNotice: () => notice,
    settings, setLayer: (value) => { layer = value; }, setPanel: (value) => { settingsPanel = value; }
  };\n})();`);
const entries = JSON.parse(fs.readFileSync(path.join(root, 'emoticons.json'), 'utf8'));

function setup(responseEntries = entries, savedSettings = {}, overrides = {}) {
  const storage = {
    'local-danmaku-ui': JSON.stringify(savedSettings),
  };
  const context = {
    URL,
    localStorage: {
      getItem: (key) => storage[key] || null,
      setItem: (key, value) => { storage[key] = value; },
    },
    document: {
      createTextNode: (text) => ({ type: 'text', text }),
      createElement: (type) => ({
        type,
        style: {},
        append(...children) { this.children = children; },
        addEventListener(event, callback) { this[event] = callback; },
      }),
    },
    GM_xmlhttpRequest: ({ onload }) => onload({
      status: 200,
      responseText: JSON.stringify(responseEntries),
    }),
  };
  Object.assign(context, overrides);
  vm.runInNewContext(source, context);
  context.testApi.storage = storage;
  return context.testApi;
}

function render(api, text) {
  const children = [];
  api.appendTextWithEmoticons({ appendChild: (node) => children.push(node) }, text);
  return children;
}

test('only bracketed mappings are rendered and explicit mappings take precedence', async () => {
  const api = setup();
  await api.loadEmoticons();
  const nodes = render(api, '赞 比心 啊 [赞][比心][啊] [未知]');
  assert.equal(nodes[0].text, '赞 比心 啊 ');
  assert.deepEqual(nodes.slice(1, 4).map((node) => node.alt), ['[赞]', '[比心]', '[啊]']);
  assert.equal(nodes[1].src, entries.find((entry) => entry.text === '[赞]').url);
  assert.equal(nodes[2].src, entries.find((entry) => entry.text === '[比心]').url);
  assert.equal(nodes[3].src, entries.find((entry) => entry.text === '啊').url);
  assert.equal(nodes[4].text, ' [未知]');
});

test('XML import and playback do not wait for mapping and visible danmaku update on completion', async () => {
  let request;
  const api = setup(entries, { blockEmoticonOnly: true }, {
    GM_xmlhttpRequest: (options) => { request = options; },
  });
  let parsed = false;
  let playing = false;
  api.setPlayback({
    parseXml: (text) => { parsed = text === '<xml/>'; return []; },
    ensureLayer: () => true,
    bindVideoEvents: () => {},
    seekTo: () => {},
    tick: () => { playing = true; },
  });
  const nodes = ['[dog]', '好[dog]'].map((text) => ({
    dataset: { danmakuPosition: 'scroll', danmakuColorful: 'false', danmakuText: text },
    style: {},
    offsetWidth: 42,
    remove() { this.removed = true; },
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
    getAnimations() { return [{ effect: { setKeyframes: (frames) => { this.frames = frames; } } }]; },
  }));
  api.setLayer({ clientWidth: 500, querySelectorAll: () => nodes });
  await api.loadFile({ text: async () => '<xml/>' });
  assert.equal(parsed, true);
  assert.equal(playing, true);
  assert.equal(render(api, '[dog]')[0].text, '[dog]');
  request.onload({ status: 200, responseText: JSON.stringify(entries) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodes[0].removed, true);
  assert.equal(nodes[1].children[1].alt, '[dog]');
  assert.equal(nodes[1].frames[1].transform, 'translateX(-42px)');
});

test('a slower earlier import cannot replace the most recently selected XML', async () => {
  const parsed = [];
  let finishFirst;
  const api = setup(entries, {}, { GM_xmlhttpRequest: () => {} });
  api.setPlayback({
    parseXml: (text) => { parsed.push(text); return []; },
    ensureLayer: () => true,
    bindVideoEvents: () => {},
    seekTo: () => {},
    tick: () => {},
  });
  const first = api.loadFile({ text: () => new Promise((resolve) => { finishFirst = resolve; }) });
  await api.loadFile({ text: async () => 'new' });
  finishFirst('old');
  await first;
  assert.deepEqual(parsed, ['new']);
});

test('failure notice forces hidden button visible, tracks panel position, and closes', async () => {
  let request;
  let timer;
  const elements = [];
  function element(type) {
    return {
      type, style: {}, children: [], offsetHeight: 40,
      classList: { add() {}, remove() {} },
      setAttribute(name, value) { this[name] = value; },
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      remove() { this.removed = true; },
      animate(frames, options) { this.animation = { frames, options }; },
    };
  }
  const root = element('div');
  root.getBoundingClientRect = () => ({ left: 400, top: 100 });
  const button = element('div');
  button.getBoundingClientRect = () => ({ left: 400, right: 428, top: 100, bottom: 128 });
  const panel = element('div');
  panel.getBoundingClientRect = () => ({ left: 300, top: 134, width: 220 });
  panel.offsetWidth = 220;
  const api = setup(entries, { uiVisibility: 'hover' }, {
    document: {
      createElement: (type) => { const el = element(type); elements.push(el); return el; },
    },
    window: { innerWidth: 800, innerHeight: 600 },
    GM_xmlhttpRequest: (options) => { request = options; },
    console: { error() {} },
    setTimeout: (callback, delay) => { timer = { callback, delay }; return 1; },
    clearTimeout: () => {},
  });
  api.setUI(root, button, panel, false);
  api.refreshVisibility();
  assert.equal(root.style.opacity, '0');
  api.startEmoticonsLoading();
  request.onerror();
  await new Promise((resolve) => setImmediate(resolve));
  const notice = api.getNotice();
  assert.equal(notice.role, 'alert');
  assert.equal(root.style.opacity, '1');
  assert.equal(timer.delay, 2000);
  assert.equal(notice.style.top, '34px');
  assert.equal(notice.children[2].animation.options.duration, 2000);
  assert.equal(notice.children[2].animation.frames[0].transform, 'scaleX(1)');
  assert.equal(notice.children[2].animation.frames[1].transform, 'scaleX(0)');
  for (const [key, left, top] of [
    ['player:top-left', '34px', '0px'],
    ['player:mid-left', '34px', '0px'],
    ['player:top-right', '-286px', '0px'],
    ['player:mid-right', '-286px', '0px'],
    ['player:top', '0px', '34px'],
    ['list', '0px', '34px'],
    ['free', '0px', '34px'],
  ]) {
    api.setUI(root, button, panel, false, key);
    api.refreshVisibility();
    assert.equal(notice.style.left, left, key);
    assert.equal(notice.style.top, top, key);
  }
  button.getBoundingClientRect = () => ({ left: 700, right: 728, top: 570, bottom: 598 });
  api.setUI(root, button, panel, false, 'player:mid-left');
  api.refreshVisibility();
  assert.equal(notice.style.width, '58px');
  assert.equal(notice.style.left, '334px');
  assert.equal(notice.style.top, '452px');
  button.getBoundingClientRect = () => ({ left: 400, right: 428, top: 100, bottom: 128 });
  api.setUI(root, button, panel, true);
  api.refreshVisibility();
  assert.equal(notice.style.top, '34px');
  assert.equal(notice.style.left, '-100px');
  assert.equal(notice.style.width, '220px');
  notice.children[1].onclick();
  assert.equal(notice.style.pointerEvents, 'none');
  timer.callback();
  assert.equal(notice.removed, true);
  api.setUI(root, button, panel, false);
  api.refreshVisibility();
  assert.equal(root.style.opacity, '0');
  api.startEmoticonsLoading();
  request.ontimeout();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(api.getNotice());
  timer.callback();
  assert.equal(api.getNotice(), null);
  assert.equal(root.style.opacity, '0');
});

test('panel can be reopened while closing and is inaccessible when closed', () => {
  const classes = new Set();
  const button = {
    setAttribute(name, value) { this[name] = value; },
  };
  const panel = {
    style: {},
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
    },
    setAttribute(name, value) { this[name] = value; },
    getBoundingClientRect: () => ({ top: 100 }),
  };
  const root = { style: {}, parentElement: null };
  const api = setup(entries, {}, { window: { innerHeight: 600 } });
  api.setUI(root, button, panel, false);
  api.openPanel();
  assert.equal(panel.inert, false);
  assert.equal(panel['aria-hidden'], 'false');
  assert.equal(button['aria-expanded'], 'true');
  assert.ok(classes.has('ld-panel-open'));
  api.closePanel();
  assert.equal(panel.inert, true);
  assert.equal(panel['aria-hidden'], 'true');
  assert.equal(button['aria-expanded'], 'false');
  assert.equal(classes.has('ld-panel-open'), false);
  api.openPanel();
  assert.ok(classes.has('ld-panel-open'));
  assert.equal(panel.inert, false);
});

test('range progress reflects its bounds and current value', () => {
  const api = setup();
  const input = {
    min: '-5', max: '5', value: '0',
    style: { setProperty(name, value) { this[name] = value; } },
  };
  api.updateRangeProgress(input);
  assert.equal(input.style['--ld-progress'], '50%');
  input.value = '5';
  api.updateRangeProgress(input);
  assert.equal(input.style['--ld-progress'], '100%');
  input.value = '-5';
  api.updateRangeProgress(input);
  assert.equal(input.style['--ld-progress'], '0%');
});

test('bracketed exact-host HTTPS links work without a mapping', () => {
  const api = setup();
  const url = 'https://i0.hdslb.com/bfs/emote/a0d37b43d1e786ba811d9b0ae590c479dcce6c44.png';
  const text = `前[${url}]后 ${url} [https://i0.hdslb.com.evil.test/a] [http://i0.hdslb.com/a]`;
  const nodes = render(api, text);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].text, '前');
  assert.equal(nodes[1].src, url);
  assert.equal(nodes[1].alt, `[${url}]`);
  assert.equal(nodes[2].text, `后 ${url} [https://i0.hdslb.com.evil.test/a] [http://i0.hdslb.com/a]`);
});

test('explicit bracketed mappings win regardless of order', async () => {
  const url1 = 'https://i0.hdslb.com/first.png';
  const url2 = 'https://i0.hdslb.com/second.png';
  for (const list of [
    [{ text: '赞', url: url1 }, { text: '[赞]', url: url2 }],
    [{ text: '[赞]', url: url2 }, { text: '赞', url: url1 }],
  ]) {
    const api = setup(list);
    await api.loadEmoticons();
    assert.equal(render(api, '[赞]')[0].src, url2);
  }
});

test('only recognized emoticons and whitespace count as pure emoticons', async () => {
  const api = setup();
  await api.loadEmoticons();
  const url = '[https://i0.hdslb.com/bfs/emote/example.png]';
  for (const text of ['[dog]', ' [赞] \t[比心] ', `${url}[dog]`, url]) {
    assert.equal(api.isEmoticonOnly(text), true, text);
  }
  for (const text of ['', ' ', '赞', '[未知]', '[dog][未知]', '[dog]好', `文字${url}`, '[https://i0.hdslb.com.evil.test/a]']) {
    assert.equal(api.isEmoticonOnly(text), false, text);
  }
});

test('pure emoticon filter restores, saves and immediately removes matching visible danmaku', async () => {
  const restored = setup(entries, { blockEmoticonOnly: true });
  await restored.loadEmoticons();
  assert.equal(restored.isBlocked('scroll', false, '[dog]'), true);
  assert.equal(restored.isBlocked('scroll', false, '好[dog]'), false);

  const api = setup();
  await api.loadEmoticons();
  assert.equal(api.isBlocked('scroll', false, '[dog]'), false);
  const nodes = ['[dog]', '好[dog]', '[未知]'].map((text) => ({
    dataset: { danmakuPosition: 'scroll', danmakuColorful: 'false', danmakuText: text },
    remove() { this.removed = true; },
  }));
  api.setLayer({ querySelectorAll: () => nodes });
  let row;
  api.setPanel({ appendChild: (element) => { row = element; } });
  api.addSettingToggle('纯表情', 'blockEmoticonOnly');
  const input = row.children[0];
  input.checked = true;
  input.change();
  assert.deepEqual(nodes.map((node) => !!node.removed), [true, false, false]);
  assert.equal(JSON.parse(api.storage['local-danmaku-ui']).blockEmoticonOnly, true);
  assert.equal(api.isBlocked('scroll', false, '[dog]'), true);
  input.checked = false;
  input.change();
  assert.equal(api.isBlocked('scroll', false, '[dog]'), false);
  assert.equal(JSON.parse(api.storage['local-danmaku-ui']).blockEmoticonOnly, false);
});
