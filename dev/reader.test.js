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

test('全目録の検索は人気順・著者別・50音順を選べる', async () => {
  const api = catalog(async () => ({ ok: true, json: async () => JSON.parse(source('data/catalog.json')) }));
  await api.load();
  const popular = api.search('漱石');
  const ranks = [...popular.map((work) => work.rank).filter(Boolean)];
  assert.ok(ranks.length > 1);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.ok(popular.slice(0, ranks.length).every((work) => work.rank)); // 順位のある作品が先
  const kana = api.search('漱石', { order: 'kana' });
  assert.equal(kana.length, popular.length);
  const yomi = [...kana.map((work) => work.titleYomi)];
  assert.deepEqual(yomi, [...yomi].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  // 著者別：著者名の読みの順、同じ著者の中は作品名の読みの順
  const byAuthor = api.search('こころ', { order: 'author' });
  assert.equal(byAuthor.length, api.search('こころ').length);
  assert.ok(new Set(byAuthor.map((work) => work.author)).size > 1);
  for (let i = 1; i < byAuthor.length; i++) {
    const [a, b] = [byAuthor[i - 1], byAuthor[i]];
    assert.ok(a.authorYomi <= b.authorYomi);
    if (a.authorYomi === b.authorYomi) assert.ok(a.titleYomi <= b.titleYomi);
  }
});

test('検索語がないうちは目録を読み込まない', () => {
  let requests = 0;
  const api = catalog(async () => { requests++; throw Error('読み込まない'); });
  const app = reader(api);
  app.api.renderWorksList();
  assert.equal(requests, 0);
  assert.equal(api.isLoaded(), false);
});

class Element {
  constructor() {
    this.children = []; this.events = {}; this.style = { setProperty() {} }; this.dataset = {}; this.value = '';
    const classes = new Set();
    this.classList = { toggle: (name, on = !classes.has(name)) => (on ? classes.add(name) : classes.delete(name), on), add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) };
  }
  addEventListener(name, fn) { this.events[name] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute() {}
  removeAttribute() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return this; }
  contains(node) { return node === this || this.children.includes(node); }
  getBoundingClientRect() { return { height: 50 }; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = (this.focused || 0) + 1; }
  click() { this.clicks = (this.clicks || 0) + 1; }
}

