import React from 'react';
import ReactDOM from 'react-dom/client';
import { HeroUIProvider, ToastProvider } from '@heroui/react';
import { MotionRoot } from './motion';
import { isTauriRuntime, tauriInvoke } from './api/tauriBridge';
import { api } from './api/client';
import App from './App';
import './index.css';

// 全局外链拦截：在 Tauri 桌面容器内点击任意 http(s) 链接，一律调用电脑默认浏览器打开
if (typeof window !== 'undefined' && isTauriRuntime()) {
  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href')?.trim() || '';
      if (!/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      void api.openExternalUrl(href).catch(() => {});
    },
    true,
  );

  window.addEventListener('error', (event) => {
    const msg = `${event.message || 'unknown error'} (${event.filename || ''}:${event.lineno || 0})`;
    void tauriInvoke('write_client_log', { level: 'ERROR', module: 'window', message: msg }).catch(() => {});
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? `${event.reason.message} | ${event.reason.stack || ''}` : String(event.reason);
    void tauriInvoke('write_client_log', { level: 'ERROR', module: 'promise', message: reason.slice(0, 800) }).catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MotionRoot>
      <HeroUIProvider>
        <ToastProvider placement="bottom-right" />
        <App />
      </HeroUIProvider>
    </MotionRoot>
  </React.StrictMode>,
);
