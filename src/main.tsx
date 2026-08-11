import React from 'react';
import ReactDOM from 'react-dom/client';
import { HeroUIProvider, ToastProvider } from '@heroui/react';
import App from './App';
import './index.css';

// HeroUI 默认主色即为 #0072F5，与 BACKEND-PATH §0 品牌色一致，无需 extendTheme。
// 深色模式由 App 在 <html> 上切 data-theme + .dark 类驱动。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HeroUIProvider>
      <ToastProvider placement="bottom-right" />
      <App />
    </HeroUIProvider>
  </React.StrictMode>,
);
