// 共享 UI 工具
import { addToast, type ToastProps } from '@heroui/react';

type ToastColor = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';

const stableToast = (msg: string, color: ToastColor = 'success') =>
  addToast({ title: msg, color } as ToastProps);

/** 统一 toast 出口（返回稳定函数引用，彻底避免放进 useEffect 依赖引发无限重渲染循环） */
export function useToastMsg() {
  return stableToast;
}

/** 出图尺寸：'自动'→不传，其余 × 转 x。 */
export function mapSize(s: string): string | undefined {
  if (s === '自动') return undefined;
  return s.replace('×', 'x');
}

/** 出图质量：'自动'→auto */
export function mapQuality(q: string): 'auto' | 'low' | 'medium' | 'high' {
  if (q === '自动') return 'auto';
  return q as 'auto' | 'low' | 'medium' | 'high';
}

/** 复制文本 */
export function copyText(txt: string): void {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(txt).catch(() => fallbackCopy(txt));
      return;
    }
  } catch {
    /* ignore */
  }
  fallbackCopy(txt);
}
function fallbackCopy(txt: string) {
  try {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {
    /* ignore */
  }
}
