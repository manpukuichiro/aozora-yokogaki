(() => {
  'use strict';

  const STORAGE_PREFIX = globalThis.ReaderData?.prefix || 'aozora-reader:';
  const TEXT_DIR = 'texts/';
  const CATALOG_URL = TEXT_DIR + 'index.json';
  // texts/ 直下の .txt だけを読み込み対象にする
  const SAFE_FILE = /^[\w.\-]+\.txt$/;
  // 本棚（このブラウザに読み込んだ作品）の作品を表す値の接頭辞
  const LIB_PREFIX = 'lib:';

  const DEFAULTS = { fontSize: 18, lineHeight: 1.9, measure: 36, font: 'mincho', weight: 400, ruby: 'on', theme: 'auto' };
  const STEPS = {
    fontSize: { step: 1, min: 12, max: 32, format: (v) => v + 'px' },
    lineHeight: { step: 0.1, min: 1.3, max: 2.8, format: (v) => v.toFixed(1) },
    measure: { step: 2, min: 20, max: 60, format: (v) => v + '字' },
  };

  const MINCHO_FALLBACK = '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "Noto Serif CJK JP", serif';
  const GOTHIC_FALLBACK = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans CJK JP", sans-serif';
  // 端末に入っているフォントだけを使う（外部からフォントは読み込まない）。
  // OS にある太さが使われ、ない太さは近いものに置き換わる。
  // 以前選べた Web フォント（Noto・BIZ UD）を保存している場合は、currentFont() が既定の明朝に戻す
  const FONTS = {
    mincho: { label: '明朝', family: MINCHO_FALLBACK, weights: [300, 400, 500, 600, 700] },
    gothic: { label: 'ゴシック', family: GOTHIC_FALLBACK, weights: [300, 400, 500, 600, 700] },
  };
  const WEIGHT_NAMES = { 100: '極細', 200: '細', 300: 'やや細', 400: '標準', 500: '中', 600: 'やや太', 700: '太', 800: '極太', 900: '最も太い' };

  const root = document.documentElement;
  const textEl = document.getElementById('text');
  const toolbar = document.getElementById('toolbar');
  const currentWorkButton = document.getElementById('works-open');
  const currentTitleEl = document.getElementById('current-title');
  const cardLink = document.getElementById('card-link');
  const homeEl = document.getElementById('home');
  const worksDialog = document.getElementById('works-dialog');
  const worksSearch = document.getElementById('works-search');
  const worksList = document.getElementById('works-list');
  const fileInput = document.getElementById('file-input');
  const progressEl = document.getElementById('progress');
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsPanel = document.getElementById('settings');
  const fontSelect = document.getElementById('font-select');
  const weightSelect = document.getElementById('weight-select');
  const themeSelect = document.getElementById('theme-select');
  const rubySelect = document.getElementById('ruby-select');
  const tocOpenButton = document.getElementById('toc-open');
  const tocDialog = document.getElementById('toc-dialog');
  const tocList = document.getElementById('toc-list');

  let settings = { ...DEFAULTS, ...loadJSON('settings') };
  let currentKey = null; // 読書位置の保存キー
  let siteWorks = []; // texts/index.json の収録作品
  let paragraphs = [];
  let saveTimer = 0;
  let scrollQueued = false;
  let lastPosition = null; // 最後に確定した読書位置（リサイズ時の復元用）

  // ---- localStorage（使えない環境でも本文表示は続ける） ----

  function loadJSON(name) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + name);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveJSON(name, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(value));
    } catch {
      const notice = document.getElementById('storage-warning');
      notice.hidden = false;
      notice.textContent = '読書位置・設定を保存できません。ブラウザの保存設定と空き容量を確認してください。';
    }
  }

  // ---- フォント ----

  function populateFontSelect() {
    for (const [id, font] of Object.entries(FONTS)) fontSelect.append(new Option(font.label, id));
  }

  // 選んだ太さがそのフォントにない場合は一番近い太さを使う（設定値自体は残し、フォントを戻したら復活させる）
  function currentWeight() {
    const { weights } = currentFont();
    return weights.reduce((best, w) => (Math.abs(w - settings.weight) < Math.abs(best - settings.weight) ? w : best));
  }

  function populateWeightSelect() {
    const options = currentFont().weights.map((w) => new Option(WEIGHT_NAMES[w] + '（' + w + '）', String(w)));
    weightSelect.replaceChildren(...options);
    weightSelect.value = String(currentWeight());
  }

  function currentFont() {
    return FONTS[settings.font] || FONTS[DEFAULTS.font];
  }

  // ---- 表示設定 ----

  function applySettings() {
    const font = currentFont();
    const weight = currentWeight();
    root.style.setProperty('--font-size', settings.fontSize + 'px');
    root.style.setProperty('--line-height', String(settings.lineHeight));
    root.style.setProperty('--measure', settings.measure + 'em');
    root.style.setProperty('--font-family', font.family);
    root.style.setProperty('--font-weight', String(weight));
    root.dataset.theme = settings.theme;
    root.dataset.ruby = settings.ruby;
    for (const name of Object.keys(STEPS)) {
      document.getElementById(name + '-value').textContent = STEPS[name].format(settings[name]);
    }
    fontSelect.value = FONTS[settings.font] ? settings.font : DEFAULTS.font;
    populateWeightSelect();
    themeSelect.value = settings.theme;
    rubySelect.value = settings.ruby;
    updateThemeColor();
  }

  // スマホのブラウザのアドレスバーなどの色を、ページの背景色（配色）に合わせる
  function updateThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta || typeof getComputedStyle !== 'function') return;
    const background = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (background) meta.setAttribute('content', background);
  }

  // 位置を保ったまま設定を変える
  function changeSettings(patch) {
    const position = currentPosition();
    settings = { ...settings, ...patch };
    saveJSON('settings', settings);
    applySettings();
    relayoutRuby();
    if (position) restorePosition(position);
  }

  settingsPanel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-step]');
    if (!button) return;
    const name = button.dataset.step;
    const { step, min, max } = STEPS[name];
    const next = settings[name] + step * Number(button.dataset.dir);
    // 0.1 刻みの浮動小数誤差を丸める
    const rounded = Math.round(Math.min(max, Math.max(min, next)) * 10) / 10;
    if (rounded !== settings[name]) changeSettings({ [name]: rounded });
  });

  fontSelect.addEventListener('change', () => changeSettings({ font: fontSelect.value }));
  weightSelect.addEventListener('change', () => changeSettings({ weight: Number(weightSelect.value) }));
  themeSelect.addEventListener('change', () => changeSettings({ theme: themeSelect.value }));
  rubySelect.addEventListener('change', () => changeSettings({ ruby: rubySelect.value }));
  document.getElementById('reset-settings').addEventListener('click', () => changeSettings({ ...DEFAULTS }));

  settingsToggle.addEventListener('click', () => {
    const open = settingsPanel.hidden;
    settingsPanel.hidden = !open;
    settingsToggle.setAttribute('aria-expanded', String(open));
  });

  // ---- 本文の読み込みと描画 ----

  // UTF-8 を優先し、不正なバイト列なら Shift_JIS（青空文庫の配布形式）として読む
  function decode(buffer) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return new TextDecoder('shift_jis').decode(buffer);
    }
  }

  function showStatus(message, isError) {
    showReader();
    textEl.replaceChildren();
    const p = document.createElement('p');
    p.className = isError ? 'status error' : 'status';
    p.textContent = message;
    textEl.append(p);
    paragraphs = [];
    buildToc();
    updateProgress();
  }

  function render(raw) {
    const prepared = AozoraText.prepare(raw);
    // 末尾の空行は描画しない
    const text = prepared.text.replace(/\s+$/, '');

    if (prepared.aozora) {
      textEl.replaceChildren(AozoraText.render(document, text, prepared.gaiji));
    } else {
      const fragment = document.createDocumentFragment();
      for (const line of text.split('\n')) {
        const p = document.createElement('p');
        if (line.trim() === '') {
          p.className = 'blank';
        } else {
          p.textContent = line;
        }
        fragment.append(p);
      }
      textEl.replaceChildren(fragment);
    }
    // 罫囲みの中の段落も含めて、読書位置は p 単位で数える
    paragraphs = Array.from(textEl.querySelectorAll('p'));
  }

  function openText(key, title, text) {
    showReader();
    currentKey = key;
    lastPosition = null;
    render(text);
    document.getElementById('reader-status').textContent = title + 'を開きました。';
    watchRuby();
    buildToc();
    rememberRecent(key.startsWith('site:') ? key.slice(5) : key);
    document.title = title + ' — 横書き青空文庫ブラウザ版';
    const saved = loadJSON('pos:' + key);
    if (saved) {
      restorePosition(saved);
    } else {
      window.scrollTo(0, 0);
    }
    updateProgress();
  }

  // 読み込み中に別の作品が選ばれたら、古い結果は捨てる
  let loadToken = 0;

  async function loadWork(file, title) {
    if (!SAFE_FILE.test(file)) {
      showStatus('ファイル名が不正です: ' + file, true);
      return;
    }
    const token = ++loadToken;
    currentKey = null;
    showStatus('読み込み中…');
    try {
      // index.json と食い違う古い本文を使わないよう、毎回サーバーに更新を確かめる
      const response = await fetch(TEXT_DIR + file, { cache: 'no-cache' });
      if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
      const text = decode(await response.arrayBuffer());
      if (token === loadToken) openText('site:' + file, title || file, text);
    } catch (error) {
      if (token === loadToken) showStatus('本文を読み込めませんでした（' + file + '）: ' + error.message, true);
    }
  }

  async function openBook(id, title) {
    const token = ++loadToken;
    currentKey = null;
    showStatus('読み込み中…');
    try {
      const text = await Library.getText(id);
      if (text === null) throw new Error('本棚に見つかりません');
      if (token !== loadToken) return;
      openText(LIB_PREFIX + id, title, text);
    } catch (error) {
      if (token === loadToken) showStatus('本棚の作品を開けませんでした: ' + error.message, true);
    }
  }

  async function loadCatalog() {
    try {
      const response = await fetch(CATALOG_URL, { cache: 'no-cache' });
      if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
      const works = await response.json();
      return Array.isArray(works) ? works.filter((w) => w && SAFE_FILE.test(w.file)) : [];
    } catch (error) {
      console.warn('作品を探す（texts/index.json）を読み込めませんでした', error);
      return [];
    }
  }

  function titleOf(work) {
    return work.author ? work.title + '（' + work.author + '）' : work.title || work.file;
  }

  // ---- 作品を探す（本棚＋収録作品＋全作品の検索）のポップアップ ----

  let books = []; // 本棚（このブラウザに読み込んだ作品）
  let currentValue = null; // 開いている作品（収録作品はファイル名、本棚は lib:ID）
  let shelfOnly = false;

  async function refreshLibrary() {
    try {
      books = await Library.list();
    } catch (error) {
      console.warn('本棚を読み込めませんでした', error);
      books = [];
    }
    return books;
  }

  function workOf(value) {
    if (value.startsWith(LIB_PREFIX)) return books.find((book) => LIB_PREFIX + book.id === value) || null;
    return siteWorks.find((work) => work.file === value) || null;
  }

  function setCurrentWork(value, title) {
    currentValue = value;
    currentTitleEl.textContent = title || '作品を選ぶ';
    // 収録作品は index.json に図書カードの URL がある。本棚の作品にはないのでリンクを隠す
    const work = value ? workOf(value) : null;
    const card = work && /^https:\/\/www\.aozora\.gr\.jp\//.test(work.card || '') ? work.card : null;
    // 幅の狭い画面では、表示設定の「その他」にある同じリンクを使う
    for (const link of [cardLink, document.getElementById('card-link-narrow')]) {
      link.hidden = !card;
      if (card) link.href = card;
      else link.removeAttribute('href');
    }
  }

  function workButton(value, work, { showAuthor, rank }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'work-item';
    if (value === currentValue) button.setAttribute('aria-current', 'true');
    if (rank) {
      const number = document.createElement('span');
      number.className = 'work-rank';
      number.textContent = rank;
      button.append(number);
    }
    const title = document.createElement('span');
    title.className = 'work-title';
    // 副題の先頭の巻番号（「01 第一部上」の 01）は外し、題名と同じ副題は出さない
    const subtitle = (work.subtitle || '').replace(/^\d+\s+/, '');
    title.textContent = work.title + (subtitle && subtitle !== work.title ? '　' + subtitle : '');
    button.append(title);
    const meta = [showAuthor ? work.author : '', work.translator ? work.translator + ' 訳' : ''].filter(Boolean).join('　');
    if (meta) {
      const author = document.createElement('span');
      author.className = 'work-author';
      author.textContent = meta;
      button.append(author);
    }
    button.addEventListener('click', () => {
      worksDialog.close();
      selectWork(value);
    });
    return button;
  }

  function section(label, count) {
    const heading = document.createElement('h3');
    heading.className = 'works-section';
    heading.textContent = label + (count === undefined ? '' : '（' + count + '）');
    return heading;
  }

  function shelfItem(book, home = false) {
    const row = document.createElement('div');
    row.className = 'shelf-item' + (home ? ' shelf-item-home' : '');
    const value = LIB_PREFIX + book.id;
    const open = home ? homeWorkButton(value, book) : workButton(value, book, { showAuthor: true });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button shelf-remove';
    remove.textContent = '削除';
    remove.setAttribute('aria-label', titleOf(book) + 'を本棚から削除');
    remove.addEventListener('click', () => removeBook(book));
    row.append(open, remove);
    return row;
  }

  function renderWorksList() {
    const words = Catalog.terms(worksSearch.value);
    const matches = (work) => Catalog.matches(work, words);
    const byAuthor = document.querySelector('input[name="works-order"]:checked').value === 'author';
    const nodes = [];

    const shelf = books.filter(matches);
    if (shelf.length) {
      nodes.push(section('本棚', shelf.length));
      for (const book of shelf) nodes.push(shelfItem(book));
    }
    if (shelfOnly) {
      if (!shelf.length) nodes.push(note(words.length ? '本棚に当てはまる作品はありません。' : '本棚に作品はありません。「ファイルを開く…」から追加できます。'));
      worksList.replaceChildren(...nodes);
      return;
    }

    const bundled = siteWorks.filter(matches);
    if (bundled.length && !byAuthor) {
      nodes.push(section('収録作品・人気順', bundled.length));
      for (const work of bundled) nodes.push(workButton(work.file, work, { showAuthor: true, rank: work.rank }));
    } else if (bundled.length) {
      const authors = new Map();
      for (const work of bundled) {
        if (!authors.has(work.author)) authors.set(work.author, { yomi: work.authorYomi || work.author, works: [] });
        authors.get(work.author).works.push(work);
      }
      const sorted = [...authors].sort((a, b) => a[1].yomi.localeCompare(b[1].yomi, 'ja'));
      for (const [author, { works }] of sorted) {
        nodes.push(section(author, works.length));
        works.sort((a, b) => (a.titleYomi || a.title).localeCompare(b.titleYomi || b.title, 'ja'));
        for (const work of works) nodes.push(workButton(work.file, work, { showAuthor: false }));
      }
    }

    nodes.push(...catalogNodes(words.length > 0));
    worksList.replaceChildren(...nodes);
  }

  // ---- 青空文庫の全作品から探す（data/catalog.json） ----

  const CATALOG_PAGE = 50;
  let catalogShown = CATALOG_PAGE;
  let catalogFailed = false;
  let catalogPending = false;

  function note(text, className = 'works-empty') {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text;
    return p;
  }

  function catalogNodes(query) {
    if (!query) {
      return [note('作品名や著者名で検索すると、ここに収録されていない青空文庫の全作品（約 1 万 8 千作品）からも探せます。', 'works-hint')];
    }
    if (!Catalog.isLoaded()) {
      if (catalogFailed) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'text-button';
        retry.textContent = '目録を再読み込み';
        retry.addEventListener('click', () => {
          catalogFailed = false;
          renderWorksList();
        });
        return [section('青空文庫の全作品から'), note('目録を読み込めませんでした。通信状態を確かめて再読み込みしてください。'), retry];
      }
      if (!catalogPending) {
        catalogPending = true;
        Catalog.load().then(
          () => {
            catalogPending = false;
            catalogFailed = false;
            if (worksDialog.open) renderWorksList();
          },
          (error) => {
            catalogPending = false;
            console.warn('目録を読み込めませんでした', error);
            catalogFailed = true;
            if (worksDialog.open) renderWorksList();
          },
        );
      }
      return [section('青空文庫の全作品から'), note('目録を読み込んでいます…')];
    }

    // 収録作品と本棚にある作品は上に出ているので、ここでは除く
    const shown = new Set([...siteWorks.map((work) => work.workId), ...books.map((book) => book.workId)].filter(Boolean));
    const results = Catalog.search(worksSearch.value, { exclude: (work) => shown.has(work.workId) });
    const nodes = [section('青空文庫から探す', results.length)];
    if (!results.length) {
      nodes.push(note('「' + worksSearch.value + '」に当てはまる作品はありません。'));
      return nodes;
    }
    nodes.push(note(touchScreen.matches
      ? '「zip をダウンロード」で青空文庫からテキストを保存し、その下に出る「開く…」から選ぶと読めます。'
      : '「zip をダウンロード」で青空文庫からテキストを保存し、この画面にドラッグ＆ドロップすると読めます。', 'works-hint'));
    for (const work of results.slice(0, catalogShown)) nodes.push(catalogItem(work));
    if (results.length > catalogShown) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'text-button works-more';
      more.textContent = 'さらに表示（残り ' + (results.length - catalogShown) + ' 件）';
      more.addEventListener('click', () => {
        const scrollTop = worksList.scrollTop;
        catalogShown += CATALOG_PAGE;
        renderWorksList();
        worksList.scrollTop = scrollTop;
      });
      nodes.push(more);
    }
    return nodes;
  }

  function catalogItem(work) {
    const item = document.createElement('div');
    item.className = 'catalog-item';
    const text = document.createElement('div');
    text.className = 'catalog-text';
    const title = document.createElement('span');
    title.className = 'work-title';
    title.textContent = work.title + (work.subtitle ? '　' + work.subtitle : '');
    const meta = document.createElement('span');
    meta.className = 'work-author';
    meta.textContent = [work.author, work.translator ? work.translator + ' 訳' : '', work.kana].filter(Boolean).join('　');
    text.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'catalog-actions';
    if (work.zip) {
      // 同じタブのままダウンロードする（新しいタブで開くと、iOS では空のタブが残る）
      const download = document.createElement('a');
      download.href = work.zip;
      download.download = '';
      download.textContent = 'zip をダウンロード';
      download.addEventListener('click', () => showOpenAfterDownload(item));
      actions.append(download);
    } else {
      actions.append(note('テキストの zip はありません', 'catalog-missing'));
    }
    const card = document.createElement('a');
    card.href = work.card;
    card.target = '_blank';
    card.rel = 'noopener';
    card.textContent = '作品情報 ↗';
    actions.append(card);

    item.append(text, actions);
    return item;
  }

  // ダウンロードした作品の欄に、続けて開くためのボタンと案内を出す。
  // ポップアップの外の「ファイルを開く…」はポップアップ表示中は操作できないので、ここに専用の入力欄を置く
  function showOpenAfterDownload(item) {
    if (item.querySelector('.catalog-next')) return;
    const next = document.createElement('div');
    next.className = 'catalog-next';
    next.append(note(touchScreen.matches
      ? 'ダウンロードが終わったら「開く…」を押し、保存した zip を選んでください。iPhone・iPad では「ファイル」アプリの「ダウンロード」フォルダ、または選択画面の「最近使った項目」にあります。'
      : 'ダウンロードが終わったら「開く…」から zip を選ぶか、この画面にドラッグ＆ドロップしてください。', 'catalog-hint'));
    const open = document.createElement('label');
    open.className = 'file-button';
    open.textContent = '開く…';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.txt,application/zip,text/plain';
    input.hidden = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files);
      input.value = '';
      if (!files.length) return;
      worksDialog.close();
      importFiles(files);
    });
    open.append(input);
    next.append(open);
    item.append(next);
  }

  function openWorks(query, onlyShelf = false) {
    shelfOnly = onlyShelf;
    document.getElementById('works-show-all').hidden = !shelfOnly;
    document.getElementById('works-order').hidden = shelfOnly;
    if (typeof query === 'string') worksSearch.value = query;
    catalogShown = CATALOG_PAGE;
    renderWorksList();
    worksDialog.showModal();
    // タッチ操作の端末で検索欄に入ると画面キーボードが出て一覧が隠れるので、押されるまで待つ
    if (!touchScreen.matches) worksSearch.focus();
    worksList.scrollTop = 0;
    worksList.querySelector('[aria-current]')?.scrollIntoView({ block: 'center' });
  }

  currentWorkButton.addEventListener('click', () => openWorks());
  document.getElementById('works-show-all').addEventListener('click', () => openWorks());
  document.getElementById('works-close').addEventListener('click', () => worksDialog.close());
  worksDialog.addEventListener('click', (event) => {
    if (event.target === worksDialog) worksDialog.close();
  });
  worksSearch.addEventListener('input', () => {
    catalogShown = CATALOG_PAGE;
    renderWorksList();
    worksList.scrollTop = 0;
  });
  // 検索欄で Enter を押したら、いちばん上の作品を開く
  worksSearch.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    worksList.querySelector('.work-item')?.click();
  });
  for (const radio of document.querySelectorAll('input[name="works-order"]')) {
    radio.addEventListener('change', () => {
      saveJSON('worksOrder', radio.value);
      renderWorksList();
      worksList.scrollTop = 0;
    });
  }
  // 並べ方は前回のものを使う
  {
    const order = loadJSON('worksOrder');
    const radio = document.querySelector('input[name="works-order"][value="' + (order === 'author' ? 'author' : 'rank') + '"]');
    radio.checked = true;
  }

  function selectWork(value) {
    savePosition();
    const work = workOf(value);
    const title = work ? titleOf(work) : value;
    setCurrentWork(value, title);
    const url = new URL(location.href);
    if (value.startsWith(LIB_PREFIX)) {
      // 本棚の作品はこのブラウザにしかないが、再読み込みで開き直せるよう URL に ID を載せる
      const id = value.slice(LIB_PREFIX.length);
      url.searchParams.delete('text');
      url.searchParams.delete('book');
      url.hash = new URLSearchParams({ book: id }).toString();
      openBook(id, title);
    } else {
      url.searchParams.delete('book');
      url.hash = '';
      url.searchParams.set('text', value);
      loadWork(value, title);
    }
    history.replaceState(null, '', url);
  }

  // 開ける作品か（本棚の作品は、このブラウザに保存されているときだけ）
  function isAvailable(value) {
    if (typeof value !== 'string') return false;
    if (value.startsWith(LIB_PREFIX)) return books.some((book) => LIB_PREFIX + book.id === value);
    return SAFE_FILE.test(value);
  }

  // ---- ホーム（はじめに） ----

  function recentWorks() {
    const saved = loadJSON('recent');
    // 旧版の「最後の1作品」は初回に引き継ぐ。
    const values = Array.isArray(saved) ? saved : [loadJSON('last')];
    return [...new Set(values)].filter((value) => isAvailable(value) && workOf(value)).slice(0, 5);
  }

  function rememberRecent(value) {
    if (!isAvailable(value) || !workOf(value)) return;
    saveJSON('recent', [value, ...recentWorks().filter((item) => item !== value)].slice(0, 5));
    saveJSON('last', value);
  }

  function resumeButton(value) {
    const key = value.startsWith(LIB_PREFIX) ? value : 'site:' + value;
    const position = loadJSON('pos:' + key);
    const percent = position && Number.isFinite(position.percent)
      ? Math.max(0, Math.min(100, position.percent)) : 0;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'resume-card';
    const title = document.createElement('span');
    title.className = 'resume-title';
    title.textContent = titleOf(workOf(value));
    const meta = document.createElement('span');
    meta.className = 'resume-meta';
    meta.textContent = '前回の位置：' + percent + '%';
    const bar = document.createElement('span');
    bar.className = 'resume-bar';
    const fill = document.createElement('span');
    fill.style.width = percent + '%';
    bar.append(fill);
    button.append(title, meta, bar);
    button.addEventListener('click', () => selectWork(value));
    return button;
  }

  function showReader() {
    homeEl.hidden = true;
    textEl.hidden = false;
  }

  function showHome(notice) {
    if (currentKey) savePosition();
    loadToken++;
    currentKey = null;
    lastPosition = null;
    setCurrentWork(null);
    textEl.replaceChildren();
    textEl.hidden = true;
    paragraphs = [];
    watchRuby();
    buildToc();
    updateProgress();
    homeEl.hidden = false;
    renderHome(notice);
    document.title = '横書き青空文庫ブラウザ版';
    const url = new URL(location.href);
    url.searchParams.delete('text');
    url.searchParams.delete('book');
    url.hash = '';
    history.replaceState(null, '', url);
    window.scrollTo(0, 0);
  }

  function homeWorkButton(value, work) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'home-work';
    const title = document.createElement('span');
    title.className = 'home-work-title';
    title.textContent = work.title;
    button.append(title);
    if (work.author) {
      const author = document.createElement('span');
      author.className = 'home-work-author';
      author.textContent = work.author + (work.translator ? '（' + work.translator + ' 訳）' : '');
      button.append(author);
    }
    button.addEventListener('click', () => selectWork(value));
    return button;
  }

  function renderHome(notice) {
    const noticeEl = document.getElementById('home-notice');
    noticeEl.hidden = !notice;
    noticeEl.textContent = notice || '';

    const recent = recentWorks();
    document.getElementById('home-resume-section').hidden = recent.length === 0;
    document.getElementById('home-resume').replaceChildren(...recent.map(resumeButton));

    const shelfSection = document.getElementById('home-shelf-section');
    shelfSection.hidden = books.length === 0;
    document.getElementById('home-shelf').replaceChildren(...books.slice(0, 8).map((book) => shelfItem(book, true)));

    document.getElementById('home-popular').replaceChildren(...siteWorks.slice(0, 12).map((work) => homeWorkButton(work.file, work)));
    document.getElementById('home-popular-title').closest('section').hidden = siteWorks.length === 0;
    document.getElementById('home-count').textContent = String(siteWorks.length);
  }

  document.getElementById('home-link').addEventListener('click', (event) => {
    // 新しいタブで開くなどの操作はブラウザに任せる
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (worksDialog.open) worksDialog.close();
    showHome();
  });
  document.getElementById('home-browse').addEventListener('click', () => openWorks(''));
  document.getElementById('home-all').addEventListener('click', () => openWorks(''));
  document.getElementById('home-shelf-all').addEventListener('click', () => openWorks('', true));
  // ホームの検索欄：作品を探すを開いて、全作品からの結果まで表示する
  document.getElementById('home-search').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('home-search-input');
    openWorks(input.value.trim());
  });
  document.getElementById('home-file-input').addEventListener('change', (event) => {
    const input = event.target;
    const files = Array.from(input.files);
    input.value = '';
    if (files.length) importFiles(files);
  });

  // ---- 作品の読み込み（ファイル選択・ドラッグ＆ドロップ） ----

  // 青空文庫の配布 zip（例 773_ruby_5968.zip）なら、目録から正確な作品名・著者と図書カードを引く。
  // 目録にない・読み込めないときは、本文の冒頭から推定する
  async function describeImported(fileName, text, innerName) {
    const workId = Catalog.workIdFromFileName(fileName);
    if (workId) {
      try {
        await Catalog.load();
        const work = Catalog.get(workId);
        if (work) {
          const { title, subtitle, author, translator, card } = work;
          return { workId, title, subtitle, author, translator, card };
        }
      } catch (error) {
        console.warn('目録を読み込めませんでした', error);
      }
    }
    return { ...Library.describe(text, innerName), ...(workId ? { workId } : {}) };
  }

  let importing = false;
  async function importFiles(files) {
    if (importing) { alert('読み込みが終わってから、次のファイルを選んでください'); return; }
    if (files.length > 20) { alert('一度に開けるのは 20 ファイルまでです'); return; }
    importing = true;
    try {
    let opened = null;
    let unsaved = null;
    const errors = [];
    // 同時に読み込んだ作品も、読み込んだ順に本棚の上へ並ぶようにする
    let addedAt = Date.now();
    for (const file of files) {
      try {
        if (file.size > (Library.MAX_FILE_BYTES || 5242880)) throw new Error('ファイルは 5 MiB 以下にしてください');
        const buffer = await file.arrayBuffer();
        let name = file.name;
        let bytes = buffer;
        if (Library.isZip(buffer)) {
          ({ name, bytes } = await Library.extractText(buffer));
        } else if (!/\.txt$/i.test(file.name) && !file.type.startsWith('text/')) {
          throw new Error('テキストファイル（.txt）か zip を選んでください');
        }
        if (bytes.byteLength > (Library.MAX_FILE_BYTES || 5242880)) throw new Error('本文が上限を超えています');
        const text = decode(bytes);
        if (new TextEncoder().encode(text).length > (Library.MAX_FILE_BYTES || 5242880)) throw new Error('文字コード変換後の本文は UTF-8 で 5 MiB 以下にしてください');
        if (text.split('\n').length > 30000) throw new Error('本文は 30,000 行までです');
        const metadata = { ...(await describeImported(file.name, text, name)), fileName: file.name, innerName: name, addedAt: addedAt++ };
        const identity = await Library.identify(metadata, text, (existing) => confirm(
          '「' + titleOf(existing) + '」と同じファイル名ですが、本文が変わっています。\n同じ作品の更新として置き換え、読書位置を引き継ぎますか？\nキャンセルすると、別の作品として本棚に保存します。',
        ));
        const book = { ...metadata, ...identity };
        const { id } = book;
        try {
          await Library.save(book, text);
          opened = LIB_PREFIX + id;
        } catch (error) {
          console.warn('本棚に保存できませんでした', error);
          unsaved = { id, title: titleOf(book), text };
          errors.push(file.name + '：本棚に保存できませんでした。');
        }
      } catch (error) {
        errors.push(file.name + '：' + error.message);
      }
    }

    await refreshLibrary();
    if (opened) {
      selectWork(opened);
    } else if (unsaved) {
      // プライベートウィンドウなどで保存できなくても、今回は読めるようにする
      savePosition();
      loadToken++;
      setCurrentWork(null, unsaved.title);
      const url = new URL(location.href);
      url.searchParams.delete('text');
      url.searchParams.delete('book');
    url.hash = '';
      history.replaceState(null, '', url);
      openText(LIB_PREFIX + unsaved.id, unsaved.title, unsaved.text);
      errors.push('このブラウザの設定では本棚に保存できないため、今回だけ表示しています。');
    }
    if (errors.length) alert(errors.join('\n'));
    } finally { importing = false; }
  }

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    fileInput.value = '';
    if (files.length) importFiles(files);
  });

  const dropOverlay = document.getElementById('drop-overlay');
  let dragDepth = 0;
  const carriesFiles = (event) => event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    // ポップアップは最前面に出るので、開いたままだとドロップの案内が隠れる
    if (worksDialog.open) worksDialog.close();
    if (tocDialog.open) tocDialog.close();
    dropOverlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  });
  window.addEventListener('drop', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    importFiles(Array.from(event.dataTransfer.files));
  });

  // ---- 本棚からの削除 ----

  async function removeBook({ id, title }) {
    if (!confirm('「' + title + '」を本棚から削除しますか？\nこの作品の読書位置も消えます。')) return;
    try {
      await Library.remove(id);
    } catch (error) {
      alert('削除できませんでした: ' + error.message);
      return;
    }
    if (currentValue === LIB_PREFIX + id) {
      // 一覧の再読込を待つ間も、削除した本文や位置が復活しないようにする。
      currentKey = null;
      clearTimeout(saveTimer);
      loadToken++;
    }
    try {
      localStorage.removeItem(STORAGE_PREFIX + 'pos:' + LIB_PREFIX + id);
    } catch {
      // 位置が消せなくても困らない
    }
    await refreshLibrary();
    saveJSON('recent', recentWorks());
    const notice = '「' + title + '」を本棚から削除しました。';
    if (currentValue === LIB_PREFIX + id) {
      showHome(notice);
    } else if (!homeEl.hidden) {
      renderHome(notice);
    }
    if (worksDialog.open) renderWorksList();
  }

  // ---- 目次 ----

  const HEADING_LEVELS = { o: '大', naka: '中', ko: '小' };
  let toc = [];

  // 見出しの要素（aozora.js が data-heading で番号を付ける）から目次を作る。
  // Android 版と同じく、注記で宣言された見出しだけを拾う
  function buildToc() {
    const paragraphIndex = new Map(paragraphs.map((p, index) => [p, index]));
    const groups = new Map();
    for (const span of textEl.querySelectorAll('[data-heading]')) {
      const text = visibleText(span);
      const p = span.closest('p');
      if (!text || !paragraphIndex.has(p)) continue;
      let group = groups.get(span.dataset.heading);
      if (!group) {
        const level = /az-(?:midashi|mado)-(o|naka|ko)/.exec(span.className);
        group = { title: '', index: paragraphIndex.get(p), level: level ? HEADING_LEVELS[level[1]] : '中', lastP: null };
        groups.set(span.dataset.heading, group);
      }
      // 複数行にまたがる見出しは行を空白でつなぐ（Android 版と同じ）
      group.title += (group.lastP && group.lastP !== p ? ' ' : '') + text;
      group.lastP = p;
    }

    toc = [];
    tocList.replaceChildren();
    let previous = null;
    for (const { title, index, level } of groups.values()) {
      // 同じ題名がすぐ続くもの（柱のような繰り返し）は 1 つにまとめる
      if (!(previous && previous.title === title && index - previous.index <= 2)) toc.push({ title, index, level });
      previous = { title, index };
    }
    tocOpenButton.disabled = toc.length === 0;
    tocOpenButton.textContent = toc.length ? '目次' : '目次なし';
    tocOpenButton.title = toc.length ? '' : 'この作品には見出しがありません';
  }

  // ルビの読みと《》を除いた文字列
  function visibleText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('rt, .rp').forEach((node) => node.remove());
    return clone.textContent.trim();
  }

  function openToc() {
    if (!toc.length) return;
    const position = paragraphs.length ? firstVisibleIndex() : 0;
    let current = 0;
    toc.forEach((item, k) => {
      if (item.index <= position) current = k;
    });

    const items = toc.map((item, k) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toc-item toc-level-' + item.level;
      button.textContent = item.title;
      if (k === current) button.setAttribute('aria-current', 'location');
      button.addEventListener('click', () => jumpToHeading(item));
      li.append(button);
      return li;
    });
    tocList.replaceChildren(...items);
    tocDialog.showModal();
    // いま読んでいる見出しを中央に出す（Android 版の目次と同じ）
    const currentButton = tocList.querySelector('[aria-current]');
    currentButton.focus({ preventScroll: true });
    currentButton.scrollIntoView({ block: 'center' });
  }

  function jumpToHeading(item) {
    tocDialog.close();
    restorePosition({ index: item.index, ratio: 0 });
    savePosition();
  }

  tocOpenButton.addEventListener('click', openToc);
  document.getElementById('toc-close').addEventListener('click', () => tocDialog.close());
  // 枠の外（背景）を押したら閉じる。中身は .toc-header と .toc-list が覆っている
  tocDialog.addEventListener('click', (event) => {
    if (event.target === tocDialog) tocDialog.close();
  });

  // ---- 読書位置 ----

  // 本文の上に重なっているツールバーの高さ。スマホで隠しているときは 0
  function headerOffset() {
    const rect = toolbar.getBoundingClientRect();
    return Math.max(0, rect.bottom ?? rect.height);
  }

  // 画面上端にある段落を二分探索で探す
  function firstVisibleIndex() {
    const top = window.scrollY + headerOffset();
    let lo = 0;
    let hi = paragraphs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const p = paragraphs[mid];
      if (p.offsetTop + p.offsetHeight <= top) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // 段落番号と段落内の割合で持つので、文字サイズを変えても同じ箇所に戻れる
  function currentPosition() {
    if (!paragraphs.length) return null;
    const index = firstVisibleIndex();
    const p = paragraphs[index];
    const top = window.scrollY + headerOffset();
    const ratio = p.offsetHeight ? Math.min(1, Math.max(0, (top - p.offsetTop) / p.offsetHeight)) : 0;
    return { index, ratio, percent: progressPercent() };
  }

  function restorePosition(position) {
    const p = paragraphs[Math.min(position.index, paragraphs.length - 1)];
    if (!p) return;
    lastPosition = position;
    window.scrollTo(0, p.offsetTop + p.offsetHeight * (position.ratio || 0) - headerOffset());
  }

  function progressPercent() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? Math.min(100, Math.round((window.scrollY / max) * 100)) : 100;
  }

  function updateProgress() {
    const percent = paragraphs.length ? progressPercent() : null;
    progressEl.textContent = percent === null ? '' : percent + '%';
    // 幅の狭い画面では数字の代わりに、ツールバー下端の細いバーで示す
    toolbar.style.setProperty('--progress', percent === null ? '0%' : percent + '%');
  }

  function savePosition() {
    clearTimeout(saveTimer);
    const position = currentPosition();
    if (!position) return;
    lastPosition = position;
    if (currentKey) saveJSON('pos:' + currentKey, { ...position, savedAt: Date.now() });
  }

  // 幅が変わると同じ scrollY でも別の段落になるので、直前の位置に戻してから保存させる
  // （画面回転・分割表示などで window の resize が来ない環境もあるため、本文の幅を直接見る）
  let lastWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width === lastWidth) return;
    lastWidth = width;
    clearTimeout(saveTimer);
    relayoutRuby();
    if (lastPosition) restorePosition(lastPosition);
  }).observe(textEl);

  // ---- ルビの配置 ----

  // 折り返し位置が変わるとルビ同士の重なり方も変わるので、表示が変わるたびに配置し直す。
  // 長い作品（ルビが数千か所）で全文を計算すると重いため、画面の近くにある段落だけをすぐ計算し、
  // 残りは「要再計算」にしておいて、スクロールで近づいたときに計算する
  let rubyParagraphs = [];
  const rubyNearView = new Set();
  const rubyStale = new Set();
  const rubyObserver = new IntersectionObserver(
    (entries) => {
      const ready = [];
      for (const entry of entries) {
        if (entry.isIntersecting) {
          rubyNearView.add(entry.target);
          if (rubyStale.delete(entry.target)) ready.push(entry.target);
        } else {
          rubyNearView.delete(entry.target);
        }
      }
      if (ready.length && settings.ruby === 'on') AozoraText.layoutRuby(textEl, ready);
    },
    { rootMargin: '100% 0px' },
  );

  // 本文を描き直したら、ルビのある段落を見張り直す
  function watchRuby() {
    rubyObserver.disconnect();
    rubyNearView.clear();
    rubyStale.clear();
    rubyParagraphs = paragraphs.filter((p) => p.querySelector('ruby'));
    for (const p of rubyParagraphs) {
      rubyStale.add(p);
      rubyObserver.observe(p);
    }
  }

  function relayoutRuby() {
    if (settings.ruby !== 'on') return;
    for (const p of rubyParagraphs) rubyStale.add(p);
    const near = [...rubyNearView];
    for (const p of near) rubyStale.delete(p);
    if (near.length) AozoraText.layoutRuby(textEl, near);
  }

  // フォントの読み込み後は字幅が変わる（端末のフォントでも、ブラウザが遅れて読み込むことがある）
  document.fonts.addEventListener('loadingdone', relayoutRuby);

  window.addEventListener('scroll', () => {
    if (!scrollQueued) {
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        updateProgress();
      });
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 400);
    autoHideToolbar();
  }, { passive: true });

  // ---- スマホ・タブレット ----

  // matchMedia のない環境（テストなど）では「幅の広い画面・マウス操作」として扱う
  const media = (query) => (typeof matchMedia === 'function' ? matchMedia(query) : { matches: false, addEventListener() {} });
  const narrowScreen = media('(max-width: 600px)');
  const touchScreen = media('(hover: none)');
  let lastScrollY = window.scrollY;

  // スマホ・タブレット（幅の狭い画面か、タッチ操作の端末）で作品を読んでいるときは、
  // 下へ読み進めるとツールバーを隠し、上へ戻すと出す
  const isHandheld = () => narrowScreen.matches || touchScreen.matches;

  function autoHideToolbar() {
    const y = window.scrollY;
    const delta = y - lastScrollY;
    if (Math.abs(delta) < 8) return;
    lastScrollY = y;
    const canHide = isHandheld() && currentKey && settingsPanel.hidden && !toolbar.contains(document.activeElement);
    setToolbarHidden(canHide && delta > 0 && y > toolbar.offsetHeight);
  }

  function setToolbarHidden(hidden) {
    toolbar.classList.toggle('toolbar-hidden', hidden);
  }

  // キーボードでツールバーへ移ったときや画面幅が広がったときは、必ず出す
  toolbar.addEventListener('focusin', () => setToolbarHidden(false));
  narrowScreen.addEventListener('change', () => setToolbarHidden(false));
  touchScreen.addEventListener('change', () => setToolbarHidden(false));
  // 配色が「端末に合わせる」のとき、端末のライト・ダークの切り替えに追従する
  media('(prefers-color-scheme: dark)').addEventListener('change', updateThemeColor);

  function closeSettings() {
    settingsPanel.hidden = true;
    settingsToggle.setAttribute('aria-expanded', 'false');
  }

  const toastEl = document.getElementById('toast');
  let toastTimer = 0;
  function showToast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 4000);
  }

  document.getElementById('main').addEventListener('click', (event) => {
    // 外字の ※ を押したら説明を出す（タッチ操作ではマウスを重ねたときの説明が見られない）
    const gaiji = event.target.closest('.gaiji[title]');
    if (gaiji) {
      showToast(gaiji.title);
      return;
    }
    // スマホ・タブレットでは、表示設定が本文を覆うので、本文を押したら閉じる
    if (isHandheld() && !settingsPanel.hidden && !event.target.closest('a, button, input, select, label')) closeSettings();
  });

  // タブを閉じる・切り替える直前にも保存する
  window.addEventListener('pagehide', savePosition);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePosition();
  });

  for (const [button, input] of [['file-open', 'file-input'], ['file-open-narrow', 'file-input'], ['home-file-open', 'home-file-input']]) {
    document.getElementById(button).addEventListener('click', () => document.getElementById(input).click());
  }
  // ---- 起動 ----

  async function init() {
    // ブラウザ任せの復元が本文描画前に走ると位置がずれるので、自前で戻す
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    populateFontSelect();
    applySettings();
    siteWorks = await loadCatalog();
    await refreshLibrary();

    // URL で作品が指定されていれば開き、なければホームを出す（続きはホームの「続きから読む」から）
    const params = new URL(location.href).searchParams;
    const text = params.get('text');
    const book = new URLSearchParams(new URL(location.href).hash.slice(1)).get('book') || params.get('book');
    if (text && isAvailable(text)) {
      selectWork(text);
    } else if (book && isAvailable(LIB_PREFIX + book)) {
      selectWork(LIB_PREFIX + book);
    } else if (book) {
      showHome('URL で指定された本棚の作品は、このブラウザには保存されていません。本棚はブラウザごとに別々です。');
    } else {
      showHome();
    }
  }

  init();
})();
