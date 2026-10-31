// 一度開いたページと作品を、通信できないときにも開けるようにする Service Worker（reader.js が登録する）。
// - ページ（HTML）・本文・目録などは、まず通信して最新を使い、保存し直す。通信できないときや
//   4 秒たっても返事がないときは、保存してあるものを使う（更新を公開したら、通信できればすぐ反映される）
// - URL に内容のハッシュ（?v=…、tools/build_site.py が付ける）のある CSS・JavaScript・アイコンは
//   中身が変わらないので、保存してあればそれを使う。新しい版を保存したら、同じファイルの古い版は消す
// 保存の仕方を変えたときは CACHE の番号を上げる（古い保存はまとめて消える）
'use strict';

const CACHE = 'aozora-reader-v1';
const NETWORK_TIMEOUT = 4000;
// 最初に保存しておくもの。ほかに、トップの HTML が読み込むファイルも保存する
const PRECACHE = ['./', 'texts/index.json', 'data/authors.json'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const path of PRECACHE) await store(cache, new URL(path, self.registration.scope).href);
    const html = await cache.match(new URL('./', self.registration.scope).href);
    if (html) {
      for (const url of assetsOf(await html.text(), self.registration.scope)) await store(cache, url);
    }
    // 初めて開いたときは、本文を読み込んだあとにこれが動き始めるので、開いている作品の本文もここで保存する
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      const file = new URL(client.url).searchParams.get('text');
      if (file && /^[\w.-]+\.txt$/.test(file)) await store(cache, new URL('texts/' + file, self.registration.scope).href);
    }
    // 前の版の Service Worker が動いていても、すぐ入れ替わる（ページは毎回通信して最新を取るので、混ざっても困らない）
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE && name.startsWith('aozora-reader-')) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // 青空文庫の zip など、ほかのサイトへの通信と、GET 以外・範囲指定の取得には手を出さない
  if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('range')) return;
  if (request.mode === 'navigate') {
    // ?text=… や #book=… の違いは同じページとして保存する
    event.respondWith(networkFirst(event, request, url.origin + url.pathname));
  } else if (url.searchParams.has('v')) {
    event.respondWith(cacheFirst(request, url));
  } else {
    event.respondWith(networkFirst(event, request, url.href));
  }
});

// HTML の src・href から、同じサイトの中のファイルを取り出す
function assetsOf(html, base) {
  const urls = new Set();
  for (const match of html.matchAll(/\s(?:src|href)="([^"#]+)"/g)) {
    const url = new URL(match[1].replace(/&amp;/g, '&'), base);
    if (url.origin === new URL(base).origin && !/\.html?$/.test(url.pathname) && url.href !== base) urls.add(url.href);
  }
  return urls;
}

async function store(cache, url) {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (response.ok) await cache.put(url, response);
  } catch {
    // 保存できなかったものは、次に開いたときに保存する
  }
}

async function networkFirst(event, request, key) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      event.waitUntil(cache.put(key, copy));
    }
    return response;
  });
  network.catch(() => {}); // 先に保存分を返したあとの失敗は捨てる
  const slow = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT));
  try {
    return await Promise.race([network, slow.then(async () => (await cache.match(key)) || network)]);
  } catch (error) {
    const saved = await cache.match(key);
    if (saved) return saved;
    throw error;
  }
}

async function cacheFirst(request, url) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    // 同じファイルの古い版（?v= の違うもの）を消してから保存する
    for (const old of await cache.keys()) {
      const oldUrl = new URL(old.url);
      if (oldUrl.pathname === url.pathname && oldUrl.href !== url.href) await cache.delete(old);
    }
    await cache.put(request, response.clone());
  }
  return response;
}
