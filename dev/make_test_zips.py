"""読み込み機能（zip の展開など）を試すためのファイルを dev/zips/ に作る。

使い方: python dev/make_test_zips.py
作ったファイルを画面にドラッグ＆ドロップして確かめる。
"""
import zipfile, pathlib
fixtures = pathlib.Path(__file__).resolve().parent / 'fixtures'
out = pathlib.Path(__file__).resolve().parent / 'zips'
out.mkdir(exist_ok=True)
ruby = (fixtures / 'ruby-test.txt').read_text(encoding='utf-8').replace('\n', '\r\n')
anno = (fixtures / 'annotation-test.txt').read_text(encoding='utf-8').replace('\n', '\r\n')
sjis = lambda s: s.encode('cp932', errors='replace')
png = b'\x89PNG\r\n\x1a\n' + b'0' * 5000  # 本文より小さくない画像も入る想定（.txt だけを選ぶか）

# 1. 青空文庫風：Shift_JIS 本文を deflate、画像も同梱
with zipfile.ZipFile(out / 'ruby_test.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('ruby_test.txt', sjis(ruby))
    z.writestr('fig01.png', png)

# 2. ファイル名が Shift_JIS（UTF-8 フラグなし）
orig = zipfile.ZipInfo._encodeFilenameFlags
zipfile.ZipInfo._encodeFilenameFlags = lambda self: (self.filename.encode('cp932'), self.flag_bits & ~0x800)
with zipfile.ZipFile(out / 'chuuki.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('注記の試験.txt', sjis(anno))
zipfile.ZipInfo._encodeFilenameFlags = orig

# 3. 無圧縮
with zipfile.ZipFile(out / 'stored.zip', 'w', zipfile.ZIP_STORED) as z:
    z.writestr('folder/stored_test.txt', sjis('無圧縮の試験\r\n動作確認用\r\n\r\n　無圧縮《むあっしゅく》の zip も読める。\r\n'))

# 4. UTF-8 テキスト、5. 対象外
(out / 'utf8_test.txt').write_text('UTF-8 の試験\n動作確認用\n\n　そのまま読める｜本文《ほんぶん》。\n', encoding='utf-8')
(out / 'not_text.pdf').write_bytes(b'%PDF-1.4 dummy')
# 6. テキストを含まない zip
with zipfile.ZipFile(out / 'images_only.zip', 'w') as z:
    z.writestr('a.png', png)
for p in sorted(out.iterdir()):
    print(p.name, p.stat().st_size)
