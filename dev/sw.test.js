// sw.js（通信できないときにも開けるようにする Service Worker）の回帰テスト。
// ブラウザの caches・fetch を最小限の代替に置き換えて、保存と取り出しの決まりを確かめる
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCOPE = 'https://example.test/aozora/';
const keyOf = (request) => (typeof request === 'string' ? request : request.url);
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 404, type: 'basic', body, clone() { return response(body, ok); }, text: async () => body });

function worker(files, openPages = []) {
  const stores = new Map();
  const cacheOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      put: async (request, value) => { entries.set(keyOf(request), value); },
      match: async (request) => entries.get(keyOf(request)),
      keys: async () => [...entries.keys()].map((url) => ({ url })),
      delete: async (request) => entries.delete(keyOf(request)),
    };
  };
  const net = { online: true, hang: false, requests: [] };
  const listeners = {};
  const context = vm.createContext({
    URL,
    setTimeout: (fn) => setImmediate(fn), // 返事の遅い通信を待たずに確かめる
    caches: { open: async (name) => cacheOf(name), keys: async () => [...stores.keys()], delete: async (name) => stores.delete(name) },
    fetch: (request) => {
      const url = keyOf(request);
      net.requests.push(url);
      if (net.hang) return new Promise(() => {});
      if (!net.online) return Promise.reject(new TypeError('offline'));
      // 本物のサーバーと同じく、ページの ?text=… は無視して同じ HTML を返す
      const page = url.replace(/\?text=.*$/, '');
      return Promise.resolve(page in files ? response(files[page]) : response('', false));
    },
    self: {
      registration: { scope: SCOPE },
      location: { origin: new URL(SCOPE).origin },
      clients: { claim: async () => {}, matchAll: async () => openPages.map((url) => ({ url })) },
      skipWaiting: async () => {},
      addEventListener: (name, fn) => { listeners[name] = fn; },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), context);

  const lifecycle = async (name) => {
    let work;
    listeners[name]({ waitUntil: (promise) => { work = promise; } });
    await work;
  };
  // 何もしなければ undefined（ブラウザに任せる）、取り出したものはその本文
  const request = async (url, mode = 'no-cors') => {
    let answer;
    const waits = [];
    listeners.fetch({
      request: { url, method: 'GET', mode, headers: { has: () => false } },
      respondWith: (promise) => { answer = promise; },
      waitUntil: (promise) => waits.push(promise),
    });
    if (!answer) return undefined;
    const result = await answer;
    await Promise.all(waits);
    return result.body;
  };
  const cached = (url) => stores.get('aozora-reader-v1')?.has(url) ?? false;
  return { lifecycle, request, cached, net, stores };
}

const HTML = '<link rel="stylesheet" href="style.css?v=aaa"><link rel="icon" href="favicon.svg">'
  + '<a href="NOTICE.html">権利</a><a href="./">ホーム</a><a href="https://www.aozora.gr.jp/">青空文庫</a>'
  + '<script src="reader.js?v=bbb"></script>';
const FILES = {
  [SCOPE]: HTML,
  [SCOPE + 'texts/index.json']: '[]',
  [SCOPE + 'data/authors.json']: '[]',
  [SCOPE + 'style.css?v=aaa']: 'css',
  [SCOPE + 'favicon.svg']: 'svg',
  [SCOPE + 'reader.js?v=bbb']: 'js',
  [SCOPE + 'texts/aozora_000001.txt']: '本文',
};

test('入れたときに、トップの HTML とそれが読み込むファイル・作品一覧を保存する（ほかのページと外部は除く）', async () => {
  const sw = worker(FILES);
  await sw.lifecycle('install');
  for (const url of [SCOPE, SCOPE + 'texts/index.json', SCOPE + 'data/authors.json', SCOPE + 'style.css?v=aaa', SCOPE + 'favicon.svg', SCOPE + 'reader.js?v=bbb']) {
    assert.ok(sw.cached(url), url);
  }
  assert.equal(sw.cached(SCOPE + 'NOTICE.html'), false);
  assert.ok(!sw.net.requests.some((url) => url.startsWith('https://www.aozora.gr.jp')));
});

test('ページと本文は通信を優先し、通信できないときや返事が遅いときは保存分を使う', async () => {
  const sw = worker(FILES);
  await sw.lifecycle('install');
  assert.equal(await sw.request(SCOPE + 'texts/aozora_000001.txt'), '本文');
  assert.ok(sw.cached(SCOPE + 'texts/aozora_000001.txt'));
  sw.net.online = false;
  // ?text=… のついたページも、保存したトップの HTML で開ける
  assert.equal(await sw.request(SCOPE + '?text=aozora_000001.txt', 'navigate'), HTML);
  assert.equal(await sw.request(SCOPE + 'texts/aozora_000001.txt'), '本文');
  await assert.rejects(sw.request(SCOPE + 'texts/aozora_999999.txt')); // 開いたことのない作品は読めない
  sw.net.online = true;
  sw.net.hang = true;
  assert.equal(await sw.request(SCOPE + 'texts/aozora_000001.txt'), '本文');
});

test('通信できれば新しい版を返して保存し直す', async () => {
  const files = { ...FILES };
  const sw = worker(files);
  await sw.lifecycle('install');
  files[SCOPE] = '新しい HTML';
  assert.equal(await sw.request(SCOPE + '?text=aozora_000001.txt', 'navigate'), '新しい HTML');
  sw.net.online = false;
  assert.equal(await sw.request(SCOPE, 'navigate'), '新しい HTML');
});

test('ハッシュ付きのファイルは保存分を使い、新しい版を保存したら同じファイルの古い版を消す', async () => {
  const files = { ...FILES, [SCOPE + 'reader.js?v=ccc']: 'new js' };
  const sw = worker(files);
  await sw.lifecycle('install');
  sw.net.requests.length = 0;
  assert.equal(await sw.request(SCOPE + 'reader.js?v=bbb'), 'js');
  assert.equal(sw.net.requests.length, 0);
  assert.equal(await sw.request(SCOPE + 'reader.js?v=ccc'), 'new js');
  assert.ok(sw.cached(SCOPE + 'reader.js?v=ccc'));
  assert.equal(sw.cached(SCOPE + 'reader.js?v=bbb'), false);
  assert.ok(sw.cached(SCOPE + 'style.css?v=aaa'));
});

test('ほかのサイト（青空文庫の zip など）への通信には手を出さず、古い保存の入れ物は消す', async () => {
  const sw = worker(FILES);
  assert.equal(await sw.request('https://www.aozora.gr.jp/cards/000148/files/773_ruby_5968.zip'), undefined);
  sw.stores.set('aozora-reader-v0', new Map());
  sw.stores.set('other-site', new Map());
  await sw.lifecycle('activate');
  assert.deepEqual([...sw.stores.keys()].sort(), ['other-site']);
});

test('初めて開いたときに表示中の作品も保存し、変なファイル名は保存しない', async () => {
  const sw = worker(FILES, [SCOPE + '?text=aozora_000001.txt', SCOPE + '?text=../secret.txt', SCOPE + '#book=abc']);
  await sw.lifecycle('install');
  assert.ok(sw.cached(SCOPE + 'texts/aozora_000001.txt'));
  assert.ok(!sw.net.requests.some((url) => url.includes('secret')));
});
