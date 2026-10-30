"""青空文庫の人気作品を取得して texts/ に置き、texts/index.json を生成する。

使い方（リポジトリのルートで）:
    python tools/fetch_popular.py                  # ランキング 300 位までの作品
    python tools/fetch_popular.py --max-rank 100   # 範囲を変える
    python tools/fetch_popular.py --count 50       # 本数で区切る
    python tools/fetch_popular.py --dry-run    # 取得せず、選ばれる作品だけ表示

選び方:
    1. 青空文庫のアクセスランキング（既定は 2022 年の XHTML 版＝Web で読まれた回数）を上から見る。
    2. 公式の作品一覧 CSV で、作品著作権フラグと、関係する全員（著者・翻訳者など）の
       人物著作権フラグがすべて「なし」の作品だけを採る（許諾を得て公開している作品は除く）。
    3. テキストファイル（zip）が公開されていない作品は飛ばす。
    4. 同じ題名・同じ著者の別の版（新字新仮名と旧字旧仮名など）は、順位が上のものだけを採る。

本文は公式の zip から取り出したまま（Shift_JIS・末尾の底本情報つき）で保存し、加工しない。
取得済みのファイルは次回は再取得しない（--force で取り直す）。サーバーの負荷を避けるため
リクエストの間は --sleep 秒（既定 1 秒）あける。
"""

import hashlib
import datetime
import argparse
import csv
import io
import json
import pathlib
import re
import sys
import time
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEXT_DIR = ROOT / "texts"
RANKING_URL = "https://www.aozora.gr.jp/access_ranking/{name}.html"
CATALOG_URL = "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip"
USER_AGENT = "aozora-yokogaki-reader/1.0 (fetch_popular.py)"

# 作品一覧 CSV の列
COL_WORK_ID = "作品ID"
COL_TITLE = "作品名"
COL_TITLE_YOMI = "作品名読み"
COL_SUBTITLE = "副題"
COL_KANA = "文字遣い種別"
COL_WORK_COPYRIGHT = "作品著作権フラグ"
COL_CARD_URL = "図書カードURL"
COL_LAST_NAME = "姓"
COL_FIRST_NAME = "名"
COL_LAST_YOMI = "姓読み"
COL_FIRST_YOMI = "名読み"
COL_ROLE = "役割フラグ"
COL_PERSON_COPYRIGHT = "人物著作権フラグ"
COL_TEXT_URL = "テキストファイルURL"
COL_TEXT_UPDATED = "テキストファイル最終更新日"


def fetch(url, sleep):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    time.sleep(sleep)
    return data


def ranked_work_ids(ranking, sleep):
    html = fetch(RANKING_URL.format(name=ranking), sleep).decode("cp932", errors="replace")
    ids = []
    for work_id in re.findall(r"/cards/\d+/card(\d+)\.html", html):
        work_id = work_id.zfill(6)
        if work_id not in ids:
            ids.append(work_id)
    if not ids:
        sys.exit(f"ランキング {ranking} から作品を読み取れませんでした")
    return ids


