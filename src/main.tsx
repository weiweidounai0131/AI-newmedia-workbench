import React from 'react';
import ReactDOM from 'react-dom/client';
import { HeroUIProvider, ToastProvider } from '@heroui/react';
import { MotionRoot } from './motion';
import { isTauriRuntime, tauriInvoke } from './api/tauriBridge';
import App from './App';
import './index.css';

// 静默捕获前端未处理异常并写入开发者本地日志（用户界面不可见）
if (typeof window !== 'undefined' && isTauriRuntime()) {
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
