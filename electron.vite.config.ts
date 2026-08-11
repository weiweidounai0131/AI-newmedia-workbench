import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 入口用绝对路径，避免 main/preload 的 root 相对解析歧义（electron-vite 2.3 自动探测未命中本工程结构）
const entry = (p: string) => resolve(process.cwd(), p);

// 单一事实源：BACKEND-PATH §0（工程结构）/ §7（electron-vite）
// 主进程 = Express 后端 + 抓取 + 封装；渲染进程 = React + Vite
export default defineConfig({
  main: {
    build: {
      // 主进程必须是 CJS：项目根 type:module 会让 Electron 用 ESM loader 误加载，
      // 显式输出 cjs 并在 out/main/package.json 声明 commonjs 规避
      lib: { entry: entry('electron/main/index.ts'), formats: ['cjs'] },
      rollupOptions: {
        // electron 自身与 node 内置模块不打包进产物
        external: ['electron', 'better-sqlite3'],
        // format:cjs 保证内容是 CJS；entryFileNames 强制文件名 index.js
        // （electron-vite 启动 electron 时硬编码找 out/main/index.js，且 dev 会清掉 out/main/package.json）
        output: { format: 'cjs', exports: 'named' },
      },
    },
  },
  preload: {
    build: {
      // Electron preload is executed as CommonJS even when the app package is
      // type:module. Keeping this explicit prevents a packaged white screen.
      lib: { entry: entry('electron/preload/index.ts'), formats: ['cjs'] },
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    root: 'src',
    build: {
      // 本工程渲染入口是扁平的 src/index.html（非 electron-vite 约定的 src/renderer/index.html），需显式指定绝对路径
      rollupOptions: { input: entry('src/index.html') },
      outDir: 'out/renderer',
    },
    plugins: [react()],
  },
});
