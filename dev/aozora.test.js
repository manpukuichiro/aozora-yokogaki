// aozora.js（青空文庫記法の解析）の照合テスト。
// Android 版「青空文庫リーダー」の TextProcessorTest の例を中心に、同じ結果になるかを確かめる。
// 実行：node dev/aozora.test.js
const path = require('path');
const A = require(path.join(__dirname, '..', 'aozora.js'));
let fail = 0, total = 0;
const ok = (cond, label, detail) => { total++; if (!cond) { fail++; console.log('NG', label, detail === undefined ? '' : JSON.stringify(detail)); } };
const P = (s) => A.prepare(s).text;
// toPlainDisplay 相当：タグ・ルビ読み・内部記号を除いた表示文字列
const plain = (s) => s.split(A.PAGE_BREAK).join('').split('\n').map(l => A.parseLine(l).map(x => x.text ?? x.base ?? '').join('')).join('\n').replaceAll(A.GAIJI, '※');
const show = (line) => A.parseLine(line).map(s => s.tag ? '' : s.text ?? (s.base !== undefined ? `[${s.base}/${s.ruby}]` : '')).join('');

// ---- ルビ（前回の照合ケース） ----
for (const [input, expected] of [
  ['吾人《ごじん》', '[吾人/ごじん]'], ['父は｜豊前《ぶぜん》の人', '父は[豊前/ぶぜん]の人'], ['｜漢字《かんじ》テスト', '[漢字/かんじ]テスト'],
  ['あ｜漢字《かんじ》い', 'あ[漢字/かんじ]い'], ['これは漢字《かんじ》です', 'これは[漢字/かんじ]です'], ['《だけ》', '《だけ》'],
  ['ロンドン《倫敦》へ', '[ロンドン/倫敦]へ'], ['かなの後に《よみ》', 'かなの後[に/よみ]'], ['刺※《しらく》', '[刺※/しらく]'],
  ['ABC《エービーシー》', '[ABC/エービーシー]'], ['東京《とうきょう》都《と》', '[東京/とうきょう][都/と]'], ['｜だけ', 'だけ'],
  ['閉じない《よみ', '閉じない《よみ'], ['「《よみ》', '「'], ['一二三四五六七八九十一二三四五六七八九十一《よみ》', '一[二三四五六七八九十一二三四五六七八九十一/よみ]'],
]) ok(show(input) === expected, 'ruby ' + input, show(input));

// ---- processAozoraBunkoText（TextProcessorTest から移植） ----
ok(P('本文\n---------------------------------------\nここは底本情報\n---------------------------------------\n後書き').includes('本文'), 'separator keeps body');
ok(!P('本文《ほんぶん》\n---------------------------------------\nここは底本情報\n---------------------------------------\n後書き').includes('ここは底本情報'), 'separator removed');
ok(!P('段落《だんらく》1\n\n\n\n\n段落2').includes('\n\n\n'), 'collapse newlines');
ok(P('普通のテキスト') === '普通のテキスト', 'plain passthrough');
ok(!P('テスト\n［＃3字下げ］字下げ行').includes('［＃'), 'indent removed');
ok(P('前半\n［＃改ページ］\n後半') === '前半' + A.PAGE_BREAK + '後半', 'page break', P('前半\n［＃改ページ］\n後半'));
for (const c of ['改ページ', '改丁', '改見開き', '改段']) ok(P(`前\n［＃${c}］\n後`) === '前' + A.PAGE_BREAK + '後', 'break ' + c);

const fwd = P('母と直談［＃「母と直談」は窓中見出し］　母は静かに話し始めた。');
const rng = P('［＃窓中見出し］母と直談［＃窓中見出し終わり］　母は静かに話し始めた。');
ok(plain(fwd) === '母と直談　母は静かに話し始めた。' && plain(rng) === plain(fwd), 'window plain', [plain(fwd), plain(rng)]);
ok(fwd.startsWith('<mado-naka>') && fwd.includes('母と直談</mado>') && rng.startsWith('<mado-naka>') && rng.includes('母と直談</mado>'), 'window tags', [fwd, rng]);

const hf = P('洋行船中の談話［＃「洋行船中の談話」は中見出し］\n本文'), hr = P('［＃大見出し］第一章［＃大見出し終わり］\n本文');
ok(hf.startsWith('<midashi-naka>') && hf.includes('洋行船中の談話</midashi>') && hr.startsWith('<midashi-o>') && hr.includes('第一章</midashi>'), 'regular heading', [hf, hr]);
ok(plain(hf) === '洋行船中の談話\n本文', 'heading plain');

