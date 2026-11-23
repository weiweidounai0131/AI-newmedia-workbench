import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** 检测当前是否运行在 Tauri 桌面容器内（兼容纯浏览器 Vite 预览） */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 统一调用 Rust Tauri Command，自动将错误规范化为 Error */
export async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error(`命令 ${command} 仅在桌面端运行时可用`);
  }
  try {
    return await invoke<T>(command, args);
  } catch (err: unknown) {
    if (err instanceof Error) throw err;
    if (typeof err === 'string') throw new Error(err);
    if (err && typeof err === 'object' && 'message' in err) {
      throw new Error(String((err as { message: unknown }).message));
    }
    throw new Error('桌面核心调用失败');
  }
}

/** 订阅 Rust 推送的实时事件（如原生下载进度、迁移进度、登录态更新） */
export async function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  return listen<T>(event, (e) => handler(e.payload));
}
