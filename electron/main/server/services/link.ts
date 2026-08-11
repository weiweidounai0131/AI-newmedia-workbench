/** 从平台分享文案中提取第一个 http(s) 链接。 */
const URL_TOKEN = /https?:\/\/[^\s<>"'“”‘’]+/i;
const TRAILING_PUNCTUATION = /[，。！？；：、）》】〉」』"'“”‘’!?;:)\]}>]+$/g;

export function extractHttpUrl(input: string): string {
  const candidate = input.match(URL_TOKEN)?.[0] || '';
  return candidate.replace(TRAILING_PUNCTUATION, '');
}