function reader(api, extra = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const storage = new Map();
  const document = {
    getElementById: element, createElement: extra.createElement || (() => new Element()), createDocumentFragment: () => new Element(),
    documentElement: Object.assign(new Element(), { scrollHeight: 2000 }),
    querySelector: () => ({ value: extra.order || 'rank' }), querySelectorAll: () => [],
    fonts: { addEventListener() {}, ready: Promise.resolve() }, events: {}, activeElement: null,
    addEventListener(name, fn) { this.events[name] = fn; },
  };
  const context = vm.createContext({
    document, Catalog: api, Library: {}, AozoraText: { prepare: (text) => ({ text, aozora: false }) }, console: { warn() {} },
    window: { scrollY: 300, innerHeight: 800, innerWidth: 800, addEventListener() {}, scrollTo() {} },
    location: { href: 'http://localhost/' }, history: { replaceState() {} }, URL, URLSearchParams, TextEncoder,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    ResizeObserver: class { observe() {} }, IntersectionObserver: class { observe() {} disconnect() {} },
    Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
    clearTimeout, setTimeout, ...extra,
  });
  // 起動時のI/Oだけを省き、画面のイベントハンドラを含めた本体を実行する。
  vm.runInContext(source('reader.js').replace('  init();', `
    globalThis.api = { catalogNodes, renderWorksList, selectWork, importFiles, openText, renderHome, openWorks, loadAuthorShortcuts, applySettings, showHome, restorePosition, currentPosition,
      seedWorks: (works, shelf = []) => { siteWorks = works; books = shelf; },
      seed: (key, items) => { currentKey = key; paragraphs = items; },
      weightChoices: (weight) => { settings.weight = weight; populateWeightSelect(); return { options: [...weightSelect.children.map((o) => Number(o.value))], current: currentWeight() }; },
      state: () => ({ catalogPending, catalogFailed }) };
  `), context);
  element('works-dialog').open = true;
  return { api: context.api, element, storage, document };
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

// 作品一覧に出ている目録の作品の著者名（絞り込み中の著者はリンクにせず文字で出す）
const listed = (app) => app.element('works-list').children.filter((node) => node.className === 'catalog-item').map((item) => {
  const meta = item.children[0].children[1];
  const link = meta.children.find((node) => node.className === 'author-link');
  return { link, author: link ? link.textContent : meta.textContent.split('　')[0] };
});
const catalogHeading = (app) => app.element('works-list').children
  .find((node) => node.className === 'works-section' && node.textContent.startsWith('青空文庫から探す')).textContent;

const authorsFile = async (url) => {
  assert.equal(url, 'data/authors.json');
  return { ok: true, json: async () => JSON.parse(source('data/authors.json')) };
};
const chipNames = (app) => {
  const chips = app.element('works-list').children.find((node) => node.className === 'author-shortcuts');
  return chips ? chips.children.map((chip) => chip.textContent) : [];
};

test('著者の候補は作品数の多い100人で、名前と作品数が目録と一致する', () => {
  const data = JSON.parse(source('data/catalog.json'));
  const authorColumn = data.fields.indexOf('author');
  const counts = new Map();
  for (const row of data.works) counts.set(row[authorColumn], (counts.get(row[authorColumn]) || 0) + 1);
  const pool = JSON.parse(source('data/authors.json')).authors;
  assert.equal(pool.length, 100);
  assert.equal(new Set(pool.map(({ name }) => name)).size, 100);
  // 「森鷗外」のように目録と違う字で書くと、押しても 0 件になる
  for (const { name, works } of pool) assert.equal(counts.get(name), works, name);
  for (let i = 1; i < pool.length; i++) assert.ok(pool[i - 1].works >= pool[i].works);
});

test('「著者から探す」は候補から10人をランダムに選び、ページを開いている間は選び直さない', async () => {
  const pool = new Set(JSON.parse(source('data/authors.json')).authors.map(({ name }) => name));
  const picks = [];
  for (let i = 0; i < 3; i++) {
    const app = reader(catalog(async () => ({ ok: true, json: async () => JSON.parse(source('data/catalog.json')) })), { fetch: authorsFile });
    app.api.renderWorksList();
    assert.deepEqual(chipNames(app), []); // 読み込むまでは出さない
    await app.api.loadAuthorShortcuts(); // 開いているポップアップは読み込み後に描き直す
    const names = chipNames(app);
    assert.equal(names.length, 10);
    assert.equal(new Set(names).size, 10);
    assert.ok(names.every((name) => pool.has(name)));
    // 描き直し・開き直し・絞り込みの後も同じ顔ぶれと順番
    app.api.renderWorksList();
    app.api.openWorks('');
    assert.deepEqual(chipNames(app), names);
    app.element('works-list').children.find((node) => node.className === 'author-shortcuts').children[0].events.click();
    await flush();
    assert.ok(catalogHeading(app).startsWith('青空文庫から探す・' + names[0] + 'の作品（'));
    assert.ok(listed(app).length > 0);
    assert.ok(listed(app).every(({ link, author }) => !link && author === names[0]));
    app.api.openWorks('');
    assert.deepEqual(chipNames(app), names);
    picks.push(names.join());
  }
  // ページを読み込み直すと選び直す（3回とも同じになる確率は無視できるほど小さい）
  assert.ok(new Set(picks).size > 1);
});

test('著者の一覧を読み込めなくても「著者から探す」を出さないだけで一覧は表示する', async () => {
  const app = reader({ terms: () => [], matches: () => true }, { fetch: async () => { throw Error('offline'); } });
  await app.api.loadAuthorShortcuts();
  app.api.renderWorksList();
  assert.deepEqual(chipNames(app), []);
  assert.ok(app.element('works-list').children.length > 0);
});

test('著者名を押すとその著者だけに絞り、検索欄の書き換えや開き直しで解除する', async () => {
  const app = reader(catalog(async () => ({ ok: true, json: async () => JSON.parse(source('data/catalog.json')) })));
  app.element('works-search').value = 'こころ';
  app.api.renderWorksList();
  await flush();
  // 作品名に「こころ」を含む他の著者の作品も出ている
  assert.ok(listed(app).some(({ author }) => author !== '夏目漱石'));
  const filter = () => listed(app).find(({ author }) => author === '夏目漱石').link.events.click();
  filter();
  assert.equal(app.element('works-search').value, '夏目漱石');
  assert.match(catalogHeading(app), /・夏目漱石の作品（\d+）$/);
  assert.ok(listed(app).every(({ link, author }) => !link && author === '夏目漱石'));

  app.element('works-search').value = 'こころ';
  app.element('works-search').events.input();
  assert.doesNotMatch(catalogHeading(app), /の作品/);
  assert.ok(listed(app).some(({ author }) => author !== '夏目漱石'));

  filter();
  app.api.openWorks('こころ');
  assert.doesNotMatch(catalogHeading(app), /の作品/);
  assert.ok(listed(app).some(({ author }) => author !== '夏目漱石'));
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

test('続きから読むは旧データを引き継ぎ、最近読んだ10作品を重複なく保存・表示する', () => {
  const app = reader({}, { fetch: () => new Promise(() => {}) });
  const works = Array.from({ length: 12 }, (_, i) => ({ file: `work${i}.txt`, title: `作品${i}` }));
  app.api.seedWorks(works, [{ id: 'shelf', title: '本棚の作品' }]);
  app.storage.set('aozora-reader:last', JSON.stringify('work0.txt'));
  app.storage.set('aozora-reader:pos:site:work0.txt', JSON.stringify({ percent: 42 }));
  app.api.renderHome();
  assert.equal(app.element('home-resume').children.length, 1);
  assert.equal(app.element('home-resume').children[0].children[0].children[1].textContent, '前回の位置：42%');

  for (let i = 1; i <= 11; i++) app.api.openText(`site:work${i}.txt`, `作品${i}`, '本文');
  app.api.openText('site:work3.txt', '作品3', '本文');
  app.api.openText('lib:shelf', '本棚の作品', '本文');
  const recent = JSON.parse(app.storage.get('aozora-reader:recent'));
  assert.deepEqual(recent, ['lib:shelf', 'work3.txt', 'work11.txt', 'work10.txt', 'work9.txt',
    'work8.txt', 'work7.txt', 'work6.txt', 'work5.txt', 'work4.txt']);
  app.storage.set('aozora-reader:pos:lib:shelf', JSON.stringify({ percent: 100 }));
  app.api.renderHome();
  const cards = app.element('home-resume').children.map((row) => row.children[0]);
  assert.equal(cards.length, 10);
  assert.equal(cards[0].children[1].textContent, '前回の位置：100%');
  assert.equal(cards[0].children[2].children[0].style.width, '100%');

  // 読み込み開始だけでは履歴を押し出さず、カードは対応する作品を開く。
  cards[1].events.click();
  assert.equal(app.element('current-title').textContent, '作品3');
  assert.deepEqual(JSON.parse(app.storage.get('aozora-reader:recent')), recent);

  // 「一覧から外す」は一覧から外すだけで、読書位置は残す。
  app.api.renderHome();
  app.element('home-resume').children[0].children[1].events.click();
  assert.deepEqual(JSON.parse(app.storage.get('aozora-reader:recent')), recent.slice(1));
  assert.equal(app.element('home-resume').children.length, 9);
  assert.deepEqual(JSON.parse(app.storage.get('aozora-reader:pos:lib:shelf')), { percent: 100 });
  app.storage.set('aozora-reader:recent', JSON.stringify(recent));

  // 再起動相当の描画でも順序を保ち、削除済みの本棚作品は除く。
  const restarted = reader({});
  for (const [key, value] of app.storage) restarted.storage.set(key, value);
  restarted.api.seedWorks(works);
  restarted.api.renderHome();
  assert.equal(restarted.element('home-resume').children.length, 9);
  assert.equal(restarted.element('home-resume').children[0].children[0].children[0].textContent, '作品3');
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
  assert.equal(app.element('toc-open').hidden, true);
  assert.equal(app.element('home-resume-section').hidden, true);
  assert.equal(app.element('works-list').children.some((node) => node.className === 'shelf-item'), false);
});

// 太さごとの文字の濃さを決めておく偽の canvas（Windows の游明朝を測ったときの比率：500〜700 は同じ Demibold）
const inkCanvas = (inks) => () => ({
  getContext: () => ({
    clearRect() {}, fillText() {},
    set font(value) { this.weight = parseInt(value, 10); },
    getImageData() { return { data: [0, 0, 0, inks[this.weight]] }; },
  }),
});

// vm 内で作った配列はそのままだと deepEqual で別物扱いになるので、こちらの配列に移す
const choices = (app, weight) => {
  const { options, current } = app.api.weightChoices(weight);
  return { options: [...options], current };
};

test('太さは見た目が変わる段階だけを選択肢に出し、同じ見た目の太さは代表に読み替える', () => {
  const app = reader(catalog(async () => ({})), { createElement: inkCanvas({ 300: 545, 400: 658, 500: 905, 600: 908, 700: 905 }) });
  assert.deepEqual(choices(app, 400), { options: [300, 400, 700], current: 400 });
  assert.equal(choices(app, 500).current, 700); // 500 は Demibold で表示されるので「太」に
  assert.equal(choices(app, 650).current, 700);
  assert.equal(choices(app, 200).current, 300);
});

test('太さを測れない環境では全部の太さを選択肢に出す', () => {
  const noCanvas = reader(catalog(async () => ({})));
  assert.deepEqual(choices(noCanvas, 500), { options: [300, 400, 500, 600, 700], current: 500 });
  // 何も描けない（濃さがすべて 0）ときも同じ
  const blank = reader(catalog(async () => ({})), { createElement: inkCanvas({ 300: 0, 400: 0, 500: 0, 600: 0, 700: 0 }) });
  assert.deepEqual(choices(blank, 500).options, [300, 400, 500, 600, 700]);
});

test('検索欄の × で検索語と著者の絞り込みを消し、検索前の一覧に戻る', async () => {
  const app = reader(catalog(async () => ({ ok: true, json: async () => JSON.parse(source('data/catalog.json')) })), { fetch: authorsFile });
  await app.api.loadAuthorShortcuts();
  const clear = app.element('works-search-clear');
  app.api.openWorks('');
  assert.equal(clear.hidden, true); // 何も入っていなければ出さない
  assert.equal(chipNames(app).length, 10);
  app.api.openWorks('こころ');
  await flush();
  assert.equal(clear.hidden, false);
  assert.equal(chipNames(app).length, 0);
  listed(app).find(({ link }) => link).link.events.click(); // 著者で絞り込んだ状態からでも戻れる
  assert.notEqual(app.element('works-search').value, 'こころ');
  clear.events.click();
  assert.equal(app.element('works-search').value, '');
  assert.equal(clear.hidden, true);
  assert.equal(chipNames(app).length, 10);
  assert.equal(app.element('works-list').children.some((node) => node.className === 'catalog-item'), false);
});

test('上の並べ方の切り替えが、すぐに読める作品と青空文庫の検索結果の両方に効く', async () => {
  const api = catalog(async () => ({ ok: true, json: async () => JSON.parse(source('data/catalog.json')) }));
  for (const [order, catalogOrder, heading] of [['rank', 'popular', 'すぐに読める作品・人気順'], ['title', 'kana', 'すぐに読める作品・作品名順'], ['author', 'author', null]]) {
    const orders = [];
    const spy = { ...api, search: (query, options) => { orders.push(options.order); return api.search(query, options); } };
    const app = reader(spy, { order });
    app.api.seedWorks(JSON.parse(source('texts/index.json')));
    app.element('works-search').value = '夏目漱石';
    app.api.renderWorksList();
    await flush();
    app.api.renderWorksList();
    const nodes = app.element('works-list').children;
    const sections = nodes.filter((node) => node.className === 'works-section').map((node) => node.textContent);
    if (heading) assert.ok(sections.some((text) => text.startsWith(heading)), order);
    else assert.ok(sections.some((text) => text.startsWith('夏目漱石')), order); // 著者別は著者ごとの見出し
    assert.deepEqual([...new Set(orders)], [catalogOrder]);
    assert.ok(nodes.some((node) => node.className === 'catalog-item'));
    assert.equal(nodes.some((node) => node.className === 'catalog-order'), false); // 検索結果の中に別の切り替えは置かない
  }
});

test('例文は検索語を入れるとしまい、消すと戻す', () => {
  const app = reader(catalog(async () => { throw Error('offline'); }));
  app.element('works-search').value = '猫';
  app.api.renderWorksList();
  assert.equal(app.element('works-search-help').hidden, true);
  app.element('works-search-clear').events.click();
  assert.equal(app.element('works-search-help').hidden, false);
});

// 青空文庫の検索結果から、作品の欄・①のリンク・押した後に出る案内を取り出す
const catalogItems = (app) => app.element('works-list').children.filter((node) => node.className === 'catalog-item');
const downloadLink = (item) => item.children[1].children[0];
const nextStep = (item) => item.children.find((node) => node.className === 'catalog-next');
const catalogTitle = (item) => item.children[0].children[0].textContent;

test('① ZIPをダウンロードを押すと、その欄に案内と目立つ② 保存したZIPを開くを出し、完了とは書かない', async () => {
  const app = reader(catalog(async () => ({ ok: true, json: async () => JSON.parse(source('data/catalog.json')) })));
  app.element('works-search').value = 'こころ';
  app.api.renderWorksList();
  await flush();
  const item = catalogItems(app).find((node) => downloadLink(node).textContent === '① ZIPをダウンロード');
  assert.ok(item);
  assert.equal(nextStep(item), undefined); // 押すまでは出さない
  downloadLink(item).events.click();
  const next = nextStep(item);
  const [hint, open, input, where] = next.children;
  assert.equal(hint.textContent, 'ブラウザで保存が終わったら、次のボタンからZIPを選んでください。解凍は不要です。');
  assert.equal(open.textContent, '② 保存したZIPを開く');
  assert.ok(open.className.split(' ').includes('primary'));
  assert.equal(input.type, 'file');
  assert.equal(input.hidden, true);
  open.events.click(); // ボタンを押すとファイルの選択画面を開く
  assert.equal(input.clicks, 1);
  input.files = [];
  input.events.change(); // 選ばずに閉じたら何もしない
  assert.equal(app.element('works-dialog').open, true);
  assert.equal(where.className, 'catalog-where');
  assert.equal(where.children[0].textContent, '保存先が分からないとき');
  const allText = [hint, open, ...where.children.slice(1)].map((node) => node.textContent).join('');
  assert.equal(allText.includes('完了'), false);
  for (const place of ['パソコン', 'iPhone', 'Android']) assert.ok(allText.includes(place), place);
});

test('読み込み待ちの作品は、検索し直しても一覧の先頭に残り、本棚に入ると消える', async () => {
  const api = catalog(async () => ({ ok: true, json: async () => JSON.parse(source('data/catalog.json')) }));
  const app = reader(api);
  app.element('works-search').value = 'こころ';
  app.api.renderWorksList();
  await flush();
  const item = catalogItems(app).find((node) => downloadLink(node).textContent === '① ZIPをダウンロード');
  const title = catalogTitle(item);
  downloadLink(item).events.click();
  const pendingHeading = (current) => current.element('works-list').children
    .find((node) => node.className === 'works-section' && node.textContent.startsWith('ダウンロードした作品（読み込み待ち）'));

  // 検索結果に出ているあいだは、その場で案内を出し続ける（先頭には重ねて出さない）
  app.api.renderWorksList();
  assert.equal(pendingHeading(app), undefined);
  assert.ok(nextStep(catalogItems(app).find((node) => catalogTitle(node) === title)));

  // 別の語で検索し直しても、先頭に案内つきで残る
  app.element('works-search').value = '吾輩は猫である';
  app.element('works-search').events.input();
  assert.equal(pendingHeading(app).textContent, 'ダウンロードした作品（読み込み待ち）（1）');
  const kept = app.element('works-list').children[1];
  assert.equal(catalogTitle(kept), title);
  assert.ok(nextStep(kept));

  // 検索語を消しても残る
  app.element('works-search-clear').events.click();
  assert.ok(pendingHeading(app));

  // 本棚に入ったら（読み込めたら）消す
  const { workId } = api.search('こころ').find((work) => work.zip && work.title + (work.subtitle ? '　' + work.subtitle : '') === title);
  app.api.seedWorks([], [{ id: 'saved', title, workId }]);
  app.api.renderWorksList();
  assert.equal(pendingHeading(app), undefined);
});

test('目次のボタンは作品を開くまで出さず、ホームに戻るとまた隠す', () => {
  const app = reader(catalog(async () => ({ ok: true, json: async () => ({ fields: [], kanaTypes: [], works: [] }) })));
  app.api.showHome();
  assert.equal(app.element('toc-open').hidden, true);
  app.api.openText('site:work.txt', '作品', '本文');
  assert.equal(app.element('toc-open').hidden, false);
  assert.equal(app.element('toc-open').textContent, '目次なし'); // 見出しのない作品は、出したうえで押せない
  app.api.showHome();
  assert.equal(app.element('toc-open').hidden, true);
});

test('文字サイズ・行間・太さは数値ではなく言葉で示す', () => {
  const app = reader(catalog(async () => ({ ok: true, json: async () => ({}) })));
  app.api.applySettings();
  assert.equal(app.element('fontSize-value').textContent, '標準');
  assert.equal(app.element('lineHeight-value').textContent, '標準');
  app.element('settings').events.click({ target: { closest: () => ({ dataset: { step: 'fontSize', dir: '1' } }) } });
  assert.equal(app.element('fontSize-value').textContent, 'やや大');
  for (let i = 0; i < 4; i++) app.element('settings').events.click({ target: { closest: () => ({ dataset: { step: 'lineHeight', dir: '-1' } }) } });
  assert.equal(app.element('lineHeight-value').textContent, '狭い');
  const labels = [...app.element('weight-select').children.map((option) => option.textContent)];
  assert.ok(labels.includes('標準'));
  assert.ok(labels.every((label) => !/\d/.test(label)));
});

test('表示設定は「閉じる」・パネルの外・Esc で閉じ、中の操作では閉じない', () => {
  const app = reader(catalog(async () => ({ ok: true, json: async () => ({}) })));
  const panel = app.element('settings');
  const toggle = app.element('settings-toggle');
  panel.hidden = true;
  app.element('works-dialog').open = false;
  const open = () => { toggle.events.click(); assert.equal(panel.hidden, false); };
  open();
  const inside = new Element();
  panel.append(inside);
  app.document.events.click({ target: inside });
  assert.equal(panel.hidden, false);
  app.document.events.click({ target: toggle }); // 「表示設定」自身はトグルの処理に任せる
  assert.equal(panel.hidden, false);
  app.document.events.click({ target: new Element() });
  assert.equal(panel.hidden, true);
  open();
  app.element('settings-close').events.click();
  assert.equal(panel.hidden, true);
  assert.ok(toggle.focused); // キーボードで続けて操作できるよう「表示設定」へ戻す
  open();
  app.element('works-dialog').open = true; // ポップアップが開いていれば Esc はそちらに任せる
  app.document.events.keydown({ key: 'Escape' });
  assert.equal(panel.hidden, false);
  app.element('works-dialog').open = false;
  app.document.events.keydown({ key: 'Escape' });
  assert.equal(panel.hidden, true);
  open();
  toggle.events.click();
  assert.equal(panel.hidden, true);
});

// ページ送りの段組みを模した段落：幅 300 のページが横に並び、段落 5 は 2 ページ目と 3 ページ目にまたがる
function pagedText(app) {
  const columns = [[0], [0], [0], [1], [1], [1, 2], [2], [2], [3], [3]];
  const paragraphs = columns.map((cols) => Object.assign(new Element(), {
    getClientRects: () => cols.map((col) => ({ left: col * 300 + 24, right: col * 300 + 276, width: 252, height: 100 })),
  }));
  const text = app.element('text');
  text.getBoundingClientRect = () => ({ left: 0, width: 300, height: 600 });
  text.lastElementChild = paragraphs[paragraphs.length - 1];
  app.element('works-dialog').open = false;
  app.element('settings').hidden = true;
  app.element('mode-select').value = 'paged';
  app.element('mode-select').events.change();
  app.api.seed('site:paged.txt', paragraphs);
  return paragraphs;
}
const key = (name, extra = {}) => ({ key: name, target: { closest: () => null }, preventDefault() {}, ...extra });
const pageNumber = (app) => app.element('page-number').textContent;

test('ページ送り：読書位置は段落と割合のまま、ページをまたぐ段落の途中のページにも戻れる', () => {
  const app = reader(catalog(async () => ({ ok: true, json: async () => ({}) })));
  pagedText(app);
  assert.equal(app.element('pager').hidden, false);
  app.api.restorePosition({ index: 5, ratio: 0.75 });
  assert.equal(pageNumber(app), '3 / 4');
  assert.deepEqual({ ...app.api.currentPosition() }, { index: 5, ratio: 0.5, percent: 67 });
  app.api.restorePosition({ index: 5, ratio: 0 });
  assert.equal(pageNumber(app), '2 / 4');
  assert.equal(app.api.currentPosition().index, 3);
  app.api.showHome();
  assert.equal(app.element('pager').hidden, true);
});

test('ページ送り：キー・左右のタップでめくり、最初と最後より先へは進まない', () => {
  const app = reader(catalog(async () => ({ ok: true, json: async () => ({}) })));
  pagedText(app);
  app.api.restorePosition({ index: 0, ratio: 0 });
  app.document.events.keydown(key('ArrowRight'));
  assert.equal(pageNumber(app), '2 / 4');
  app.document.events.keydown(key(' ', { shiftKey: true }));
  assert.equal(pageNumber(app), '1 / 4');
  app.document.events.keydown(key('ArrowLeft'));
  assert.equal(pageNumber(app), '1 / 4');
  app.document.events.keydown(key('End'));
  assert.equal(pageNumber(app), '4 / 4');
  app.document.events.keydown(key('PageDown'));
  assert.equal(pageNumber(app), '4 / 4');
  // 入力欄・選択肢で押したキーは、その操作に任せる
  app.document.events.keydown(key('ArrowLeft', { target: { closest: (selector) => (selector.includes('select') ? {} : null) } }));
  assert.equal(pageNumber(app), '4 / 4');
  const main = app.element('main');
  main.events.click({ clientX: 100, target: { closest: () => null } }); // 左 3 割
  assert.equal(pageNumber(app), '3 / 4');
  main.events.click({ clientX: 700, target: { closest: () => null } }); // 右 3 割
  assert.equal(pageNumber(app), '4 / 4');
  main.events.click({ clientX: 400, target: { closest: () => null } }); // 真ん中はめくらない
  assert.equal(pageNumber(app), '4 / 4');
  main.events.click({ clientX: 100, target: { closest: (selector) => (selector.includes('a') ? {} : null) } }); // リンクはめくらない
  assert.equal(pageNumber(app), '4 / 4');
});

test('ページ送り：バーは動かしている間は番号だけを変え、離すと移って「元のページに戻る」を出す', () => {
  const app = reader(catalog(async () => ({ ok: true, json: async () => ({}) })));
  pagedText(app);
  app.api.restorePosition({ index: 9, ratio: 0 });
  const seek = app.element('page-seek');
  assert.equal(seek.max, '4');
  assert.equal(seek.value, '4');
  seek.value = '1';
  seek.events.input();
  assert.equal(pageNumber(app), '1 / 4');
  assert.equal(app.api.currentPosition().index, 8); // まだ移っていない
  seek.events.change();
  assert.equal(app.api.currentPosition().index, 0);
  assert.equal(app.element('page-undo').hidden, false);
  assert.equal(app.element('page-undo-button').textContent, '元のページ（4）に戻る');
  app.element('page-undo-button').events.click();
  assert.equal(pageNumber(app), '4 / 4');
  assert.equal(app.element('page-undo').hidden, true);
  // 1 ページだけの移動（バーを矢印キーで動かしたときなど）では出さない
  seek.value = '3';
  seek.events.change();
  assert.equal(pageNumber(app), '3 / 4');
  assert.equal(app.element('page-undo').hidden, true);
});

test('ページ送り：続けてクリックしても単語を選ばず、1 回目の押し下げ（ドラッグでの選択）は止めない', () => {
  const app = reader(catalog(async () => ({ ok: true, json: async () => ({}) })));
  pagedText(app);
  const press = (detail) => {
    let prevented = false;
    app.element('main').events.mousedown({ detail, target: { closest: () => null }, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(press(1), false);
  assert.equal(press(2), true);
  assert.equal(press(3), true);
});
