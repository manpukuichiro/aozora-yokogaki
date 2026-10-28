// 青空文庫の全作品の目録（data/catalog.json、tools/build_catalog.py が生成）の読み込みと検索。
// 目録は 2MB 余りあるので、検索を始めたときなど必要になってから一度だけ読み込む。
const Catalog = (() => {
  'use strict';

  const URL_PATH = 'data/catalog.json';
  const CARDS = 'https://www.aozora.gr.jp/cards/';

  let loading = null;
  let loaded = false;
  let works = [];
  let byId = new Map();

  // 検索用の正規化：全角半角・大文字小文字・カタカナとひらがなの違いと、空白・中黒を無視する
  function normalize(text) {
    return (text || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
      .replace(/[\s・･]/g, '');
  }

  function terms(query) {
    return (query || '').normalize('NFKC').split(/\s+/).map(normalize).filter(Boolean);
  }

  function matches(work, words) {
    const fields = [work.title, work.subtitle, work.titleYomi, work.author,
      work.authorYomi, work.translator, work.translatorYomi].map(normalize);
    return words.every((word) => fields.some((field) => field.includes(word)));
  }

  function load() {
    if (!loading) {
      // 公開の更新直後に古い目録を使わないよう、毎回サーバーに更新を確かめる（変わっていなければ 304 で軽い）
      loading = fetch(URL_PATH, { cache: 'no-cache' })
        .then((response) => {
          if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
          return response.json();
        })
        .then((data) => {
          const index = Object.fromEntries(data.fields.map((name, i) => [name, i]));
          works = data.works.map((row) => {
            const work = {
              workId: row[index.id],
              title: row[index.title],
              titleYomi: row[index.titleYomi],
              subtitle: row[index.subtitle],
              author: row[index.author],
              authorYomi: row[index.authorYomi],
              translator: row[index.translator],
              kana: data.kanaTypes[row[index.kana]] || '',
              copyright: row[index.copyright] === 1,
              // アクセスランキングの順位（ランキング外と、順位のない古い目録は 0）
              rank: row[index.rank] || 0,
              card: CARDS + row[index.dir] + '/card' + Number(row[index.id]) + '.html',
              zip: row[index.zip] ? CARDS + row[index.dir] + '/files/' + row[index.zip] : '',
            };
            work.titleKey = normalize(work.title + work.subtitle);
            work.titleYomiKey = normalize(work.titleYomi);
            work.authorKey = normalize(work.author + work.authorYomi + work.translator);
            return work;
          });
          byId = new Map(works.map((work) => [work.workId, work]));
          loaded = true;
          return works.length;
        })
        .catch((error) => {
          loading = null; // 次の検索でやり直せるようにする
          throw error;
        });
    }
    return loading;
  }

  function isLoaded() {
    return loaded;
  }

  // order が 'popular'（人気順）なら、アクセスランキングの順位がある作品を順位の順に先に出し、
  // 残りは作品名の完全一致、著者（「漱石」で夏目漱石の作品）、作品名の前方一致、途中一致の順に並べる。
  // 'kana'（50音順）なら、目録の並び（作品名の読みの順）のまま。
  // author を指定すると、著者名がそれと一致する作品だけにする（作品名などに著者名を含む他の著者の作品は除く）
  function search(query, { exclude = () => false, author = null, order = 'popular' } = {}) {
    const words = terms(query);
    if (!words.length) return [];
    const ranked = [];
    for (const work of works) {
      if (author !== null && work.author !== author) continue;
      if (!matches(work, words)) continue;
      if (exclude(work)) continue;
      const relevance = words.reduce((sum, key) => {
        if (work.titleKey === key || work.titleYomiKey === key) return sum;
        if (work.authorKey.includes(key)) return sum + 1;
        if (work.titleKey.startsWith(key) || work.titleYomiKey.startsWith(key)) return sum + 2;
        return sum + 3;
      }, 0);
      ranked.push([work.rank || Infinity, relevance, work]);
    }
    // sort は安定なので、同じ値の作品は目録の並びのまま
    if (order === 'popular') ranked.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    return ranked.map(([, , work]) => work);
  }
  function get(workId) {
    return byId.get(workId) || null;
  }

  // 配布 zip のファイル名（例 773_ruby_5968.zip）から作品ID を取り出す。
  // 同じ名前のファイルがあるとブラウザが付ける「 (1)」も許す
  function workIdFromFileName(name) {
    const match = /^(\d+)_(?:ruby|txt)(?:_\d+)?(?:\s*\(\d+\))?\.zip$/i.exec(name);
    return match ? match[1].padStart(6, '0') : null;
  }

  return { load, isLoaded, search, get, normalize, terms, matches, workIdFromFileName, count: () => works.length };
})();
