import { useEffect, useState } from 'react';
import { useApp, setView, toggleTheme, loadHotRanks, setLib, setSettings } from './store/appStore';
import { Icon } from './icons';
import { api } from './api/client';
import { ActivePill, PageTransition } from './motion';
import Home from './views/Home';
import Xuanti from './views/Xuanti';
import Chuangyi from './views/Chuangyi';
import Xigao from './views/Xigao';
import Tishici from './views/Tishici';
import Chutu from './views/Chutu';
import Sucai from './views/Sucai';
import Settings from './views/Settings';
import { useToastMsg } from './lib/ui';
import appIcon from './assets/app-icon.png';

const NAV = [
  { id: 'home', label: '首页', icon: 'home' },
  {
    id: 'content',
    label: '内容',
    icon: 'layers',
    group: [
      { id: 'xuanti', label: '选题', icon: 'target' },
      { id: 'chuangyi', label: '创意', icon: 'spark' },
      { id: 'xigao', label: '洗稿', icon: 'pen' },
      { id: 'tishici', label: '提示词', icon: 'wand' },
      { id: 'chutu', label: '出图', icon: 'image' },
    ],
  },
  { id: 'sucai', label: '素材库', icon: 'archive' },
  { id: 'settings', label: '设置', icon: 'settings' },
];

const TITLES: Record<string, string> = {
  home: '首页',
  xuanti: '选题',
  chuangyi: '创意',
  xigao: '洗稿',
  tishici: '提示词生成',
  chutu: '出图',
  sucai: '素材库',
  settings: '设置',
};

function View({ view }: { view: string }) {
  switch (view) {
    case 'home':
      return <Home />;
    case 'xuanti':
      return <Xuanti />;
    case 'chuangyi':
      return <Chuangyi />;
    case 'xigao':
      return <Xigao />;
    case 'tishici':
      return <Tishici />;
    case 'chutu':
      return <Chutu />;
    case 'sucai':
      return <Sucai />;
    case 'settings':
      return <Settings />;
    default:
      return <Home />;
  }
}

