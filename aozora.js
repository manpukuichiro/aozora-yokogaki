// 青空文庫記法（ルビ・注記）の解析と表示。
// Android 版「青空文庫リーダー」の TextProcessor（processAozoraBunkoText / AozoraAnnotationParser /
// buildDisplaySequence / applyAozoraStyleRanges）を移植したもの。
// 解析部分は DOM に触れないので Node からもテストできる。表示部分（render）はブラウザでだけ使う。
const AozoraText = (() => {
  'use strict';

  const MAX_IMPLICIT_BASE = 20;
  const KANJI = 1;
  // 改ページ（Android 版と同じ私用領域の文字）
  const PAGE_BREAK = '';
  // 外字注記のあった ※。説明は prepare() の gaiji 配列に出現順で入る
  const GAIJI = '';
  // 冒頭の【テキスト中に現れる記号について】などを囲む区切り線のブロック（最初の 1 つだけ除く）
  // Kotlin の \s は ASCII の空白だけなので、全角スペースの字下げを食わないよう明示する
  const SEPARATOR_BLOCK = /[-－—─━]{10,}[\s\S]*?[-－—─━]{10,}[ \t\n\x0B\f\r]*/;
  const DISPLAY_TAG = /^<\/?az-[a-z]+(?:-[0-9]+){0,2}>$|^<\/?(?:mado|midashi)(?:-(?:o|naka|ko))?>$/;

  function looksLikeAozora(text) {
    return /[《｜※]|［＃/.test(text);
  }

  // ---- 注記パーサー（AozoraAnnotationParser の移植） ----

  const RE = {
    inlineIndent: /^([0-9０-９]+)字下げ$/,
    blockIndentStart: /^ここから([0-9０-９]+)字下げ$/,
    hangingIndentStart: /^ここから([0-9０-９]+)字下げ、折り返して([0-9０-９]+)字下げ$/,
    flushHangingIndentStart: /^ここから改行天付き、折り返して([0-9０-９]+)字下げ$/,
    rightMargin: /^地から([0-9０-９]+)字上げ$/,
    jizumeStart: /^ここから([0-9０-９]+)字詰め$/,
    forwardHeading: /^「(.+)」は(窓|同行)?([大中小])見出し$/,
    headingStart: /^(?:ここから)?(窓|同行)?([大中小])見出し$/,
    headingEnd: /^(?:ここで)?(窓|同行)?([大中小])見出し終わり$/,
    forwardMama: /^「(.+)」(?:の左)?に「ママ」の注記$/,
    forwardNiStyle: /^「(.+)」(?:の左)?に(.+)$/,
    forwardWaStyle: /^「(.+)」は(.+)$/,
    sizeLabel: /^([0-9０-９]+)段階(大きな|小さな)文字$/,
    imageFile: /\.(?:png|jpe?g|gif|webp)/i,
    teihon: /は底本では「(.+)」$/,
  };
  const PAGE_BREAK_COMMANDS = new Set(['改ページ', '改段', '改丁', '改見開き']);
  const DOT_LABELS = new Set(['傍点', '白ゴマ傍点', '丸傍点', '白丸傍点', '黒三角傍点', '白三角傍点', '二重丸傍点', '蛇の目傍点', 'ばつ傍点']);
  const UNDERLINE_LABELS = new Set(['傍線', '二重傍線', '鎖線', '破線', '波線']);
  const HORIZONTAL_NO_OP_COMMANDS = new Set(['縦中横', '縦中横終わり', '横組み', '横組み終わり', 'ここから横組み', 'ここで横組み終わり']);
  const HEADING_TAGS = {
    window: { 大: '<mado-o>', 中: '<mado-naka>', 小: '<mado-ko>', end: '</mado>' },
    regular: { 大: '<midashi-o>', 中: '<midashi-naka>', 小: '<midashi-ko>', end: '</midashi>' },
  };
  const NEED_MORE = -2;

  function parseAozoraNumber(raw) {
    let digits = '';
    for (const c of raw) {
      if (c >= '0' && c <= '9') digits += c;
      else if (c >= '０' && c <= '９') digits += String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30);
    }
    return digits ? parseInt(digits, 10) : 0;
  }

  function styleForLabel(rawLabel) {
    const label = rawLabel.trim();
    const style = (kind, openTag = '<az-' + kind + '>') => ({ kind, openTag, closeTag: '</az-' + kind + '>' });
    if (DOT_LABELS.has(label)) return style('dot');
    if (UNDERLINE_LABELS.has(label)) return style('underline');
    if (label === '太字') return style('bold');
    if (label === '斜体') return style('italic');
    if (label === '罫囲み') return style('box');
    if (label === 'キャプション') return style('caption');
    if (label === '上付き小文字' || label === '上付き' || label === '上付き小書き') return style('sup');
    if (label === '下付き小文字' || label === '下付き' || label === '下付き小書き') return style('sub');
    const size = RE.sizeLabel.exec(label);
    if (size) {
      const steps = Math.min(5, Math.max(1, parseAozoraNumber(size[1])));
      const kind = size[2].startsWith('大') ? 'sizeup' : 'sizedown';
      return style(kind, '<az-' + kind + '-' + steps + '>');
    }
    return null;
  }

  // ルビの読みと ｜ を飛ばしながら、s の末尾が title と一致する位置を探す
  function suffixStart(s, title) {
    let sourceIndex = s.length - 1;
    let titleIndex = title.length - 1;
    while (titleIndex >= 0) {
      if (sourceIndex < 0) return NEED_MORE;
      if (s[sourceIndex] === '》') {
        const rubyStart = s.lastIndexOf('《', sourceIndex);
        if (rubyStart < 0) return NEED_MORE;
        sourceIndex = rubyStart - 1;
        continue;
      }
      const sourceChar = s[sourceIndex] === GAIJI ? '※' : s[sourceIndex];
      if (sourceChar === '｜') {
        sourceIndex--;
        continue;
      }
      if (sourceChar !== title[titleIndex]) return -1;
      sourceIndex--;
      titleIndex--;
    }
    while (sourceIndex >= 0 && s[sourceIndex] === '｜') sourceIndex--;
    return sourceIndex + 1;
  }

  class AnnotationParser {
    constructor() {
      // 前方参照（「…」に傍点 など）の挿入を速くするため、確定した行と現在の行を分けて持つ
      this.done = [];
      this.cur = '';
      this.gaiji = [];
      this.lineStart = true;
      this.lineHasContent = false;
      this.lineTagKinds = [];
      this.lineRightMargin = 0;
      this.pendingIndent = null;
      this.pendingAlignment = null;
      this.blockIndent = null;
      this.blockAlignment = null;
      this.pageCenterActive = false;
      this.blockJizume = null;
      this.blockStyles = new Map();
      this.blockBoxOpen = false;
      this.warichuDepth = 0;
      this.headingStack = [];
    }

    process(input) {
      let i = 0;
      while (i < input.length) {
        const ch = input[i];
        if (ch === '［' && input[i + 1] === '＃') {
          const close = input.indexOf('］', i + 2);
          if (close <= i) {
            i++;
            continue;
          }
          const command = input.slice(i + 2, close).trim();
          if (input[i - 1] === '※' && this.cur.endsWith('※') && command.startsWith('「')) {
            this.cur = this.cur.slice(0, -1) + GAIJI;
            this.gaiji.push(command);
          } else {
            this.handleCommand(command);
          }
          i = close + 1;
          continue;
        }

        if (ch === '\n') {
          this.closeLineTags();
          this.newline();
          i++;
          continue;
        }

        if (this.lineStart) this.appendLinePrefix();
        this.cur += ch;
        if (ch !== '｜') this.lineHasContent = true;
        i++;
      }
      for (let k = 0; k < this.warichuDepth; k++) this.cur += '</az-wari>）';
      this.closeLineTags();
      if (this.blockBoxOpen) this.cur += '</az-boxblock>';
      return this.done.join('') + this.cur;
    }

    newline() {
      this.done.push(this.cur + '\n');
      this.cur = '';
      this.lineStart = true;
      this.lineHasContent = false;
    }

    handleCommand(command) {
      let m;
      if ((m = RE.forwardHeading.exec(command))) {
        this.applyForwardTag(m[1], this.headingStartTag(m[2], m[3]), this.headingEndTag(m[2]));
      } else if ((m = RE.headingStart.exec(command))) {
        this.cur += this.headingStartTag(m[1], m[2]);
        this.headingStack.push((m[1] || '') + m[2]);
      } else if ((m = RE.headingEnd.exec(command))) {
        if (this.headingStack[this.headingStack.length - 1] === (m[1] || '') + m[2]) {
          this.headingStack.pop();
          this.cur += this.headingEndTag(m[1]);
        }
      } else if ((m = RE.hangingIndentStart.exec(command))) {
        this.blockIndent = { first: parseAozoraNumber(m[1]), rest: parseAozoraNumber(m[2]) };
      } else if ((m = RE.flushHangingIndentStart.exec(command))) {
        this.blockIndent = { first: 0, rest: parseAozoraNumber(m[1]) };
      } else if ((m = RE.blockIndentStart.exec(command))) {
        // 字下げの宣言が続いたら前の量を置き換える
        const count = parseAozoraNumber(m[1]);
        this.blockIndent = { first: count, rest: count };
      } else if ((m = RE.inlineIndent.exec(command))) {
        const count = parseAozoraNumber(m[1]);
        this.beginNewLayoutLineIfNeeded();
        this.pendingIndent = { first: count, rest: count };
      } else if (command === 'ここで字下げ終わり') {
        this.blockIndent = null;
      } else if (PAGE_BREAK_COMMANDS.has(command)) {
        this.closeLineTags();
        this.cur += PAGE_BREAK;
        this.pendingIndent = null;
        this.pendingAlignment = null;
        this.pageCenterActive = false;
        this.lineStart = true;
        this.lineHasContent = false;
      } else if (command === 'ページの左右中央') {
        this.beginNewLayoutLineIfNeeded();
        this.pageCenterActive = true;
      } else if (command === '地付き' || command === '地寄せ') {
        this.beginNewLayoutLineIfNeeded();
        this.pendingAlignment = { kind: 'right', rightMargin: 0 };
      } else if ((m = RE.rightMargin.exec(command))) {
        this.beginNewLayoutLineIfNeeded();
        this.pendingAlignment = { kind: 'right', rightMargin: parseAozoraNumber(m[1]) };
      } else if (command === 'ここから地付き' || command === 'ここから地寄せ') {
        this.blockAlignment = { kind: 'right', rightMargin: 0 };
      } else if (command === 'ここで地付き終わり' || command === 'ここで地寄せ終わり') {
        this.blockAlignment = null;
      } else if (command === '割り注' || command === 'ここから割り注') {
        if (this.warichuDepth === 0) this.cur += '（<az-wari>';
        this.warichuDepth += 1;
      } else if (command === '割り注終わり' || command === 'ここで割り注終わり') {
        if (this.warichuDepth > 0) {
          this.warichuDepth -= 1;
          if (this.warichuDepth === 0) this.cur += '</az-wari>）';
        }
      } else if (command === 'ここから罫囲み') {
        this.beginNewLayoutLineIfNeeded();
        if (!this.blockBoxOpen) {
          const width = this.blockJizume || 0;
          const indent = this.blockIndent ? this.blockIndent.first : 0;
          this.cur += '<az-boxblock-' + width + '-' + indent + '>';
          this.blockBoxOpen = true;
        }
      } else if (command === 'ここで罫囲み終わり') {
        this.closeLineTags();
        if (this.blockBoxOpen) {
          this.cur += '</az-boxblock>';
          this.blockBoxOpen = false;
        }
      } else if (command === 'ここからキャプション') {
        this.blockStyles.set('caption', '<az-caption>');
      } else if (command === 'ここでキャプション終わり') {
        this.blockStyles.delete('caption');
      } else if ((m = RE.jizumeStart.exec(command))) {
        this.blockJizume = Math.max(1, parseAozoraNumber(m[1]));
      } else if (command === 'ここで字詰め終わり') {
        this.blockJizume = null;
      } else if ((m = RE.forwardMama.exec(command))) {
        if (this.findVisibleSuffixStart(m[1]) >= 0) this.cur += '<az-note>（ママ）</az-note>';
      } else if (command.endsWith('入る') && RE.imageFile.test(command)) {
        this.appendImagePlaceholder(command);
      } else if ((m = RE.forwardNiStyle.exec(command)) || (m = RE.forwardWaStyle.exec(command))) {
        // Kotlin 版は「に」で一致したら「は」は試さない
        const style = styleForLabel(m[2]);
        if (style) this.applyForwardTag(m[1], style.openTag, style.closeTag);
      } else if (this.handleBlockStyle(command) || this.handleInlineStyle(command)) {
        // 処理済み
      } else if (HORIZONTAL_NO_OP_COMMANDS.has(command)) {
        // 横書きでは何もしない
      } else if (command.startsWith('「') && (command.endsWith('は縦中横') || command.endsWith('は横組み'))) {
        // 横書きでは何もしない
      } else if (command.startsWith('「') && command.includes('は底本では')) {
        const original = RE.teihon.exec(command);
        if (original && original[1].trim()) this.cur += '<az-note>（底本：' + original[1] + '）</az-note>';
      }
      // その他の注記は表示しない
    }

    headingStartTag(format, level) {
      return (format === '窓' ? HEADING_TAGS.window : HEADING_TAGS.regular)[level];
    }

    headingEndTag(format) {
      return (format === '窓' ? HEADING_TAGS.window : HEADING_TAGS.regular).end;
    }

    applyForwardTag(title, openTag, closeTag) {
      const start = this.findVisibleSuffixStart(title);
      if (start < 0) return;
      this.cur = this.cur.slice(0, start) + openTag + this.cur.slice(start);
      this.cur += closeTag;
    }

    findVisibleSuffixStart(title) {
      let start = suffixStart(this.cur, title);
      if (start === NEED_MORE && this.done.length) {
        // 対象が前の行にまたがるときだけ全体を連結して探し直す
        this.cur = this.done.join('') + this.cur;
        this.done = [];
        start = suffixStart(this.cur, title);
      }
      return start === NEED_MORE ? -1 : start;
    }

    appendLinePrefix() {
      const indent = this.pendingIndent || this.blockIndent;
      if (indent) this.openLineTag('indent', '<az-indent-' + indent.first + '-' + indent.rest + '>');

      const alignment = this.pendingAlignment || this.blockAlignment || (this.pageCenterActive ? { kind: 'center', rightMargin: 0 } : null);
      if (alignment) {
        this.openLineTag(alignment.kind, '<az-' + alignment.kind + '-' + alignment.rightMargin + '>');
        this.lineRightMargin = alignment.rightMargin;
      }
      if (this.blockJizume) this.openLineTag('jizume', '<az-jizume-' + this.blockJizume + '>');
      for (const [kind, openTag] of this.blockStyles) this.openLineTag(kind, openTag);

      this.pendingIndent = null;
      this.pendingAlignment = null;
      this.lineStart = false;
    }

    openLineTag(kind, openTag) {
      this.cur += openTag;
      this.lineTagKinds.push(kind);
    }

    closeLineTags() {
      if (!this.lineTagKinds.length) return;
      if (this.lineHasContent && this.lineRightMargin > 0) this.cur += '　'.repeat(this.lineRightMargin);
      for (let k = this.lineTagKinds.length - 1; k >= 0; k--) this.cur += '</az-' + this.lineTagKinds[k] + '>';
      this.lineTagKinds = [];
      this.lineRightMargin = 0;
    }

    beginNewLayoutLineIfNeeded() {
      if (!this.lineStart && this.lineHasContent) {
        this.closeLineTags();
        this.newline();
      }
    }

    handleInlineStyle(command) {
      if (command === '大きな文字終わり') {
        this.cur += '</az-sizeup>';
        return true;
      }
      if (command === '小さな文字終わり') {
        this.cur += '</az-sizedown>';
        return true;
      }
      const isEnd = command.endsWith('終わり');
      const style = styleForLabel(isEnd ? command.slice(0, -3) : command);
      if (!style) return false;
      this.cur += isEnd ? style.closeTag : style.openTag;
      return true;
    }

    handleBlockStyle(command) {
      const isStart = command.startsWith('ここから');
      const isEnd = command.startsWith('ここで') && command.endsWith('終わり');
      if (!isStart && !isEnd) return false;
      const label = isStart ? command.slice(4) : command.slice(3, -3);
      if (isEnd && label === '大きな文字') {
        this.blockStyles.delete('sizeup');
        return true;
      }
      if (isEnd && label === '小さな文字') {
        this.blockStyles.delete('sizedown');
        return true;
      }
      const style = styleForLabel(label);
      if (!style) return false;
      if (isStart) this.blockStyles.set(style.kind, style.openTag);
      else this.blockStyles.delete(style.kind);
      return true;
    }

    appendImagePlaceholder(command) {
      this.beginNewLayoutLineIfNeeded();
      if (this.lineStart) this.appendLinePrefix();
      const paren = command.lastIndexOf('（');
      const raw = paren >= 0 ? command.slice(0, paren) : command.replace(/入る$/, '');
      const description = raw.trim().replace(/^[「」]+|[「」]+$/g, '') || '画像';
      this.cur += '<az-caption>［図版：' + description + '］</az-caption>';
      this.lineHasContent = true;
    }
  }

  // processAozoraBunkoText の移植（字詰めの折り返しは表示側の CSS で行う）
  function prepare(raw) {
    const normalized = raw.replace(/\r\n?/g, '\n');
    if (!looksLikeAozora(normalized)) return { text: normalized, gaiji: [], aozora: false };

    const parser = new AnnotationParser();
    let text = parser.process(normalized.replace(SEPARATOR_BLOCK, ''));
    text = text.replace(/\n*\n*/g, PAGE_BREAK);
    text = text.replace(/\n{3,}/g, '\n\n');
    return { text, gaiji: parser.gaiji, aozora: true };
  }

  // ---- ルビ（buildDisplaySequence の移植） ----

  function baseCategory(ch) {
    if ((ch >= '㐀' && ch <= '鿿') || '々〆ヵヶ'.includes(ch)) return KANJI;
    if ((ch >= 'ぁ' && ch <= 'ん') || (ch >= 'ァ' && ch <= 'ヶ') || ch === 'ー') return 2;
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) return 3;
    return 0;
  }

  const isGaijiMark = (ch) => ch === '※' || ch === GAIJI;

  // 《 の直前から同じ文字種が続く範囲を親文字とみなす（吾人《ごじん》→ 吾人）
  function findImplicitBaseStart(source, rubyStart) {
    if (rubyStart <= 0) return rubyStart;

    // 未解決の外字は ※ で表示される。刺※《しらく》のように親文字の末尾になり得るので、
    // ※ の並びと直前の漢字列をまとめて親文字にする
    if (isGaijiMark(source[rubyStart - 1])) {
      let start = rubyStart;
      let length = 0;
      while (start > 0 && length < MAX_IMPLICIT_BASE && isGaijiMark(source[start - 1])) {
        start--;
        length++;
      }
      const precedingIsKanji = start > 0 && baseCategory(source[start - 1]) === KANJI;
      while (precedingIsKanji && start > 0 && length < MAX_IMPLICIT_BASE && baseCategory(source[start - 1]) === KANJI) {
        start--;
        length++;
      }
      return start;
    }

    const category = baseCategory(source[rubyStart - 1]);
    if (category === 0) return rubyStart;
    let start = rubyStart - 1;
    let length = 1;
    while (start > 0 && length < MAX_IMPLICIT_BASE && baseCategory(source[start - 1]) === category) {
      start--;
      length++;
    }
    return start;
  }

  // 1 行を { text } / { base, ruby } / { tag } / { dropped } の並びに分ける。
  // dropped は表示しない読み（外字の出現順を数えるためだけに残す）
  function parseLine(line) {
    const segments = [];
    let plainStart = 0;
    let plainEnd = 0;

    const flushPlain = (end) => {
      if (end > plainStart) segments.push({ text: line.slice(plainStart, end) });
    };

    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '<') {
        const close = line.indexOf('>', i + 1);
        if (close > i) {
          // 表示用タグ以外の <…> も Android 版と同じく取り除く
          flushPlain(plainEnd);
          const tag = line.slice(i, close + 1);
          if (DISPLAY_TAG.test(tag)) segments.push({ tag });
          i = close + 1;
          plainStart = plainEnd = i;
          continue;
        }
      }

      if (ch === '｜') {
        const rubyStart = line.indexOf('《', i + 1);
        const rubyEnd = rubyStart > i ? line.indexOf('》', rubyStart + 1) : -1;
        flushPlain(plainEnd);
        if (rubyEnd > rubyStart) {
          const ruby = line.slice(rubyStart + 1, rubyEnd);
          if (rubyStart > i + 1) segments.push({ base: line.slice(i + 1, rubyStart), ruby });
          else segments.push({ dropped: ruby });
          i = rubyEnd + 1;
        } else {
          // 対応する《》がない ｜ は表示しない
          i += 1;
        }
        plainStart = plainEnd = i;
        continue;
      }

      i += 1;
      plainEnd = i;
      if (line[i] !== '《') continue;
      const rubyEnd = line.indexOf('》', i + 1);
      if (rubyEnd < 0) continue; // 閉じのない《 はそのまま文字として出す

      const ruby = line.slice(i + 1, rubyEnd);
      const baseStart = Math.max(findImplicitBaseStart(line, i), plainStart);
      const baseLength = i - baseStart;
      if (baseLength >= 1 && baseLength <= MAX_IMPLICIT_BASE) {
        flushPlain(baseStart);
        segments.push({ base: line.slice(baseStart, i), ruby });
      } else {
        // 親文字を決められないルビは読みを捨てる（Android 版と同じ）
        flushPlain(i);
        segments.push({ dropped: ruby });
      }
      i = rubyEnd + 1;
      plainStart = plainEnd = i;
    }
    flushPlain(plainEnd);
    return segments;
  }

  // ---- 表示（applyAozoraStyleRanges の移植。Span の代わりに要素と CSS を使う） ----

  // 段落（p）全体に効く種類。行ごとに閉じられるので、閉じタグは無視してよい
  const PARAGRAPH_KINDS = new Set(['indent', 'right', 'center', 'jizume']);

  function parseTag(tag) {
    let m = /^<(\/?)az-([a-z]+)((?:-[0-9]+){0,2})>$/.exec(tag);
    if (m) return { close: m[1] === '/', kind: m[2], params: m[3].split('-').filter(Boolean).map(Number) };
    m = /^<(\/?)(mado|midashi)(?:-(o|naka|ko))?>$/.exec(tag);
    return { close: m[1] === '/', kind: m[2], params: [], level: m[3] };
  }

  function render(doc, text, gaiji) {
    const fragment = doc.createDocumentFragment();
    // nextHeading：見出しごとの番号。複数行にまたがる見出しも同じ番号で目次の 1 項目になる
    const state = { open: [], box: null, gaijiIndex: 0, nextHeading: 0 };

    text.split(PAGE_BREAK).forEach((chunk, index) => {
      if (index > 0) {
        const pageBreak = doc.createElement('div');
        pageBreak.className = 'page-break';
        pageBreak.setAttribute('aria-hidden', 'true');
        (state.box || fragment).append(pageBreak);
      }
      for (const line of chunk.split('\n')) renderLine(doc, fragment, line, state, gaiji);
    });
    return fragment;
  }

  function renderLine(doc, fragment, line, state, gaiji) {
    const p = doc.createElement('p');
    const paragraph = {};
    let container = state.box;
    let hasText = false;

    // 前の行から続いている文字装飾（見出しの範囲指定など）を開き直す
    const stack = [];
    for (const open of state.open) pushInline(doc, stack, p, open);
    const current = () => (stack.length ? stack[stack.length - 1].el : p);

    for (const segment of parseLine(line)) {
      if (segment.tag) {
        const tag = parseTag(segment.tag);
        if (tag.kind === 'boxblock') {
          if (!tag.close) {
            state.box = createBox(doc, tag.params);
            fragment.append(state.box);
            if (!hasText) container = state.box;
          } else {
            if (!hasText) container = null;
            state.box = null;
          }
        } else if (PARAGRAPH_KINDS.has(tag.kind)) {
          if (!tag.close) paragraph[tag.kind] = tag.params;
        } else if (!tag.close) {
          if (tag.kind === 'caption') paragraph.center = [];
          if (tag.kind === 'midashi' || tag.kind === 'mado') tag.heading = state.nextHeading++;
          pushInline(doc, stack, p, tag);
        } else {
          closeInline(doc, stack, p, tag.kind);
        }
      } else if (segment.dropped !== undefined) {
        state.gaijiIndex += countGaiji(segment.dropped);
      } else if (segment.ruby !== undefined) {
        const ruby = doc.createElement('ruby');
        appendText(doc, ruby, segment.base, state, gaiji);
        const rt = doc.createElement('rt');
        appendText(doc, rt, segment.ruby, state, gaiji);
        // 《》はコピー時に読みを囲むためのもの（見た目には出さない）
        ruby.append(rubyParen(doc, '《'), rt, rubyParen(doc, '》'));
        current().append(ruby);
        hasText = true;
      } else {
        appendText(doc, current(), segment.text, state, gaiji);
        if (segment.text.trim()) hasText = true;
      }
    }

    state.open = stack.map(({ el, ...open }) => open);
    if (!hasText) p.classList.add('blank');
    applyParagraph(p, paragraph, container ? Number(container.dataset.indent) : 0);
    (container || fragment).append(p);
  }

  function pushInline(doc, stack, p, tag) {
    const parent = stack.length ? stack[stack.length - 1].el : p;
    const el = doc.createElement('span');
    el.className = 'az-' + tag.kind + (tag.level ? ' az-' + tag.kind + '-' + tag.level : '');
    const steps = Math.min(5, Math.max(1, tag.params[0] || 1));
    if (tag.kind === 'sizeup') el.style.fontSize = Math.pow(1.2, steps).toFixed(3) + 'em';
    if (tag.kind === 'sizedown') el.style.fontSize = Math.pow(1.2, -steps).toFixed(3) + 'em';
    if (tag.heading !== undefined) el.dataset.heading = String(tag.heading);
    parent.append(el);
    stack.push({ kind: tag.kind, params: tag.params, level: tag.level, heading: tag.heading, el });
  }

  // 範囲が入れ子になっていなくても閉じられるよう、上に積まれた装飾はいったん閉じて開き直す
  function closeInline(doc, stack, p, kind) {
    let index = -1;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].kind === kind) {
        index = k;
        break;
      }
    }
    if (index < 0) return;
    const reopen = stack.splice(index).slice(1);
    for (const open of reopen) pushInline(doc, stack, p, open);
  }

  function createBox(doc, [width = 0, indent = 0]) {
    const box = doc.createElement('div');
    box.className = 'az-boxblock';
    box.dataset.indent = String(Math.max(0, indent));
    if (indent > 0) box.style.marginLeft = indent + 'em';
    // 幅は枠線と内側の余白を足した外寸で指定する（box-sizing: border-box のため）
    if (width > 0) box.style.width = 'calc(' + width + 'em + 2 * var(--box-padding) + 2px)';
    return box;
  }

  // boxIndent：罫囲みの枠は字下げの位置から始まるので、枠の中の行はその分を差し引く
  function applyParagraph(p, paragraph, boxIndent) {
    let rest = 0;
    if (paragraph.indent) {
      const first = Math.max(0, (paragraph.indent[0] || 0) - boxIndent);
      rest = Math.max(0, (paragraph.indent[1] ?? paragraph.indent[0] ?? 0) - boxIndent);
      if (rest) p.style.paddingLeft = rest + 'em';
      if (first !== rest) p.style.textIndent = first - rest + 'em';
    }
    if (paragraph.right) p.style.textAlign = 'right';
    if (paragraph.center) p.style.textAlign = 'center';
    // 字詰め：Android 版は改行を差し込むが、ここでは行の最大幅で同じ折り返しにする
    if (paragraph.jizume) p.style.maxWidth = rest + Math.max(1, paragraph.jizume[0] || 1) + 'em';
  }

  // <rp> は Chrome が選択範囲の文字列から除くので、見えない span で代わりに持つ
  function rubyParen(doc, text) {
    const paren = doc.createElement('span');
    paren.className = 'rp';
    paren.textContent = text;
    return paren;
  }

  function countGaiji(text) {
    let count = 0;
    for (const ch of text) if (ch === GAIJI) count++;
    return count;
  }

  // 外字注記のあった ※ には説明をツールチップで付ける
  function appendText(doc, parent, text, state, gaiji) {
    let last = 0;
    for (let k = text.indexOf(GAIJI); k >= 0; k = text.indexOf(GAIJI, k + 1)) {
      if (k > last) parent.append(text.slice(last, k));
      const span = doc.createElement('span');
      span.className = 'gaiji';
      const description = gaiji[state.gaijiIndex++];
      if (description) span.title = '外字：' + description;
      span.textContent = '※';
      parent.append(span);
      last = k + 1;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  // ---- ルビの配置（Android 版 RubyCollisionResolver / RubyTextView の移植） ----
  // ルビは親文字の上に絶対配置し、本文の字間は広げない。長いルビは左右にはみ出させ、
  // 同じ行で隣のルビと重なるときはまとめて詰め直す。行（本文の段）の端からは出さない。

  function resolveCollisions(items, minX, maxX, gap) {
    if (!items.length) return [];
    const groups = buildGroups(items, gap);
    for (;;) {
      const resolved = resolveGroups(items, groups, minX, maxX, gap);
      let collision = -1;
      for (let g = 0; g < groups.length - 1; g++) {
        const left = groups[g];
        const right = groups[g + 1];
        if (resolved[left.end] + items[left.end].width + gapBefore(items, right.start, gap) > resolved[right.start]) {
          collision = g;
          break;
        }
      }
      if (collision < 0) return resolved;
      groups.splice(collision, 2, { start: groups[collision].start, end: groups[collision + 1].end });
    }
  }

  function buildGroups(items, gap) {
    const groups = [];
    let groupStart = 0;
    let occupiedRight = items[0].desiredLeft + items[0].width;
    for (let index = 1; index < items.length; index++) {
      const item = items[index];
      if (item.desiredLeft < occupiedRight + gapBefore(items, index, gap)) {
        occupiedRight = Math.max(occupiedRight, item.desiredLeft + item.width);
      } else {
        groups.push({ start: groupStart, end: index - 1 });
        groupStart = index;
        occupiedRight = item.desiredLeft + item.width;
      }
    }
    groups.push({ start: groupStart, end: items.length - 1 });
    return groups;
  }

  function gapBefore(items, index, defaultGap) {
    return index <= 0 ? 0 : Math.max(defaultGap, Math.max(0, items[index].minGapBefore || 0));
  }

  function resolveGroups(items, groups, minX, maxX, gap) {
    const resolved = new Array(items.length);
    const availableWidth = Math.max(0, maxX - minX);
    for (const group of groups) {
      let itemWidths = 0;
      let requestedGapWidth = 0;
      let desiredRight = -Infinity;
      for (let index = group.start; index <= group.end; index++) {
        itemWidths += items[index].width;
        if (index > group.start) requestedGapWidth += gapBefore(items, index, gap);
        desiredRight = Math.max(desiredRight, items[index].desiredLeft + items[index].width);
      }
      const keepRequestedGaps = itemWidths + requestedGapWidth <= availableWidth;
      const packedWidth = itemWidths + (keepRequestedGaps ? requestedGapWidth : 0);
      const centeredStart = (items[group.start].desiredLeft + desiredRight - packedWidth) / 2;
      const groupStart = packedWidth <= availableWidth ? Math.min(Math.max(centeredStart, minX), maxX - packedWidth) : centeredStart;

      let x = groupStart;
      for (let index = group.start; index <= group.end; index++) {
        resolved[index] = x;
        x += items[index].width;
        if (keepRequestedGaps && index < group.end) x += gapBefore(items, index + 1, gap);
      }
    }
    return resolved;
  }

  function hasKanji(text) {
    return /[㐀-鿿豈-﫿々〆ヵヶ]/.test(text);
  }

  // 親文字の文字列（読みと《》を除く）
  function rubyBaseText(ruby) {
    let text = '';
    for (const node of ruby.childNodes) {
      if (node.nodeName !== 'RT' && !(node.classList && node.classList.contains('rp'))) text += node.textContent;
    }
    return text;
  }

  // container：本文の段（ルビをはみ出させない範囲）。targets：配置する段落（省略時は全体）。
  // 長い作品では全部を一度に計算すると重いので、呼び出し側は画面の近くの段落だけを渡す
  function layoutRuby(container, targets = [container]) {
    const rubies = targets.flatMap((target) => Array.from(target.querySelectorAll('ruby')));
    if (!rubies.length) return;
    const doc = container.ownerDocument;
    const bounds = container.getBoundingClientRect();
    const pixel = 1; // Android 版の density 1 つ分の既定の間隔

    // 読み取りをまとめて済ませてから書き込む（レイアウトのやり直しを避ける）
    const lines = new Map();
    for (const ruby of rubies) {
      const rt = ruby.querySelector('rt');
      if (!rt) continue;
      const base = ruby.getBoundingClientRect();
      const rtRect = rt.getBoundingClientRect();
      const width = rtRect.width;
      if (!width || !base.width) continue;
      const p = ruby.closest('p');
      const key = p ? p : ruby;
      let byLine = lines.get(key);
      if (!byLine) lines.set(key, (byLine = new Map()));
      const lineKey = Math.round(base.top);
      if (!byLine.has(lineKey)) byLine.set(lineKey, []);
      byLine.get(lineKey).push({
        ruby,
        rt,
        baseLeft: base.left,
        desiredLeft: base.left + (base.width - width) / 2,
        width,
        // rt は line-height: 1 なので、高さがそのままルビの文字サイズ
        halfSpace: rtRect.height * 0.5,
      });
    }

    const writes = [];
    for (const byLine of lines.values()) {
      for (const placements of byLine.values()) {
        placements.forEach((placement, index) => {
          const previous = placements[index - 1];
          placement.minGapBefore = pixel;
          // 漢字の親文字どうしがかな・読点だけを挟んで並ぶときは、半角分あける
          if (previous && hasKanji(rubyBaseText(previous.ruby)) && hasKanji(rubyBaseText(placement.ruby))) {
            const range = doc.createRange();
            range.setStartAfter(previous.ruby);
            range.setEndBefore(placement.ruby);
            const between = range.toString();
            if (between && /^[ぁ-ゖァ-ヺー、，,]+$/.test(between)) {
              placement.minGapBefore = Math.max(pixel, previous.halfSpace, placement.halfSpace);
            }
          }
        });
        const resolved = resolveCollisions(placements, bounds.left, bounds.right, pixel);
        placements.forEach((placement, index) => writes.push([placement.rt, resolved[index] - placement.baseLeft]));
      }
    }
    for (const [rt, left] of writes) {
      rt.style.left = left.toFixed(2) + 'px';
      rt.style.transform = 'none';
    }
  }

  return { looksLikeAozora, prepare, parseLine, findImplicitBaseStart, render, layoutRuby, resolveCollisions, PAGE_BREAK, GAIJI };
})();

if (typeof module !== 'undefined') module.exports = AozoraText;
