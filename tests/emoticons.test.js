const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'local-danmaku.user.js'), 'utf8')
  .replace('  createUI();\n})();', '  globalThis.testApi = { loadEmoticons, appendTextWithEmoticons };\n})();');
const entries = JSON.parse(fs.readFileSync(path.join(root, 'emoticons.json'), 'utf8'));

function setup(responseEntries = entries) {
  const context = {
    URL,
    localStorage: { getItem: () => null },
    document: {
      createTextNode: (text) => ({ type: 'text', text }),
      createElement: () => ({ type: 'image', style: {} }),
    },
    GM_xmlhttpRequest: ({ onload }) => onload({
      status: 200,
      responseText: JSON.stringify(responseEntries),
    }),
  };
  vm.runInNewContext(source, context);
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
