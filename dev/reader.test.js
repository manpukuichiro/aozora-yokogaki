// ブラウザAPIを最小限の代替に置き換えた回帰テスト（実画面の検証とは別）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function catalog(fetch) {
  const context = vm.createContext({ fetch });
  vm.runInContext(source('catalog.js') + '\nglobalThis.api = Catalog;', context);
  return context.api;
}

test('全目録と本棚・収録作品は同じAND条件を使う', async () => {
  const api = catalog(async () => ({ ok: true, json: async () => JSON.parse(source('data/catalog.json')) }));
  await api.load();
  const result = api.search('猫　漱石');
  assert.ok(result.some((work) => work.title === '吾輩は猫である' && work.author === '夏目漱石'));
  assert.equal(api.search('存在しない検索語 漱石').length, 0);
  assert.equal(api.search(' \t　').length, 0);
  assert.equal(api.search('猫 漱石', { exclude: () => true }).length, 0);
  for (const work of result) assert.ok(api.matches(work, api.terms('漱石 猫')));
  const bundled = JSON.parse(source('texts/index.json'));
  assert.ok(bundled.some((work) => api.matches(work, api.terms('猫 漱石'))));
  assert.ok(api.matches({ title: 'テスト', author: '夏目漱石', translatorYomi: 'ヤマダ' }, api.terms('ﾃｽﾄ やまだ')));
  assert.equal(api.matches({ title: '猫', author: '漱石' }, api.terms('猫漱石')), false);
});

