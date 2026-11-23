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

  // 启动时加载真实配置、素材库与 Rust 核心健康状态
  useEffect(() => {
    let active = true;
    void api.getSettings().then((s) => {
      if (active) setSettings(s);
    }).catch(() => {});
    void api.listLibrary().then((status) => {
      if (active) setLib(status.files);
    }).catch(() => {});
    return () => {
      active = false;
    };
  }, []);

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
    const timer = window.setInterval(() => {
      void refreshConnection();
    }, 10_000);
    return () => {
      active = false;
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
            <div className="sub">Rust 原生 · 跨场改写</div>
          </div>
        </div>

        <nav className="nav-group" aria-label="主导航">
          {NAV.map((item) =>
            'group' in item && item.group ? (
              <div key={item.id} className="nav-section">
                <div className="nav-section-title">{item.label}</div>
                {item.group.map((sub) => {
                  const active = view === sub.id;
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      className={`nav-item ${active ? 'active' : ''}`}
                      onClick={() => setView(sub.id)}
                    >
                      {active && <ActivePill layoutId="nav-active-pill" className="nav-active-pill" />}
                      <Icon name={sub.icon} className="ic" size={16} />
                      <span>{sub.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${view === item.id ? 'active' : ''}`}
                onClick={() => setView(item.id)}
              >
                {view === item.id && <ActivePill layoutId="nav-active-pill" className="nav-active-pill" />}
                <Icon name={item.icon} className="ic" size={16} />
                <span>{item.label}</span>
              </button>
            ),
          )}
        </nav>

        <div className="sidebar-foot">
          <div className="conn-pill" title="Rust 原生核心状态">
            <span className={`dot ${connection.system === 'online' ? 'ok' : ''}`} />
            <span>
              {connection.system === 'online'
                ? 'Rust 核心在线'
                : connection.system === 'checking'
                  ? '正在检测…'
                  : '核心离线'}
            </span>
          </div>
          <div className="conn-platforms">
            <span className={`plat-pill ${connection.douyin ? 'on' : ''}`}>抖音</span>
            <span className={`plat-pill ${connection.xhs ? 'on' : ''}`}>小红书</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">{crumbs || <b>首页</b>}</div>
          <button
            type="button"
            className="btn ghost sm"
            onClick={toggleTheme}
            title="切换浅色/深色主题"
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="ic" size={15} />
            <span>{theme === 'dark' ? '浅色' : '深色'}</span>
          </button>
        </header>
        <main className="page">
          <PageTransition viewKey={view} className="motion-page-stage">
            <View view={view} />
          </PageTransition>
        </main>
      </div>
    </div>
  );
}