const decl = P('通常［＃「通常」は大見出し］\n同行［＃「同行」は同行中見出し］　本文\n窓［＃「窓」は窓小見出し］　本文\n［＃ここから中見出し］複数\n行［＃ここで中見出し終わり］\n［＃同行小見出し］同行範囲［＃同行小見出し終わり］\n［＃窓大見出し］窓範囲［＃窓大見出し終わり］');
ok(plain(decl) === '通常\n同行　本文\n窓　本文\n複数\n行\n同行範囲\n窓範囲', 'heading forms plain', plain(decl));

const lay = P('［＃ここから２字下げ］\n二字\n［＃ここから４字下げ］\n四字\n［＃ここで字下げ終わり］\n［＃ここから改行天付き、折り返して１字下げ］\nぶら下げ\n［＃ここで字下げ終わり］\n［＃地から２字上げ］署名\n［＃ページの左右中央］\n中央');
for (const s of ['<az-indent-2-2>二字</az-indent>', '<az-indent-4-4>四字</az-indent>', '<az-indent-0-1>ぶら下げ</az-indent>', '<az-right-2>署名　　</az-right>', '<az-center-0>中央</az-center>']) ok(lay.includes(s), 'layout ' + s, lay);
ok(!lay.includes('<az-indent-6-6>'), 'no cumulative indent');
ok(plain(lay).replace(/^\n/, '') ==='二字\n\n四字\n\nぶら下げ\n\n署名　　\n\n中央', 'layout plain', plain(lay));

const deco = P('太字［＃「太字」は太字］ 斜体［＃「斜体」は斜体］ 傍点［＃「傍点」に白丸傍点］ 傍線［＃「傍線」に波線］ 大［＃「大」は２段階大きな文字］ 小［＃「小」は１段階小さな文字］ 2［＃「2」は上付き小文字］ H2［＃「2」は下付き小文字］O 誤字［＃「誤字」に「ママ」の注記］');
for (const k of ['bold', 'italic', 'dot', 'underline', 'sizeup-2', 'sizedown-1', 'sup', 'sub', 'note']) ok(deco.includes(`<az-${k}>`), 'deco ' + k, deco);
ok(plain(deco) === '太字 斜体 傍点 傍線 大 小 2 H2O 誤字（ママ）', 'deco plain', plain(deco));

const fig = P('［＃コンドル博士の図（fig47728_06.png、横320×縦322）入る］\n神戸港頭の袂別［＃「神戸港頭の袂別」はキャプション］\n本文［＃割り注］注釈［＃割り注終わり］\n囲み［＃「囲み」は罫囲み］\n［＃ここから４字詰め］\nあいうえおかきくけこ\n［＃ここで字詰め終わり］');
for (const s of ['［図版：コンドル博士の図］', '<az-caption>神戸港頭の袂別</az-caption>', '本文（<az-wari>注釈</az-wari>）', '<az-box>囲み</az-box>', '<az-jizume-4>あいうえおかきくけこ</az-jizume>']) ok(fig.includes(s), 'fig ' + s, fig);

const box = P('［＃ここから３字下げ］\n［＃ここから２０字詰め］\n［＃ここから罫囲み］\n\n\n九州帝国大学法医学教授\n　　　　　　　　　　　　　若林鏡太郎\n医学部長\n\n\n［＃ここで罫囲み終わり］\n［＃ここで字詰め終わり］\n［＃ここで字下げ終わり］');
ok(box.includes('<az-boxblock-20-3>') && (box.match(/<az-boxblock-/g) || []).length === 1 && (box.match(/<\/az-boxblock>/g) || []).length === 1 && !box.includes('<az-box>'), 'boxblock', box);

const bold = P('［＃太字］ABCDEFGHIJK［＃太字終わり］');
ok(bold === '<az-bold>ABCDEFGHIJK</az-bold>', 'inline range', bold);

// ---- 外字・ルビと注記の組み合わせ ----
const g = A.prepare('　火※［＃「竹かんむり／助」、第3水準1-89-65］《ひばし》を使う。大切［＃「大切」に傍点］なこと。漢字《かんじ》［＃「漢字」に傍点］');
ok(g.gaiji.length === 1 && g.gaiji[0].startsWith('「竹かんむり'), 'gaiji recorded', g.gaiji);
ok(show(g.text) === '　[火※/ひばし]を使う。大切なこと。[漢字/かんじ]'.replace('※', A.GAIJI), 'gaiji ruby + dots', show(g.text));
ok(g.text.includes('<az-dot>漢字《かんじ》</az-dot>') && g.text.includes('<az-dot>大切</az-dot>'), 'forward dot over ruby', g.text);
ok(!P('底本では［＃「では」は底本では「でわ」］').includes('az-note'), 'teihon unreachable like Kotlin');
ok(P('［＃「数字」は縦中横］12') === '12', 'no-op tatechuyoko', P('［＃「数字」は縦中横］12'));

console.log(fail ? `${fail}/${total} failed` : `all ${total} passed`);
process.exitCode = fail ? 1 : 0;
