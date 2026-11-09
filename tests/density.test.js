const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'local-danmaku.user.js'), 'utf8')
  .replace('  createUI();\n})();', `  globalThis.testApi = {
    densityPathFor, updateDensityChart, bindVideoEvents, applySettings, addSettingRow,
    settings, saveSettings,
    setData: (data) => { danmakus = data; },
    setPanel: (panel) => { settingsPanel = panel; },
    getChart: () => densityChart
  };\n})();`);

function setup(saved = {}) {
  const storage = { 'local-danmaku-ui': JSON.stringify(saved) };
  let currentVideo = null;
  function element(type) {
    return {
      type, style: {}, dataset: {}, attributes: {}, children: [], parentElement: null,
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) {
        if (child.parentElement) child.remove();
        this.children.push(child);
        child.parentElement = this;
      },
      append(...children) { children.forEach((child) => this.appendChild(child)); },
      remove() {
        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
          this.parentElement = null;
        }
      },
      addEventListener(name, callback) { this[name] = callback; },
      querySelector() { return this.children.find((child) => child.type === 'output'); },
      querySelectorAll() { return []; },
    };
  }
  const context = {
    localStorage: {
      getItem: (key) => storage[key] || null,
      setItem: (key, value) => { storage[key] = value; },
    },
    document: {
      querySelector: () => currentVideo,
      createElement: element,
      createElementNS: (namespace, type) => element(type),
    },
    getComputedStyle: () => ({ position: 'static' }),
  };
  vm.runInNewContext(source, context);
  return {
    api: context.testApi, storage, element,
    setVideo: (video) => { currentVideo = video; },
  };
}

function makeVideo(progress, duration) {
  const player = { querySelector: () => progress };
  return {
    duration,
    closest: () => player,
    events: {},
    addEventListener(name, callback) { this.events[name] = callback; },
  };
}

test('density bins reflect peaks, zero valleys, offsets and video boundaries', () => {
  const { api } = setup();
  const data = [{ t: 0 }, { t: 0 }, { t: 1 }, { t: 159 }, { t: 160 }, { t: -1 }, { t: Infinity }];
  const path = api.densityPathFor(data, 160, 0);
  assert.ok(path.startsWith('M0 100 L0 0 L3.125 0 C6.25 0 6.25 50 9.375 50 C12.5 50 12.5 100 15.625 100'));
  assert.ok(path.endsWith('C993.75 100 993.75 0 996.875 0 L1000 0 L1000 100 Z'));
  const shifted = api.densityPathFor(data, 160, 1);
  assert.ok(shifted.startsWith('M0 100 L0 50 L3.125 50 C6.25 50 6.25 0 9.375 0'));
  assert.equal(api.densityPathFor([{ t: -10 }, { t: 200 }], 160, 0), '');
});

test('chart follows imports, offset, duration and replaced player without intercepting input', () => {
  const { api, element, setVideo } = setup({ densityOpacity: 25 });
  const progress = element('div');
  const video = makeVideo(progress, 160);
  setVideo(video);
  api.setData([{ t: 0 }, { t: 0 }, { t: 20 }]);
  api.updateDensityChart();
  const chart = api.getChart();
  const path = chart.children[0];
  assert.equal(chart.parentElement, progress);
  assert.match(chart.style.cssText, /pointer-events:none/);
  assert.match(chart.style.cssText, /bottom:100%/);
  assert.doesNotMatch(chart.style.cssText, /top:100%/);
  assert.equal(chart.style.opacity, 0.25);
  assert.equal(chart.attributes['aria-hidden'], 'true');
  const original = path.attributes.d;

  api.settings.offset = 10;
  api.updateDensityChart();
  assert.notEqual(path.attributes.d, original);
  const shifted = path.attributes.d;
  api.bindVideoEvents();
  video.duration = 80;
  video.events.durationchange();
  assert.notEqual(path.attributes.d, shifted);
  api.setData([{ t: 40 }]);
  api.updateDensityChart();
  assert.notEqual(path.attributes.d, shifted);

  const nextProgress = element('div');
  const nextVideo = makeVideo(nextProgress, 100);
  setVideo(nextVideo);
  api.updateDensityChart();
  assert.equal(chart.parentElement, nextProgress);
  assert.equal(progress.children.length, 0);
  nextVideo.duration = Infinity;
  api.updateDensityChart();
  assert.equal(chart.parentElement, null);
  nextVideo.duration = 100;
  api.updateDensityChart();
  assert.equal(chart.parentElement, nextProgress);
  api.setData([]);
  api.updateDensityChart();
  assert.equal(chart.parentElement, null);
});

test('density opacity restores, validates, updates immediately and persists', () => {
  assert.equal(setup({ densityOpacity: 101 }).api.settings.densityOpacity, 50);
  const { api, element, setVideo, storage } = setup({ densityOpacity: 0 });
  const progress = element('div');
  setVideo(makeVideo(progress, 100));
  api.setData([{ t: 5 }]);
  api.updateDensityChart();
  assert.equal(api.getChart().style.opacity, 0);
  const panel = element('div');
  api.setPanel(panel);
  api.addSettingRow('密度图不透明度', 'densityOpacity', 0, 100, 5);
  const slider = panel.children[0].children[2];
  assert.equal(slider.min, 0);
  slider.value = '75';
  slider.input();
  assert.equal(api.getChart().style.opacity, 0.75);
  assert.equal(JSON.parse(storage['local-danmaku-ui']).densityOpacity, 75);
});