def load_catalog(sleep):
    with zipfile.ZipFile(io.BytesIO(fetch(CATALOG_URL, sleep))) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".csv"))
        with archive.open(name) as raw:
            rows = list(csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig")))
    works = {}
    for row in rows:
        works.setdefault(row[COL_WORK_ID], []).append(row)
    return works


def person_name(row):
    last, first = row[COL_LAST_NAME].strip(), row[COL_FIRST_NAME].strip()
    if not first:
        return last
    # 日本の人名は続けて、カタカナ表記の外国人名は空白で区切る（青空文庫の表記に合わせる）
    return last + ("" if re.search(r"[㐀-鿿]", last + first) else " ") + first


def describe(rows):
    """作品の行（関係者ごと）から一覧用の情報を作る。採れない作品は理由を返す。"""
    first = rows[0]
    if any(row[COL_WORK_COPYRIGHT] != "なし" for row in rows):
        return None, "作品著作権あり"
    if any(row[COL_PERSON_COPYRIGHT] != "なし" for row in rows):
        return None, "関係者の著作権あり"
    url = first[COL_TEXT_URL]
    if not re.match(r"https://www\.aozora\.gr\.jp/cards/\d+/files/[\w.-]+\.zip$", url):
        return None, "テキストの zip なし"

    authors = [row for row in rows if row[COL_ROLE] == "著者"] or rows[:1]
    translators = [row for row in rows if row[COL_ROLE] == "翻訳者"]
    work = {
        "workId": first[COL_WORK_ID],
        "title": first[COL_TITLE],
        "titleYomi": first[COL_TITLE_YOMI],
        "author": "・".join(person_name(row) for row in authors),
        "authorYomi": "・".join((row[COL_LAST_YOMI] + row[COL_FIRST_YOMI]).strip() for row in authors),
    }
    if first[COL_SUBTITLE]:
        work["subtitle"] = first[COL_SUBTITLE]
    if translators:
        work["translator"] = "・".join(person_name(row) for row in translators)
        work["translatorYomi"] = "・".join((row[COL_LAST_YOMI] + row[COL_FIRST_YOMI]).strip() for row in translators)
    work["kana"] = first[COL_KANA]
    work["card"] = first[COL_CARD_URL]
    work["textUpdated"] = first[COL_TEXT_UPDATED]
    return (work, url), None


def extract_text(data):
    """配布 zip から本文の .txt を取り出す（複数あれば一番大きいもの）。中身は加工しない。"""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        texts = [info for info in archive.infolist() if info.filename.lower().endswith(".txt")]
        if not texts:
            raise ValueError("zip の中に .txt がありません")
        return archive.read(max(texts, key=lambda info: info.file_size))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--max-rank", type=int, default=300, help="ランキングの何位までを見るか（既定 300）")
    parser.add_argument("--count", type=int, default=None, help="取得する作品数の上限（既定は上限なし）")
    parser.add_argument("--ranking", default="2022_xhtml", help="ランキングのページ名（既定 2022_xhtml）")
    parser.add_argument("--sleep", type=float, default=1.0, help="リクエストの間隔（秒）")
    parser.add_argument("--force", action="store_true", help="取得済みの作品も取り直す")
    parser.add_argument("--dry-run", action="store_true", help="取得せず、選ばれる作品だけ表示する")
    args = parser.parse_args()

    print(f"ランキング {args.ranking} を取得中…")
    ranking = ranked_work_ids(args.ranking, args.sleep)
    print("作品一覧 CSV を取得中…")
    catalog = load_catalog(args.sleep)

    selected = []
    skipped = []
    for rank, work_id in enumerate(ranking, start=1):
        if rank > args.max_rank or (args.count is not None and len(selected) >= args.count):
            break
        rows = catalog.get(work_id)
        if not rows:
            skipped.append((rank, work_id, "作品一覧にない"))
            continue
        result, reason = describe(rows)
        if reason:
            skipped.append((rank, f"{rows[0][COL_TITLE]}（{work_id}）", reason))
            continue
        work, url = result
        if any(other["title"] == work["title"] and other["author"] == work["author"] for other, _ in selected):
            skipped.append((rank, f"{work['title']}（{work_id}）", "同じ題名・著者の別の版（上位の版を採用）"))
            continue
        work["rank"] = rank
        work["file"] = f"aozora_{work_id}.txt"
        selected.append((work, url))

    for rank, name, reason in skipped:
        print(f"  除外 {rank:>3} 位 {name}: {reason}")
    print(f"{len(selected)} 作品を選びました（ランキング上位 {selected[-1][0]['rank'] if selected else 0} 位まで）")

    if args.dry_run:
        for work, _ in selected:
            print(f"  {work['rank']:>3} 位 {work['title']}（{work['author']}）")
        return

    TEXT_DIR.mkdir(exist_ok=True)
    old_path = TEXT_DIR / "index.json"
    old = {w["file"]: w for w in json.loads(old_path.read_text(encoding="utf-8"))} if old_path.exists() else {}
    for index, (work, url) in enumerate(selected, start=1):
        path = TEXT_DIR / work["file"]
        previous = old.get(work["file"], {})
        if path.exists() and not args.force and previous.get("downloadedAt") and previous.get("sha256") == hashlib.sha256(path.read_bytes()).hexdigest() and previous.get("textUpdated") == work["textUpdated"]:
            work["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            work["sourceZip"] = url
            work["downloadedAt"] = previous.get("downloadedAt")  # 不明な取得日は捏造しない
            work["rightsCheckedAt"] = datetime.date.today().isoformat()
            continue
        print(f"  [{index}/{len(selected)}] {work['title']}（{work['author']}）")
        path.write_bytes(extract_text(fetch(url, args.sleep)))
        work["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        work["sourceZip"] = url
        work["downloadedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        work["rightsCheckedAt"] = datetime.date.today().isoformat()

    entries = [work for work, _ in selected]
    (TEXT_DIR / "index.json").write_text(json.dumps(entries, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"texts/index.json に {len(entries)} 作品を書き出しました")


if __name__ == "__main__":
    main()