export default function App() {
  const view = useApp((s) => s.view);
  const theme = useApp((s) => s.theme);
  const toast = useToastMsg();
  const [connection, setConnection] = useState<{ system: 'checking' | 'online' | 'offline'; douyin: boolean | null; xhs: boolean | null }>({
    system: 'checking',
    douyin: null,
    xhs: null,
  });

  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-theme', theme);
    el.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // 热榜整点自动刷新；普通切页始终复用当前小时 Rust 内存缓存
  useEffect(() => {
    let timer = 0;
    const scheduleNextHour = () => {
      const now = new Date();
      const next = new Date(now);
      next.setMinutes(60, 0, 250);
      timer = window.setTimeout(() => {
        void loadHotRanks();
        scheduleNextHour();
      }, Math.max(1_000, next.getTime() - now.getTime()));
    };
    scheduleNextHour();
    return () => window.clearTimeout(timer);
  }, []);

  // 启动时加载真实配置与素材库
  useEffect(() => {
    let active = true;
    void api.getSettings().then((s) => {
      if (active) setSettings(s);
    }).catch(() => {});
    void api.listLibrary().then((status) => {
      if (active) setLib(status.files);
    }).catch(() => {});
    // 启动 6 秒后静默检查一次软件更新（仅在有新版本时温和提示，无更新或离线完全静默）
    const updateTimer = window.setTimeout(() => {
      void api
        .checkForUpdates()
        .then((res) => {
          if (active && res.ok && res.available && res.version) {
            toast(`发现新版本 v${res.version}，可前往「设置 → 软件更新」一键升级`, 'primary');
          }
        })
        .catch(() => {});
    }, 6_000);
    return () => {
      active = false;
      window.clearTimeout(updateTimer);
    };
  }, []);

  // 侧栏常驻显示真实的内核与平台登录态
  useEffect(() => {
    let active = true;
    const refreshConnection = async () => {
      try {
        const [health, status] = await Promise.all([api.getHealth(), api.scrapeStatus()]);
        if (active) {
          setConnection({
            system: health.ok ? 'online' : 'offline',
            douyin: Boolean(status.platforms?.['抖音']),
            xhs: Boolean(status.platforms?.['小红书']),
          });
        }
      } catch {
        if (active) setConnection({ system: 'offline', douyin: null, xhs: null });
      }
    };
    void refreshConnection();
    const onChanged = () => {
      void refreshConnection();
    };
    window.addEventListener('scrape-status-changed', onChanged);
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshConnection();
    }, 30_000);
    return () => {
      active = false;
      window.removeEventListener('scrape-status-changed', onChanged);
      window.clearInterval(timer);
    };
  }, []);

  const title = TITLES[view] || '';
  const crumbs =
    view === 'home' ? null : ['xuanti', 'chuangyi', 'xigao', 'tishici', 'chutu'].includes(view) ? (
      <>
        <span>内容</span>
        <Icon name="chevron" className="ic" size={14} />
        <b>{title}</b>
      </>
    ) : (
      <b>{title}</b>
    );

  return (
    <div className="app">
      <aside className="sidebar" id="sidebar">
        <div className="brand">
          <img className="logo brand-app-icon" src={appIcon} alt="AI新媒体工作台" />
          <div>
            <div className="name">AI新媒体工作台</div>
            <div className="sub">本地 · 跨场改写</div>
          </div>
        </div>

        <nav className="nav-group" aria-label="主导航">
          {NAV.map((n) =>
            n.group ? (
              <div key={n.id}>
                <div className="nav-label">{n.label}</div>
                <div className="nav-sub">
                  {n.group.map((s) => {
                    const active = view === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className={`nav-item ${active ? 'active' : ''}`}
                        onClick={() => setView(s.id)}
                      >
                        {active && <ActivePill layoutId="nav-active-pill" className="nav-active-pill" />}
                        <Icon name={s.icon} className="ic" size={19} />
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <button
                key={n.id}
                type="button"
                className={`nav-item ${view === n.id ? 'active' : ''}`}
                onClick={() => setView(n.id)}
              >
                {view === n.id && <ActivePill layoutId="nav-active-pill" className="nav-active-pill" />}
                <Icon name={n.icon} className="ic" size={19} />
                {n.label}
              </button>
            ),
          )}
        </nav>

        <div className="sidebar-foot">
          <button type="button" className="theme-toggle" onClick={toggleTheme}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="ic" size={16} />
            {theme === 'dark' ? '浅色模式' : '深色模式'}
          </button>
          <div className="connection-status" aria-label="本地内核与平台 Cookie 状态">
            <div className="local-badge">
              <span
                className={`dot ${
                  connection.system === 'online'
                    ? 'success'
                    : connection.system === 'offline'
                      ? 'danger'
                      : 'warning'
                }`}
              />
              Rust 内核 · {connection.system === 'online' ? '已连接' : connection.system === 'offline' ? '未连接' : '检测中'}
            </div>
            <div className="local-badge">
              <span className={`dot ${connection.douyin ? 'success' : connection.douyin === null ? 'warning' : 'muted'}`} />
              抖音 Cookie · {connection.douyin ? '已获取' : connection.douyin === null ? '检测中' : '未获取'}
            </div>
            <div className="local-badge">
              <span className={`dot ${connection.xhs ? 'success' : connection.xhs === null ? 'warning' : 'muted'}`} />
              小红书 Cookie · {connection.xhs ? '已获取' : connection.xhs === null ? '检测中' : '未获取'}
            </div>
          </div>
          <div className="sidebar-copyright">Copyright © 2026 jiangjiawei. 保留所有权利。</div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="crumbs">{crumbs}</div>
          <div className="spacer" />
        </header>
        <main className="view">
          <PageTransition viewKey={view} className="motion-page-stage">
            <View view={view} />
          </PageTransition>
        </main>
      </div>
    </div>
  );
}
