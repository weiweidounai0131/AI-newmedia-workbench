import React from 'react';
import ReactDOM from 'react-dom/client';
import { HeroUIProvider, ToastProvider } from '@heroui/react';
import { MotionRoot } from './motion';
import App from './App';
import './index.css';

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
