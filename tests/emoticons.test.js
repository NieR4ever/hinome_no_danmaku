const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'local-danmaku.user.js'), 'utf8')
  .replace('  createUI();\n})();', `  globalThis.testApi = {
    loadEmoticons, appendTextWithEmoticons, isEmoticonOnly, isBlocked, addSettingToggle,
    mergeDuplicateDanmakus, duplicateFontSizeIncrease, settings,
    setLayer: (value) => { layer = value; }, setPanel: (value) => { settingsPanel = value; }
  };\n})();`);
const entries = JSON.parse(fs.readFileSync(path.join(root, 'emoticons.json'), 'utf8'));

function setup(responseEntries = entries, savedSettings = {}) {
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

test('duplicate danmaku merge within five seconds from the first occurrence', () => {
  const api = setup();
  const merged = api.mergeDuplicateDanmakus([
    { t: 1, text: '来了来了', mode: 1, size: 25, color: 0xffffff },
    { t: 2, text: '别的弹幕', mode: 1, size: 25, color: 0xffffff },
    { t: 5.9, text: '来了来了', mode: 1, size: 25, color: 0xffffff },
    { t: 6.01, text: '来了来了', mode: 1, size: 25, color: 0xffffff },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(merged.map(({ t, text, count }) => [t, text, count]))), [
    [1, '来了来了', 2],
    [2, '别的弹幕', 1],
    [6.01, '来了来了', 1],
  ]);
  assert.deepEqual([19, 20, 40, 100, 120].map(api.duplicateFontSizeIncrease), [0, 1, 2, 5, 5]);
});

test('duplicate merge setting restores and saves its value', () => {
  const restored = setup(entries, { mergeDuplicates: true });
  let row;
  restored.setPanel({ appendChild: (element) => { row = element; } });
  restored.addSettingToggle('合并5秒内的重复弹幕', 'mergeDuplicates');
  const input = row.children[0];
  assert.equal(input.checked, true);
  input.checked = false;
  input.change();
  assert.equal(JSON.parse(restored.storage['local-danmaku-ui']).mergeDuplicates, false);
});
