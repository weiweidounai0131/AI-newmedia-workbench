import { useEffect, useState } from 'react';
import { useApp, setView, toggleTheme, loadHotRanks, setLib } from './store/appStore';
import { Icon } from './icons';
import { api } from './api/client';
import Home from './views/Home';
import Xuanti from './views/Xuanti';
import Chuangyi from './views/Chuangyi';
import Xigao from './views/Xigao';
import Tishici from './views/Tishici';
import Chutu from './views/Chutu';
import Sucai from './views/Sucai';
import Settings from './views/Settings';
import appIcon from './assets/app-icon.png';
import { FirstRunGuide } from './components/FirstRunGuide';

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
  const [connection, setConnection] = useState<{ system: 'checking' | 'online' | 'offline'; douyin: boolean | null; xhs: boolean | null }>({ system: 'checking', douyin: null, xhs: null });
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('newmedia-onboarding-complete') === '1') return;
    void api.runtimeStatus().then((status) => setShowOnboarding(status.packaged)).catch(() => {});
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-theme', theme);
    el.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // 热榜只在每个整点自动换一版；普通页面切换始终复用当前小时的结果。
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

  // 首页统计也读取真实素材库，避免首次打开首页时把已有本地文件误显示为 0。
  useEffect(() => {
    let active = true;
    void api.listLibrary().then((status) => {
      if (active) setLib(status.files);
    }).catch(() => {
      // 素材库尚未设置不影响工作台其他模块。
    });
    return () => { active = false; };
  }, []);

  // 侧栏常驻显示真实的抓取登录态；切换到设置页登录后最多 10 秒自动同步。
  useEffect(() => {
    let active = true;
    const refreshConnection = async () => {
      try {
        const status = await api.scrapeStatus();
        if (active) setConnection({ system: 'online', douyin: Boolean(status.platforms?.['抖音']), xhs: Boolean(status.platforms?.['小红书']) });
      } catch {
        if (active) setConnection({ system: 'offline', douyin: null, xhs: null });
      }
    };
    void refreshConnection();
    const timer = window.setInterval(() => { void refreshConnection(); }, 10_000);
    return () => { active = false; window.clearInterval(timer); };
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
        <nav className="nav-group">
          {NAV.map((n) =>
            n.group ? (
              <div key={n.id}>
                <div className="nav-label">{n.label}</div>
                <div className="nav-sub">
                  {n.group.map((s) => (
                    <button
                      key={s.id}
                      className={`nav-item ${view === s.id ? 'active' : ''}`}
                      onClick={() => setView(s.id)}
                    >
                      <Icon name={s.icon} className="ic" size={19} />
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <button
                key={n.id}
                className={`nav-item ${view === n.id ? 'active' : ''}`}
                onClick={() => setView(n.id)}
              >
                <Icon name={n.icon} className="ic" size={19} />
                {n.label}
              </button>
            ),
          )}
        </nav>
        <div className="sidebar-foot">
          <button className="theme-toggle" onClick={toggleTheme}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="ic" size={16} />
            {theme === 'dark' ? '浅色模式' : '深色模式'}
          </button>
          <div className="connection-status" aria-label="本地服务与平台 Cookie 状态">
            <div className="local-badge"><span className={`dot ${connection.system === 'online' ? 'success' : connection.system === 'offline' ? 'danger' : 'warning'}`} />localhost · {connection.system === 'online' ? '已连接' : connection.system === 'offline' ? '未连接' : '检测中'}</div>
            <div className="local-badge"><span className={`dot ${connection.douyin ? 'success' : connection.douyin === null ? 'warning' : 'muted'}`} />抖音 Cookie · {connection.douyin ? '已获取' : connection.douyin === null ? '检测中' : '未获取'}</div>
            <div className="local-badge"><span className={`dot ${connection.xhs ? 'success' : connection.xhs === null ? 'warning' : 'muted'}`} />小红书 Cookie · {connection.xhs ? '已获取' : connection.xhs === null ? '检测中' : '未获取'}</div>
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
          <View view={view} />
        </main>
      </div>
      <FirstRunGuide open={showOnboarding} onFinish={() => {
        localStorage.setItem('newmedia-onboarding-complete', '1');
        setShowOnboarding(false);
      }} />
    </div>
  );
}