class Element {
  constructor() { this.children = []; this.events = {}; this.style = { setProperty() {} }; this.dataset = {}; this.value = ''; }
  addEventListener(name, fn) { this.events[name] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  removeAttribute() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return this; }
  getBoundingClientRect() { return { height: 50 }; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
}

function reader(api, extra = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const storage = new Map();
  const document = {
    getElementById: element, createElement: () => new Element(), createDocumentFragment: () => new Element(),
    documentElement: Object.assign(new Element(), { scrollHeight: 2000 }),
    querySelector: () => ({ value: 'rank' }), querySelectorAll: () => [],
    fonts: { addEventListener() {}, ready: Promise.resolve() }, addEventListener() {},
  };
  const context = vm.createContext({
    document, Catalog: api, Library: {}, AozoraText: { prepare: (text) => ({ text, aozora: false }) }, console: { warn() {} },
    window: { scrollY: 300, innerHeight: 800, addEventListener() {}, scrollTo() {} },
    location: { href: 'http://localhost/' }, history: { replaceState() {} }, URL, URLSearchParams, TextEncoder,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    ResizeObserver: class { observe() {} }, IntersectionObserver: class { observe() {} disconnect() {} },
    clearTimeout, setTimeout, ...extra,
  });
  // 起動時のI/Oだけを省き、画面のイベントハンドラを含めた本体を実行する。
  vm.runInContext(source('reader.js').replace('  init();', `
    globalThis.api = { catalogNodes, renderWorksList, selectWork, importFiles, openText, renderHome,
      seedWorks: (works, shelf = []) => { siteWorks = works; books = shelf; },
      seed: (key, items) => { currentKey = key; paragraphs = items; },
      state: () => ({ catalogPending, catalogFailed }) };
  `), context);
  element('works-dialog').open = true;
  return { api: context.api, element, storage };
}

test('目録の失敗は再描画・入力・並び替えで再試行せず、再読み込みで復帰する', async () => {
  let requests = 0;
  let succeed = false;
  const api = catalog(async () => {
    requests++;
    if (!succeed) throw Error('offline');
    return { ok: true, json: async () => JSON.parse(source('data/catalog.json')) };
  });
  const app = reader(api);
  app.element('works-search').value = '猫 漱石';
  app.api.renderWorksList();
  app.api.renderWorksList();
  await flush();
  assert.equal(requests, 1);
  app.element('works-search').events.input();
  app.api.renderWorksList();
  await flush();
  assert.equal(requests, 1);
  const retry = app.element('works-list').children.find((node) => node.textContent === '目録を再読み込み');
  assert.ok(retry);
  succeed = true;
  retry.events.click();
  await flush();
  assert.equal(requests, 2);
  assert.equal(app.api.state().catalogFailed, false);
  assert.ok(app.element('works-list').children.some((node) => node.className === 'catalog-item'));
});

test('400msの保存待ちより先に別作品を選んでも旧作品の位置が残る', () => {
  const app = reader({}, { fetch: () => new Promise(() => {}), Library: { getText: () => new Promise(() => {}) } });
  for (const target of ['next.txt', 'lib:next']) {
    app.api.seed('site:old.txt', [{ offsetTop: 100, offsetHeight: 500 }]);
    app.api.selectWork(target);
    const saved = JSON.parse(app.storage.get('aozora-reader:pos:site:old.txt'));
    assert.equal(saved.index, 0);
    assert.equal(saved.ratio, 0.5);
  }
});

test('空の目録も読込済みとして扱い再取得ループにならない', async () => {
  let requests = 0;
  const api = catalog(async () => {
    requests++;
    return { ok: true, json: async () => ({ fields: [], kanaTypes: [], works: [] }) };
  });
  const app = reader(api);
  app.element('works-search').value = '猫';
  app.api.renderWorksList();
  await flush();
  app.api.renderWorksList();
  assert.equal(requests, 1);
  assert.equal(api.isLoaded(), true);
});

test('続きから読むは旧データを引き継ぎ、最近読んだ5作品を重複なく保存・表示する', () => {
  const app = reader({}, { fetch: () => new Promise(() => {}) });
  const works = Array.from({ length: 7 }, (_, i) => ({ file: `work${i}.txt`, title: `作品${i}` }));
  app.api.seedWorks(works, [{ id: 'shelf', title: '本棚の作品' }]);
  app.storage.set('aozora-reader:last', JSON.stringify('work0.txt'));
  app.storage.set('aozora-reader:pos:site:work0.txt', JSON.stringify({ percent: 42 }));
  app.api.renderHome();
  assert.equal(app.element('home-resume').children.length, 1);
  assert.equal(app.element('home-resume').children[0].children[1].textContent, '前回の位置：42%');

  for (let i = 1; i <= 6; i++) app.api.openText(`site:work${i}.txt`, `作品${i}`, '本文');
  app.api.openText('site:work3.txt', '作品3', '本文');
  app.api.openText('lib:shelf', '本棚の作品', '本文');
  const recent = JSON.parse(app.storage.get('aozora-reader:recent'));
  assert.deepEqual(recent, ['lib:shelf', 'work3.txt', 'work6.txt', 'work5.txt', 'work4.txt']);
  app.storage.set('aozora-reader:pos:lib:shelf', JSON.stringify({ percent: 100 }));
  app.api.renderHome();
  const cards = app.element('home-resume').children;
  assert.equal(cards.length, 5);
  assert.equal(cards[0].children[1].textContent, '前回の位置：100%');
  assert.equal(cards[0].children[2].children[0].style.width, '100%');

  // 読み込み開始だけでは履歴を押し出さず、カードは対応する作品を開く。
  cards[1].events.click();
  assert.equal(app.element('current-title').textContent, '作品3');
  assert.deepEqual(JSON.parse(app.storage.get('aozora-reader:recent')), recent);

  // 再起動相当の描画でも順序を保ち、削除済みの本棚作品は除く。
  const restarted = reader({});
  for (const [key, value] of app.storage) restarted.storage.set(key, value);
  restarted.api.seedWorks(works);
  restarted.api.renderHome();
  assert.equal(restarted.element('home-resume').children.length, 4);
  assert.equal(restarted.element('home-resume').children[0].children[0].textContent, '作品3');
  restarted.api.seedWorks([]);
  restarted.api.renderHome();
  assert.equal(restarted.element('home-resume-section').hidden, true);
});

// IndexedDBの非同期requestとtransaction完了を再現し、Libraryの保存APIも通す。
function library() {
  const stores = { books: new Map(), texts: new Map() };
  const db = {
    transaction() {
      const tx = { objectStore: (name) => ({
        getAll: () => request(() => [...stores[name].values()]),
        get: (id) => request(() => stores[name].get(id)),
        put: (record) => request(() => stores[name].set(record.id, { ...record })),
        delete: (id) => request(() => stores[name].delete(id)),
      }) };
      setImmediate(() => tx.oncomplete?.());
      return tx;
    },
  };
  function request(work) {
    const req = {};
    queueMicrotask(() => { req.result = work(); req.onsuccess?.(); });
    return req;
  }
  const context = vm.createContext({ indexedDB: { open: () => request(() => db) }, crypto: webcrypto, TextEncoder });
  vm.runInContext(source('library.js') + '\nglobalThis.api = Library;', context);
  return context.api;
}

test('同名・同文字数の別作品は両方残り、同じ本文は再登録されない', async () => {
  const api = library();
  const a = { title: '甲', author: '作者', innerName: 'book.txt', addedAt: 1 };
  const b = { ...a, title: '乙' };
  const first = await api.identify(a, '甲\n作者\n\n本文');
  await api.save({ ...a, ...first }, '甲\n作者\n\n本文');
  const second = await api.identify(b, '乙\n作者\n\n本文');
  assert.notEqual(first.id, second.id);
  await api.save({ ...b, ...second }, '乙\n作者\n\n本文');
  assert.equal((await api.list()).length, 2);
  assert.equal((await api.identify({ ...a, innerName: 'renamed.txt' }, '甲\n作者\n\n本文')).id, first.id);
});

test('青空文庫の改訂は旧IDを維持し、同じIDで本文を更新する', async () => {
  const api = library();
  const old = { id: 'old.txt:10', workId: '000773', title: '作品', addedAt: 1 };
  await api.save(old, '旧本文');
  const identity = await api.identify({ ...old, innerName: 'new.txt' }, '文字数の変わった新本文');
  assert.equal(identity.id, old.id);
  await api.save({ ...old, ...identity }, '文字数の変わった新本文');
  assert.equal((await api.list()).length, 1);
  assert.equal(await api.getText(old.id), '文字数の変わった新本文');
  const plain = await api.identify({ title: '推定タイトル', innerName: 'plain.txt' }, '文字数の変わった新本文');
  assert.equal(plain.id, old.id);
  assert.equal(plain.workId, old.workId);
  assert.equal(plain.title, old.title);
});

test('旧形式の一般テキストは同一本文なら自動継承、改訂時は承認時だけ置換', async () => {
  const api = library();
  const old = { id: 'sample.txt:3', title: '作品', author: '作者', addedAt: 1 };
  const book = { title: '作品', author: '作者', innerName: 'sample.txt' };
  await api.save(old, '旧本文');
  assert.equal((await api.identify(book, '旧本文')).id, old.id);
  assert.notEqual((await api.identify(book, '別本文', () => false)).id, old.id);
  assert.equal((await api.identify(book, '改訂された長い本文', () => true)).id, old.id);
  assert.equal(await api.getText(old.id), '旧本文');
});

test('保存不可でも取り込み用IDを生成できる', async () => {
  const context = vm.createContext({ crypto: webcrypto, TextEncoder });
  vm.runInContext(source('library.js') + '\nglobalThis.api = Library;', context);
  assert.match((await context.api.identify({}, '本文')).id, /^text:/);
});

test('本棚全件表示と削除：キャンセル・失敗は保持し、読書中の削除後に位置を復活させない', async () => {
  const lib = library();
  const shelf = Array.from({ length: 10 }, (_, i) => ({ id: 'book' + i, title: '本' + i, addedAt: i }));
  for (const book of shelf) await lib.save(book, '本文');
  let approved = false;
  let fail = false;
  const alerts = [];
  const api = catalog(async () => { throw Error('本棚表示では目録を取得しない'); });
  const app = reader(api, {
    confirm: () => approved, alert: (message) => alerts.push(message),
    Library: { ...lib, remove: (id) => { if (fail) throw Error('保存領域エラー'); return lib.remove(id); } },
  });
  app.api.seedWorks([{ file: 'site.txt', title: '収録作品' }], shelf);
  app.api.renderHome();
  assert.equal(app.element('home-shelf').children.length, 8);
  app.element('home-shelf-all').events.click();
  assert.equal(app.element('works-order').hidden, true);
  assert.equal(app.element('works-show-all').hidden, false);
  assert.equal(app.element('works-list').children.filter((row) => row.className === 'shelf-item').length, 10);
  app.element('works-search').value = '本9';
  app.element('works-search').events.input();
  let row = app.element('works-list').children.find((node) => node.className === 'shelf-item');
  await row.children[1].events.click();
  assert.equal((await lib.list()).length, 10);
  approved = true;
  fail = true;
  await row.children[1].events.click();
  assert.equal((await lib.list()).length, 10);
  assert.match(alerts[0], /削除できませんでした/);
  fail = false;

  app.api.selectWork('lib:book9');
  await flush();
  await flush();
  app.api.seed('lib:book9', [{ offsetTop: 100, offsetHeight: 500 }]);
  app.storage.set('aozora-reader:pos:lib:book9', JSON.stringify({ index: 0, percent: 50 }));
  // 別作品の読書位置を削除しない。
  app.storage.set('aozora-reader:pos:lib:book8', JSON.stringify({ percent: 20 }));
  await row.children[1].events.click();
  assert.equal(await lib.getText('book9'), null);
  assert.equal(app.storage.has('aozora-reader:pos:lib:book9'), false);
  assert.ok(app.storage.has('aozora-reader:pos:lib:book8'));
  assert.equal(app.element('home').hidden, false);
  assert.equal(app.element('toc-open').textContent, '目次なし');
  assert.equal(app.element('home-resume-section').hidden, true);
  assert.equal(app.element('works-list').children.some((node) => node.className === 'shelf-item'), false);
});
