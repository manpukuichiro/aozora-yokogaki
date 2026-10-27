// 読み込んだ作品の扱い：zip の展開、作品名の推定、本棚（IndexedDB）への保存。
// 本文はこのブラウザの中にだけ保存し、どこにも送信しない。
const Library = (() => {
  'use strict';

  // ---- zip ----

  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_END = 0x06054b50;

  function isZip(buffer) {
    return buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === SIG_LOCAL;
  }

  // 青空文庫の配布 zip からテキストを取り出す。.txt が複数あれば一番大きいものを本文とみなす。
  // 返り値の bytes は Shift_JIS などのままで、文字コードの判定は呼び出し側で行う
  async function extractText(buffer) {
    if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('ファイルは 5 MiB 以下にしてください');
    const view = new DataView(buffer), bytes = new Uint8Array(buffer);
    const bad = () => { throw new Error('ZIP の構造が壊れているか、未対応の形式です'); };
    const range = (offset, size) => { if (offset < 0 || size < 0 || offset + size > bytes.length) bad(); };
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === SIG_END && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
    }
    if (end < 0) bad();
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    const centralEnd = offset + view.getUint32(end + 12, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || centralEnd !== end) bad();
    if (count > 256) throw new Error('ZIP 内のファイル数は 256 件までです');
    const entries = [];
    for (let k = 0; k < count; k++) {
      range(offset, 46);
      if (view.getUint32(offset, true) !== SIG_CENTRAL) bad();
      const flags = view.getUint16(offset + 8, true);
      const nameLength = view.getUint16(offset + 28, true);
      const length = 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
      range(offset, length);
      if (offset + length > centralEnd || view.getUint16(offset + 34, true)) bad();
      entries.push({ name: new TextDecoder(flags & 0x800 ? 'utf-8' : 'shift_jis').decode(bytes.subarray(offset + 46, offset + 46 + nameLength)), flags,
        method: view.getUint16(offset + 10, true), crc: view.getUint32(offset + 16, true),
        compressedSize: view.getUint32(offset + 20, true), size: view.getUint32(offset + 24, true), localOffset: view.getUint32(offset + 42, true) });
      offset += length;
    }
    if (offset !== centralEnd) bad();
    const texts = entries.filter(entry => /\.txt$/i.test(entry.name));
    if (!texts.length) throw new Error('ZIP の中に .txt がありません');
    const entry = texts.reduce((a, b) => b.size > a.size ? b : a);
    if (entry.size > MAX_FILE_BYTES) throw new Error('展開後の本文は 5 MiB 以下にしてください');
    if (entry.flags & 1) throw new Error('暗号化 ZIP は読めません');
    const local = entry.localOffset;
    range(local, 30);
    if (view.getUint32(local, true) !== SIG_LOCAL || view.getUint16(local + 8, true) !== entry.method || view.getUint16(local + 6, true) !== entry.flags) bad();
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    range(dataStart, entry.compressedSize);
    if (dataStart + entry.compressedSize > view.getUint32(end + 16, true)) bad();
    let data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 8) {
      let decompressor;
      try { decompressor = new DecompressionStream('deflate-raw'); }
      catch { throw new Error('このブラウザでは ZIP を展開できません。端末で展開して .txt を開いてください'); }
      const reader = new Blob([data]).stream().pipeThrough(decompressor).getReader();
      const chunks = []; let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_FILE_BYTES || total > entry.size) throw new Error('ZIP の展開量が上限または記録されたサイズを超えました');
          chunks.push(value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      data = new Uint8Array(total); let pos = 0;
      for (const chunk of chunks) { data.set(chunk, pos); pos += chunk.length; }
    } else if (entry.method !== 0) throw new Error('未対応の ZIP 圧縮形式です。展開して .txt を開いてください');
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Error('ZIP のサイズまたは CRC が一致しません。再ダウンロードしてください');
    return { name: entry.name.split('/').pop(), bytes: data };
  }

  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // ---- 作品名の推定 ----

  // 青空文庫のテキストは冒頭が「作品名／（副題）／著者名／（訳者名）」で、空行か区切り線で終わる
  function describe(text, fileName) {
    const header = [];
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw
        .replace(/［＃[^］]*］/g, '')
        .replace(/《[^》]*》/g, '')
        .replace(/｜/g, '')
        .trim();
      if (!line || /^[-－—─━]{10,}/.test(line)) break;
      header.push(line);
      if (header.length >= 4) break;
    }
    const fallback = fileName.replace(/\.(txt|zip)$/i, '');
    return {
      title: header[0] || fallback,
      author: header.length >= 2 ? header[header.length - 1] : '',
    };
  }

  // ---- 本棚（IndexedDB） ----
  // books：一覧に出す情報だけ（軽い）、texts：本文

  const DB_NAME = globalThis.ReaderData?.databaseName || 'aozora-reader';
  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('books', { keyPath: 'id' });
          request.result.createObjectStore('texts', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      dbPromise.catch(() => {
        dbPromise = null;
      });
    }
    return dbPromise;
  }

  async function transaction(stores, mode, work) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      try {
        Promise.resolve(work(tx)).then((value) => {
          result = value;
        }, error => { tx.abort(); reject(error); });
      } catch (error) { tx.abort(); reject(error); }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const requestValue = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  // 新しく読み込んだ順
  async function list() {
    const books = await transaction(['books'], 'readonly', (tx) => requestValue(tx.objectStore('books').getAll()));
    return books.sort((a, b) => b.addedAt - a.addedAt);
  }

  async function getText(id) {
    const record = await transaction(['texts'], 'readonly', (tx) => requestValue(tx.objectStore('texts').get(id)));
    return record ? record.text : null;
  }

  // 旧形式の ID は再利用し、URL と localStorage の読書位置をそのまま残す。
  // 作品 ID がない文章は、同名・同じ長さだけで自動的に上書きしない。
  async function identify(book, text, confirmReplace = () => false) {
    const bytes = new TextEncoder().encode(text);
    const contentHash = globalThis.crypto?.subtle
      ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
      : null;
    const newId = () => book.workId ? 'aozora:' + book.workId
      : 'text:' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    let existing;
    try {
      existing = await list();
    } catch {
      // 保存できない環境でも、呼び出し側で今回だけ表示できるようにする。
      return { id: newId(), contentHash };
    }
    const official = book.workId && existing.find((item) => item.workId === book.workId);
    if (official) return { id: official.id, contentHash };

    for (const item of existing) {
      if (book.workId && item.workId && book.workId !== item.workId) continue;
      if (contentHash && item.contentHash && contentHash !== item.contentHash) continue;
      // 旧データにも対応し、ハッシュだけでなく本文そのものを照合する。
      if (await getText(item.id) === text) {
        // 配布zipを展開したtxtで再取り込みしても、既知の作品IDを失わない。
        const known = item.workId && !book.workId
          ? { workId: item.workId, title: item.title, subtitle: item.subtitle,
            author: item.author, translator: item.translator, card: item.card }
          : {};
        return { ...known, id: item.id, contentHash };
      }
    }

    const candidates = existing.filter((item) => !item.workId
      && (item.innerName || item.id.replace(/:\d+$/, '')) === book.innerName
      && item.title === book.title && (item.author || '') === (book.author || ''));
    if (candidates.length === 1 && await confirmReplace(candidates[0])) {
      return { id: candidates[0].id, contentHash };
    }
    return { id: newId(), contentHash };
  }

  async function save(book, text) {
    await transaction(['books', 'texts'], 'readwrite', (tx) => {
      tx.objectStore('books').put(book);
      tx.objectStore('texts').put({ id: book.id, text });
    });
  }

  async function remove(id) {
    await transaction(['books', 'texts'], 'readwrite', (tx) => {
      tx.objectStore('books').delete(id);
      tx.objectStore('texts').delete(id);
    });
  }

  return { MAX_FILE_BYTES, crc32, isZip, extractText, describe, list, getText, identify, save, remove };
})();
