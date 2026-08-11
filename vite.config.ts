// 独立渲染进程配置：用于 M2 阶段「不依赖 Electron」也能对前端做构建/本地预览验证。
// 真实打包时由 electron-vite 读取 electron.vite.config.ts（renderer 段与之等价）。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    // 注意：不要再给 /api 配 proxy 到后端。
    // 原因：前端客户端代码目录就是 src/api/，在 root:'src' 下会以 /api/client.ts 这种
    // URL 被 Vite 提供；若把 /api 代理到后端，浏览器加载该模块时会被抢发到后端 → 404 → 白屏。
    // 而前端 client.ts 的 base() 在浏览器里直接返回 http://127.0.0.1:8787（绝对地址），
    // API 调用本就不走 Vite 代理（后端已开 CORS），所以这里无需 proxy。
  },
  build: {
    outDir: '../out/renderer',
    emptyOutDir: true,
  },
});
