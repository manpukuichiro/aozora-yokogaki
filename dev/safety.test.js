const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { deflateRawSync } = require('node:zlib');
const source = name => fs.readFileSync(require('node:path').join(__dirname, '..', name), 'utf8');
function library() {
  const ctx = vm.createContext({ TextDecoder, TextEncoder, Blob, DecompressionStream });
  vm.runInContext(source('library.js') + ';globalThis.api=Library;', ctx);
  return ctx.api;
}
const lib = library();
function zip(content, compressed = true, declaredSize = content.length) {
  const name = Buffer.from('book.txt'), bytes = compressed ? deflateRawSync(content) : content;
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(compressed ? 8 : 0, 8); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(compressed ? 8 : 0, 10);
  central.writeUInt32LE(lib.crc32(content), 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(declaredSize, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10); end.writeUInt32LE(central.length + name.length,12); end.writeUInt32LE(local.length+name.length+bytes.length,16);
  const result = Buffer.concat([local,name,bytes,central,name,end]);
  return result.buffer.slice(result.byteOffset, result.byteOffset+result.byteLength);
}
test('stored/deflate ZIPを展開しCRCと本文を照合する', async () => {
  const content = Buffer.from('作品\n作者\n\n本文');
  for (const compressed of [true,false]) assert.deepEqual(Buffer.from((await lib.extractText(zip(content,compressed))).bytes),content);
});
test('破損・CRC不一致・展開サイズ偽装・展開上限・大量エントリーを拒否する', async () => {
  await assert.rejects(lib.extractText(new ArrayBuffer(10)));
  const corrupt = zip(Buffer.from('hello'),false); new Uint8Array(corrupt)[38] ^= 1;
  await assert.rejects(lib.extractText(corrupt), /CRC/);
  await assert.rejects(lib.extractText(zip(Buffer.alloc(100000),true,1)), /展開量/);
  await assert.rejects(lib.extractText(zip(Buffer.alloc(lib.MAX_FILE_BYTES+1))), /5 MiB/);
  const many = zip(Buffer.from('x')); const view = new DataView(many); view.setUint16(many.byteLength-14,257,true); view.setUint16(many.byteLength-12,257,true);
  await assert.rejects(lib.extractText(many), /256/);
});
function data(url, initial = {}) {
  const values = new Map(Object.entries(initial));
  const ctx = vm.createContext({ URL, location:{href:url}, TextEncoder, Library:lib,
    localStorage: { get length(){return values.size;}, key:i=>[...values.keys()][i], getItem:k=>values.get(k)??null, setItem:(k,v)=>values.set(k,v), removeItem:k=>values.delete(k) } });
  vm.runInContext(source('reader-data.js'),ctx);
  return { api:ctx.ReaderData, values };
}
test('パスで保存先を分離しクエリ・ハッシュには依存しない', () => {
  const a=data('https://example.test/a/'), b=data('https://example.test/b/');
  assert.notEqual(a.api.prefix,b.api.prefix);
  assert.equal(a.api.prefix,data('https://example.test/a/index.html?text=x#book=y').api.prefix);
});
