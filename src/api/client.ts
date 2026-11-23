import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauriRuntime, tauriInvoke, tauriListen } from './tauriBridge';

export interface BrowserInfo {
  found: boolean;
  name: string | null;
  path: string | null;
}

export interface LegacyInstallInfo {
  detected: boolean;
  dataDir: string | null;
  hasSettings: boolean;
  runtimeBytes: number;
}

export interface SystemHealth {
  ok: boolean;
  appVersion: string;
  os: string;
  arch: string;
  dataDir: string;
  pythonRequired: boolean;
  browser: BrowserInfo;
  legacy: LegacyInstallInfo;
}

export const api = {
  isDesktop: isTauriRuntime,

  getHealth: async (): Promise<SystemHealth> => {
    if (!isTauriRuntime()) {
      return {
        ok: true,
        appVersion: '1.0.0-alpha.1 (Web 预览)',
        os: 'browser',
        arch: 'web',
        dataDir: '浏览器预览模式',
        pythonRequired: false,
        browser: { found: false, name: null, path: null },
        legacy: { detected: false, dataDir: null, hasSettings: false, runtimeBytes: 0 },
      };
    }
    return tauriInvoke<SystemHealth>('get_system_health');
  },

  chooseDirectory: async (title = '选择目录'): Promise<string | null> => {
    if (!isTauriRuntime()) return null;
    const selected = await open({ directory: true, multiple: false, title });
    return typeof selected === 'string' ? selected : null;
  },

  openExternalUrl: async (url: string): Promise<void> => {
    if (isTauriRuntime()) {
      await openUrl(url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  listen: tauriListen,
};
