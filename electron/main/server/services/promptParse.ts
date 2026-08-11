// 单一事实源：BACKEND-PATH §3.2（提示词「一次生成 + 分隔符拆分」三级容错）
// 原型 parsePromptOutput 的服务端移植：把 DeepSeek 单段输出确定性拆成
// 文字文案(outText) + 图片提示词(outImg)，并给出 parseMode 供前端提示条。

export type ParseMode = 'delim' | 'partial' | 'fallback' | 'failed' | 'single';

export interface ParseResult {
  outText: string;
  outImg: string;
  outImgs: string[];
  raw: string;
  parseMode: ParseMode;
  note: string;
}

// 当前图文契约：#文字 + ------ + #图片提示词；兼容旧版分隔符，避免历史任务无法查看。
const TEXT_HEADER_RE = /^\s*#\s*文字\s*$/;
const IMG_HEADER_RE = /^\s*#\s*图片\s*提示词\s*(\d+)?\s*$/;
const DASH_DELIM_RE = /^\s*-{3,}\s*$/;
// 旧版分隔符：整行 ===[IMG_PROMPT]===（大小写/方括号/空格宽松匹配）
const DELIM_RE = /^[ \t]*={2,}[ \t]*\[?[ \t]*IMG[ \t_\-]*PROMPT[ \t]*\]?[ \t]*={2,}[ \t]*$/i;
// 语义标题兜底：无明显分隔符但有小标题
const FALLBACK_RE = /【?\s*图片?\s*提示词\s*】?|image\s*prompt\s*:/i;

const DELIM_NOTE = '已按图文格式拆分为文案与图片提示词';
const PARTIAL_NOTE = '已拆分图文内容，但有图片提示词缺失，请补齐后再出图';
const FALLBACK_NOTE = '未命中严格分隔符，已按标题兜底拆分，请核对';
const FAILED_NOTE = '未识别到图片提示词段落，已整段作为文案，图片框留空';
const SINGLE_NOTE = '仅图片模式：整段作为图片提示词';

export function parsePromptOutput(raw: string, type: 'tp' | 'img', imageCount = 1): ParseResult {
  const text = (raw ?? '').trim();
  const lines = text.split(/\r?\n/);
  const count = Math.min(9, Math.max(1, imageCount));
  const allImageHeaders = lines
    .map((line, index) => ({ line, index, match: IMG_HEADER_RE.exec(line) }))
    .filter((item) => item.match);

  if (type === 'img') {
    if (!allImageHeaders.length) {
      const outImgs = Array.from({ length: count }, (_, index) => index === 0 ? text : '');
      return {
        outText: '', outImg: text, outImgs, raw: text,
        parseMode: count === 1 ? 'single' : 'partial',
        note: count === 1 ? SINGLE_NOTE : PARTIAL_NOTE,
      };
    }
    const outImgs = Array.from({ length: count }, () => '');
    allImageHeaders.forEach((header, sequence) => {
      const next = allImageHeaders[sequence + 1];
      const prompt = lines.slice(header.index + 1, next ? next.index : lines.length).join('\n').trim();
      const number = Number(header.match?.[1]) || sequence + 1;
      if (number >= 1 && number <= outImgs.length) outImgs[number - 1] = prompt;
    });
    const complete = outImgs.every(Boolean);
    return {
      outText: '', outImg: outImgs[0] || '', outImgs, raw: text,
      parseMode: complete ? 'single' : 'partial',
      note: complete ? SINGLE_NOTE : PARTIAL_NOTE,
    };
  }

  const textIdx = lines.findIndex((line) => TEXT_HEADER_RE.test(line));
  const dashIdx = textIdx >= 0 ? lines.findIndex((line, index) => index > textIdx && DASH_DELIM_RE.test(line)) : -1;
  const imageHeaders = dashIdx >= 0
    ? lines.map((line, index) => ({ line, index, match: IMG_HEADER_RE.exec(line) })).filter((item) => item.index > dashIdx && item.match)
    : [];

  if (textIdx >= 0 && dashIdx >= 0 && imageHeaders.length) {
    const outText = lines.slice(textIdx + 1, dashIdx).join('\n').trim();
    const outImgs = Array.from({ length: count }, () => '');
    imageHeaders.forEach((header, sequence) => {
      const next = imageHeaders[sequence + 1];
      const prompt = lines.slice(header.index + 1, next ? next.index : lines.length).join('\n').trim();
      const number = Number(header.match?.[1]) || sequence + 1;
      if (number >= 1 && number <= outImgs.length) outImgs[number - 1] = prompt;
    });
    const outImg = outImgs[0] || '';
    if (outText || outImgs.some(Boolean)) {
      const complete = outImgs.every(Boolean);
      return { outText, outImg, outImgs, raw: text, parseMode: complete ? 'delim' : 'partial', note: complete ? DELIM_NOTE : PARTIAL_NOTE };
    }
  }

  const delimIdx = lines.findIndex((l) => DELIM_RE.test(l));

  if (delimIdx >= 0) {
    const outText = lines.slice(0, delimIdx).join('\n').trim();
    const outImg = lines.slice(delimIdx + 1).join('\n').trim();
    return { outText, outImg, outImgs: outImg ? [outImg] : [], raw: text, parseMode: 'delim', note: DELIM_NOTE };
  }

  const fbIdx = lines.findIndex((l) => FALLBACK_RE.test(l));
  if (fbIdx >= 0) {
    const outText = lines.slice(0, fbIdx).join('\n').trim();
    const outImg = lines.slice(fbIdx + 1).join('\n').trim();
    return { outText, outImg, outImgs: outImg ? [outImg] : [], raw: text, parseMode: 'fallback', note: FALLBACK_NOTE };
  }

  return { outText: text, outImg: '', outImgs: [], raw: text, parseMode: 'failed', note: FAILED_NOTE };
}
