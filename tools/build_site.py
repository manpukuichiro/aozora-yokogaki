"""ローカルの公開候補を新規フォルダーへ生成する。通信・デプロイは行わない。"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = ['index.html', 'style.css', 'reader.js', 'reader-data.js', 'library.js', 'aozora.js', 'catalog.js', 'NOTICE.html', 'LICENSE', '.nojekyll',
           'favicon.svg', 'favicon.ico', 'apple-touch-icon.png']
PAGES = ['index.html', 'NOTICE.html']
# 版番号の置き場所。手元の HTML では「開発版」と書いておき、公開物でビルドの版に置き換える
BUILD_VERSION = re.compile(r'(<span class="build-version">)[^<]*(</span>)')
JST = datetime.timezone(datetime.timedelta(hours=9))


def build_version():
    """公開物の版：日本時間のビルド日と、分かればコミットの短い ID（例 2026.10.28（1a2b3c4））。"""
    date = datetime.datetime.now(JST).strftime('%Y.%m.%d')
    commit = os.environ.get('GITHUB_SHA')  # GitHub Actions が設定する
    if not commit:
        result = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True)
        commit = result.stdout.strip() if result.returncode == 0 else ''
    return f'{date}（{commit[:7]}）' if commit else date


def set_version(html, version, page):
    html, count = BUILD_VERSION.subn(lambda m: m.group(1) + version + m.group(2), html)
    if not count:
        raise ValueError('版番号の置き場所（<span class="build-version">）がありません: ' + page)
    return html
# <link href> と <script src> が読み込む同じサイトのファイル（ページ間のリンクは対象外）
ASSET_REFERENCE = re.compile(r'(<(?:link|script)\b[^>]*?\b(?:href|src)=")([^"?#:]+\.(?:css|js|svg|ico|png))(")')


def add_version_query(html, destination):
    """読み込むファイルの URL に内容のハッシュを付ける（例 reader.js?v=1a2b3c4d5e）。

    GitHub Pages は各ファイルを 10 分ほどキャッシュさせるため、更新直後に新しい HTML と
    ブラウザに残った古い JavaScript が組み合わさって画面が壊れることがある。
    中身が変わったファイルだけ URL が変わるので、変わっていないファイルはキャッシュがそのまま効く。
    """
    def replace(match):
        asset = destination / match.group(2)
        if not asset.is_file():
            raise ValueError('HTML が読み込むファイルが公開物にありません: ' + match.group(2))
        version = hashlib.sha256(asset.read_bytes()).hexdigest()[:10]
        return f'{match.group(1)}{match.group(2)}?v={version}{match.group(3)}'

    return ASSET_REFERENCE.sub(replace, html)


def build(destination):
    destination = pathlib.Path(destination).resolve()
    if destination.exists():
        raise ValueError('既存フォルダーには書き込みません。新しい出力先を指定してください')
    # 公開候補の生成を、回帰テストの成功に結び付ける。
    subprocess.run(['node', '--test', 'dev/reader.test.js', 'dev/safety.test.js'], cwd=ROOT, check=True)
    subprocess.run(['node', 'dev/aozora.test.js'], cwd=ROOT, check=True)
    entries = json.loads((ROOT / 'texts/index.json').read_text(encoding='utf-8'))
    catalog = json.loads((ROOT / 'data/catalog.json').read_text(encoding='utf-8'))
    rights = {str(w[0]).zfill(6): w[-1] for w in catalog['works']}
    names = set()
    for work in entries:
        name = work['file']
        if not re.fullmatch(r'aozora_\d{6}\.txt', name) or name in names:
            raise ValueError('本文のファイル名が不正または重複しています')
        names.add(name)
        if rights.get(str(work['workId']).zfill(6)) != 0:
            raise ValueError('ローカル目録で著作権フラグを確認できません: ' + name)
        content = (ROOT / 'texts' / name).read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if work.get('sha256') and work['sha256'] != digest:
            raise ValueError('記録した本文のハッシュと一致しません: ' + name)
    files = RUNTIME + ['data/catalog.json', 'texts/index.json'] + ['texts/' + name for name in sorted(names)]
    for relative in files:
        if not (ROOT / relative).is_file():
            raise ValueError('必要なファイルがありません: ' + relative)
    destination.mkdir(parents=True)
    for relative in files:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
    # 拡張子のない LICENSE は種類不明のファイルとして配信され、リンクを押すとダウンロードになる。
    # 公開物では LICENSE.txt としても置き、ページからはそちらへリンクして文面を表示させる
    shutil.copyfile(ROOT / 'LICENSE', destination / 'LICENSE.txt')
    files.append('LICENSE.txt')
    version = build_version()
    # 読み込むファイルを先にすべて置いてから、HTML を書き換える（版番号・LICENSE へのリンク・参照のハッシュ）
    for page in PAGES:
        path = destination / page
        html = set_version(path.read_text(encoding='utf-8'), version, page)
        html = html.replace('href="LICENSE"', 'href="LICENSE.txt"')
        path.write_text(add_version_query(html, destination), encoding='utf-8', newline='')
    # manifest は公開する実物（HTML は書き換え後）の内容で記録する
    manifest = []
    for relative in files:
        target = destination / relative
        manifest.append({'file': relative, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'bytes': target.stat().st_size})
    (destination / 'manifest.json').write_text(json.dumps({'version': version, 'catalogGenerated': catalog.get('generated'), 'note': 'Local metadata check only; not a worldwide copyright clearance.', 'files': manifest}, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'版 {version}：{len(entries)} 作品、{len(files)} ファイルをローカル生成: {destination}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default='_site', help='存在しない出力フォルダー')
    build(parser.parse_args().out)
