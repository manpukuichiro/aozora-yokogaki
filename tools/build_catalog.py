"""青空文庫の全作品の目録（data/catalog.json）を作る。

使い方（リポジトリのルートで）:
    python tools/build_catalog.py

公式の作品一覧 CSV から、検索と案内に使う最小限の情報だけを取り出す。本文は含まない。
ブラウザ版はこの目録で「青空文庫の全作品から探す」を行い、図書カードと zip へのリンクを出す
（青空文庫のサーバーからは CORS の制約で本文を直接読めないため、zip はユーザーがダウンロードして読み込む）。

works の各要素は fields の順の配列:
    id          作品ID（6 桁）
    title       作品名
    titleYomi   作品名読み
    subtitle    副題（なければ ""）
    author      著者（複数なら「・」区切り）
    authorYomi  著者の読み
    translator  翻訳者（なければ ""）
    dir         図書カードのある人物フォルダ（例 000148）。
                図書カードは https://www.aozora.gr.jp/cards/{dir}/card{id を数値にしたもの}.html
    zip         テキスト zip のファイル名（https://www.aozora.gr.jp/cards/{dir}/files/ 以下。なければ ""）
    kana        文字遣い種別の番号（kanaTypes の添字）
    copyright   著作権が存続している作品なら 1（青空文庫が許諾を得て公開しているもの）
    rank        青空文庫のアクセスランキングでの順位（ランキング外は 0）。検索結果の「人気順」に使う

使い方の補足:
    --ranking       順位に使うランキングのページ名（既定は fetch_popular.py と同じ 2022_xhtml）
    --authors-only  通信せず、今ある目録から著者一覧（data/authors.json）だけを作り直す

あわせて、青空文庫での作品数が多い著者 100 人の一覧（data/authors.json）を作る。
「作品を探す」の「著者から探す」は、ここから読み込むたびにランダムに選んで出す
（選ぶ人を固定しないことで、選び方の偏りを避ける。目録 2MB 余りを読み込まずに済むよう別のファイルにする）。
"""

import argparse
import datetime
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from fetch_popular import (  # noqa: E402  同じフォルダのスクリプトから共通の処理を使う
    COL_CARD_URL,
    COL_FIRST_YOMI,
    COL_KANA,
    COL_LAST_YOMI,
    COL_PERSON_COPYRIGHT,
    COL_ROLE,
    COL_SUBTITLE,
    COL_TEXT_URL,
    COL_TITLE,
    COL_TITLE_YOMI,
    COL_WORK_COPYRIGHT,
    CATALOG_URL,
    ROOT,
    load_catalog,
    person_name,
    ranked_work_ids,
)

OUT = ROOT / "data" / "catalog.json"
CARDS = "https://www.aozora.gr.jp/cards/"
FIELDS = ["id", "title", "titleYomi", "subtitle", "author", "authorYomi", "translator", "dir", "zip", "kana", "copyright", "rank"]
AUTHORS_OUT = ROOT / "data" / "authors.json"
AUTHORS_LIMIT = 100


def single_author(name):
    """著者欄が 1 人の名前か。複数の著者は「・」でつながる（例 泉鏡花・泉鏡太郎）が、
    外国人の名前は「姓 名・名」の形で「・」を含む（例 アンデルセン ハンス・クリスチャン）"""
    return " " not in name and "・" not in name or name.count(" ") == 1


def top_authors(catalog, limit=AUTHORS_LIMIT):
    """作品数の多い順（同数なら読みの順）に著者を limit 人選ぶ。共著の作品は数えない。"""
    author_col, yomi_col = catalog["fields"].index("author"), catalog["fields"].index("authorYomi")
    counts, yomi = {}, {}
    for work in catalog["works"]:
        name = work[author_col]
        if name and single_author(name):
            counts[name] = counts.get(name, 0) + 1
            yomi.setdefault(name, work[yomi_col])
    ranked = sorted(counts, key=lambda name: (-counts[name], yomi[name], name))[:limit]
    return [{"name": name, "works": counts[name]} for name in ranked]


def authors_data(catalog):
    return {"source": "data/catalog.json", "generated": catalog.get("generated"), "authors": top_authors(catalog)}


def write_authors(catalog):
    data = authors_data(catalog)
    AUTHORS_OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"data/authors.json に作品数の多い著者 {len(data['authors'])} 人を書き出しました")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ranking", default="2022_xhtml", help="順位に使うランキングのページ名（既定 2022_xhtml）")
    parser.add_argument("--authors-only", action="store_true", help="通信せず、今ある目録から data/authors.json だけを作り直す")
    args = parser.parse_args()
    if args.authors_only:
        write_authors(json.loads(OUT.read_text(encoding="utf-8")))
        return

    print(f"ランキング {args.ranking} を取得中…")
    ranks = {work_id: rank for rank, work_id in enumerate(ranked_work_ids(args.ranking, sleep=1), start=1)}
    print("作品一覧 CSV を取得中…")
    catalog = load_catalog(sleep=0)

    kana_types = []
    works = []
    for work_id, rows in catalog.items():
        first = rows[0]
        card = re.fullmatch(re.escape(CARDS) + r"(\d+)/card(\d+)\.html", first[COL_CARD_URL])
        if not card or int(card.group(2)) != int(work_id):
            print(f"  図書カードの URL が想定と違うため除外: {work_id} {first[COL_CARD_URL]}")
            continue
        directory = card.group(1)
        zip_match = re.fullmatch(re.escape(CARDS + directory) + r"/files/([\w.-]+\.zip)", first[COL_TEXT_URL])
        if first[COL_KANA] not in kana_types:
            kana_types.append(first[COL_KANA])
        authors = [row for row in rows if row[COL_ROLE] == "著者"] or rows[:1]
        translators = [row for row in rows if row[COL_ROLE] == "翻訳者"]
        copyright_alive = first[COL_WORK_COPYRIGHT] != "なし" or any(row[COL_PERSON_COPYRIGHT] != "なし" for row in rows)
        works.append([
            work_id,
            first[COL_TITLE],
            first[COL_TITLE_YOMI],
            first[COL_SUBTITLE],
            "・".join(person_name(row) for row in authors),
            "・".join((row[COL_LAST_YOMI] + row[COL_FIRST_YOMI]).strip() for row in authors),
            "・".join(person_name(row) for row in translators),
            directory,
            zip_match.group(1) if zip_match else "",
            kana_types.index(first[COL_KANA]),
            1 if copyright_alive else 0,
            ranks.get(work_id, 0),
        ])

    # 読みの順に並べておく（ブラウザ側の並べ替えを省く）
    works.sort(key=lambda work: (work[2], work[5], work[0]))
    OUT.parent.mkdir(exist_ok=True)
    data = {
        "source": CATALOG_URL,
        "generated": datetime.date.today().isoformat(),
        "fields": FIELDS,
        "ranking": args.ranking,
        "kanaTypes": kana_types,
        "works": works,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    with_zip = sum(1 for work in works if work[8])
    ranked = sum(1 for work in works if work[11])
    print(f"data/catalog.json に {len(works)} 作品（zip あり {with_zip}、順位あり {ranked}）を書き出しました（{OUT.stat().st_size // 1024} KB）")
    write_authors(data)


if __name__ == "__main__":
    main()
