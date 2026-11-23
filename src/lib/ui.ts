// 共享 UI 工具
import { addToast, type ToastProps } from '@heroui/react';

type ToastColor = 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';

/** 统一 toast 出口（对齐原型 toast()） */
export function useToastMsg() {
  return (msg: string, color: ToastColor = 'success') =>
    addToast({ title: msg, color } as ToastProps);
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
