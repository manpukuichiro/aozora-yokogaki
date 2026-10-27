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
"""

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
)

OUT = ROOT / "data" / "catalog.json"
CARDS = "https://www.aozora.gr.jp/cards/"
FIELDS = ["id", "title", "titleYomi", "subtitle", "author", "authorYomi", "translator", "dir", "zip", "kana", "copyright"]


def main():
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
        ])

    # 読みの順に並べておく（ブラウザ側の並べ替えを省く）
    works.sort(key=lambda work: (work[2], work[5], work[0]))
    OUT.parent.mkdir(exist_ok=True)
    data = {
        "source": CATALOG_URL,
        "generated": datetime.date.today().isoformat(),
        "fields": FIELDS,
        "kanaTypes": kana_types,
        "works": works,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    with_zip = sum(1 for work in works if work[8])
    print(f"data/catalog.json に {len(works)} 作品（zip あり {with_zip}）を書き出しました（{OUT.stat().st_size // 1024} KB）")


if __name__ == "__main__":
    main()
