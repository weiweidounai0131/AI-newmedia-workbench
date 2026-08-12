// 预加载脚本：仅向渲染进程暴露「本地后端地址」等安全桥接。
// 前端永不持有供应商 Key（BACKEND-PATH §6.2）。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  getApiBase: (): Promise<string> => ipcRenderer.invoke('api-base'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app-version'),
  chooseLibraryRoot: (): Promise<string | null> => ipcRenderer.invoke('choose-library-root'),
  checkForUpdates: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('check-for-updates'),
  getUpdateStatus: (): Promise<unknown> => ipcRenderer.invoke('get-update-status'),
  onUpdateStatus: (callback: (status: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
});
