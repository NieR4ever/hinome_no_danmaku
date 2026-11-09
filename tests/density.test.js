const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'local-danmaku.user.js'), 'utf8')
  .replace('  createUI();\n})();', `  globalThis.testApi = {
    densityPathFor, updateDensityChart, positionDensityChart, bindVideoEvents, applySettings, addSettingRow,
    addSettingToggle, refreshDensityVisibility,
    settings, saveSettings,
    setEnabled: (value) => { enabled = value; refreshDensityVisibility(); },
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
      offsetWidth: 400, offsetHeight: 20, clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0,
      getBoundingClientRect() { return { left: 100, top: 200, bottom: 220, width: 400, height: 20 }; },
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
    getComputedStyle: () => ({ position: 'static', overflow: 'hidden' }),
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
  assert.ok(path.startsWith('M0 0 L0 100 L3.125 100 C6.25 100 6.25 50 9.375 50 C12.5 50 12.5 0 15.625 0'));
  assert.ok(path.endsWith('C993.75 0 993.75 100 996.875 100 L1000 100 L1000 0 Z'));
  const shifted = api.densityPathFor(data, 160, 1);
  assert.ok(shifted.startsWith('M0 0 L0 50 L3.125 50 C6.25 50 6.25 100 9.375 100'));
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
  assert.equal(chart.style.top, '20px');
  assert.equal(chart.style.left, '0px');
  assert.equal(chart.style.width, '400px');
  assert.equal(progress.style.overflow, 'visible');
  assert.equal(progress.style.isolation, 'isolate');
  assert.match(chart.style.cssText, /z-index:-1/);
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

test('chart tracks the actual progress bar under a scaled and inset wrapper', () => {
  const { api, element, setVideo } = setup();
  const progress = element('div');
  progress.offsetWidth = 400;
  progress.offsetHeight = 30;
  progress.clientLeft = 2;
  progress.clientTop = 1;
  progress.scrollLeft = 3;
  progress.scrollTop = 4;
  progress.getBoundingClientRect = () => ({ left: 100, top: 200, width: 800, height: 60 });
  const track = element('div');
  track.getBoundingClientRect = () => ({ left: 140, top: 212, bottom: 220, width: 720 });
  progress.querySelector = (selector) => selector === '.bpx-player-progress' ? track : null;
  setVideo(makeVideo(progress, 100));
  api.setData([{ t: 10 }]);
  api.updateDensityChart();
  const chart = api.getChart();
  assert.equal(chart.style.left, '21px');
  assert.equal(chart.style.top, '13px');
  assert.equal(chart.style.width, '360px');
  track.getBoundingClientRect = () => ({ left: 160, top: 220, bottom: 230, width: 600 });
  api.positionDensityChart();
  assert.equal(chart.style.left, '31px');
  assert.equal(chart.style.top, '18px');
  assert.equal(chart.style.width, '300px');
});

test('density opacity restores, validates, updates immediately and persists', () => {
  assert.equal(setup().api.settings.densityOpacity, 25);
  assert.equal(setup({ densityOpacity: 101 }).api.settings.densityOpacity, 25);
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

test('density visibility restores, persists and respects local danmaku visibility', () => {
  const { api, element, setVideo, storage } = setup({ showDensity: false });
  const progress = element('div');
  setVideo(makeVideo(progress, 100));
  api.setData([{ t: 5 }]);
  api.updateDensityChart();
  const chart = api.getChart();
  assert.equal(chart.style.display, 'none');

  const panel = element('div');
  api.setPanel(panel);
  api.addSettingToggle('显示密度图', 'showDensity');
  const input = panel.children[0].children[0];
  assert.equal(input.checked, false);
  input.checked = true;
  input.change();
  assert.equal(chart.style.display, '');
  assert.equal(JSON.parse(storage['local-danmaku-ui']).showDensity, true);
  api.setEnabled(false);
  assert.equal(chart.style.display, 'none');
  api.setEnabled(true);
  assert.equal(chart.style.display, '');
  input.checked = false;
  input.change();
  api.updateDensityChart();
  api.setEnabled(false);
  api.setEnabled(true);
  assert.equal(chart.style.display, 'none');
  assert.equal(JSON.parse(storage['local-danmaku-ui']).showDensity, false);
  assert.equal(setup({ showDensity: 'false' }).api.settings.showDensity, true);
});
