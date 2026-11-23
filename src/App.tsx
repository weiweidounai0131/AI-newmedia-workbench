import { useEffect, useState } from 'react';
import { api, type SystemHealth } from './api/client';
import { Icon } from './icons';
import {
  ActivePill,
  InteractiveCard,
  PageTransition,
  SpringModal,
  SpringProgress,
  StaggerItem,
  m,
} from './motion';
import appIcon from './assets/app-icon.png';

type ViewId = 'home' | 'xuanti' | 'chuangyi' | 'xigao' | 'tishici' | 'chutu' | 'sucai' | 'settings';

const NAV = [
  { id: 'home' as const, label: '首页', icon: 'home' },
  {
    id: 'content' as const,
    label: '内容',
    icon: 'layers',
    group: [
      { id: 'xuanti' as const, label: '选题', icon: 'target' },
      { id: 'chuangyi' as const, label: '创意', icon: 'spark' },
      { id: 'xigao' as const, label: '洗稿', icon: 'pen' },
      { id: 'tishici' as const, label: '提示词', icon: 'wand' },
      { id: 'chutu' as const, label: '出图', icon: 'image' },
    ],
  },
  { id: 'sucai' as const, label: '素材库', icon: 'archive' },
  { id: 'settings' as const, label: '设置', icon: 'settings' },
];

const TITLES: Record<ViewId, string> = {
  home: '首页',
  xuanti: '选题',
  chuangyi: '创意',
  xigao: '洗稿',
  tishici: '提示词生成',
  chutu: '出图',
  sucai: '素材库',
  settings: '设置',
};

const PHASE_MAP: Record<ViewId, { phase: string; summary: string; highlights: string[] }> = {
  home: {
    phase: 'Phase 0 基座已就绪',
    summary: 'Tauri 2 + Rust 原生核心与 Motion 动效基座已搭建完成，零 Electron、零 Python 运行时。',
    highlights: ['原生 WKWebView / WebView2 桌面壳', 'Motion 物理弹簧导航与页面切换', '系统 Chrome / Edge 自动探测'],
  },
  xuanti: {
    phase: 'Phase 1 + Phase 3',
    summary: '抖音 & 小红书整点热榜 + Rust 原生 CDP 主动搜索（彻底移除 MediaCrawler Python 环境）。',
    highlights: ['60s.viki.moe 整点热榜缓存', 'CDP 旁听搜索 API 响应 JSON', '统一选题收集与 Excel 导出'],
  },
  chuangyi: {
    phase: 'Phase 1',
    summary: 'Rust 原生多协议 AI 代理驱动创作方向生成、正文撰写、迭代优化与 Word 导出。',
    highlights: ['OpenAI Chat / Responses / Anthropic 协议', '原生 docx-rs 纯 Rust 导出'],
  },
  xigao: {
    phase: 'Phase 4',
    summary: '彻底消灭 wechat-mp-tools 与 iframe 弹窗，Rust 原生无水印下载 + 统一进度条与识别洗稿。',
    highlights: ['抖音原生 a_bogus 无水印视频直下', '小红书共享 CDP 会话图文并发下载', '统一 SpringProgress 解析卡片'],
  },
  tishici: {
    phase: 'Phase 1',
    summary: '稿件转文案/图片提示词，原生 Rust 解析器稳定拆分多图提示词。',
    highlights: ['自定义分隔符容错解析', '一键带入出图工作台'],
  },
  chutu: {
    phase: 'Phase 1',
    summary: '支持自定义图像模型 API 与本机 Codex CLI 订阅出图，支持参考图编辑与归档。',
    highlights: ['多尺寸与质量控制', '本地素材库一键归档'],
  },
  sucai: {
    phase: 'Phase 1',
    summary: '以磁盘文件为唯一事实源，Rust 原生高频扫描、预览与 Word/Excel 双向解析导出。',
    highlights: ['四类目录自动同步', '零第三方运行时依赖'],
  },
  settings: {
    phase: 'Phase 1 + Phase 2',
    summary: '四能力 AI 模型独立配置 + 系统钥匙串加密 + 旧版 Electron 专属无损迁移工具。',
    highlights: ['macOS Keychain / Windows 凭据库', '自动解密旧版 safeStorage / DPAPI / AES', '可选一键清理 876 MB 旧版 Python 运行时'],
  },
};

function formatMB(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export default function App() {
  const [view, setView] = useState<ViewId>('home');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [motionDemoOpen, setMotionDemoOpen] = useState(false);
  const [demoPercent, setDemoPercent] = useState(36);

  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-theme', theme);
    el.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    let active = true;
    void api.getHealth().then((res) => {
      if (active) setHealth(res);
    }).catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const title = TITLES[view];
  const isContentGroup = ['xuanti', 'chuangyi', 'xigao', 'tishici', 'chutu'].includes(view);
  const meta = PHASE_MAP[view];

  return (
    <div className="app">
      <aside className="sidebar" id="sidebar">
        <div className="brand">
          <img className="logo brand-app-icon" src={appIcon} alt="AI新媒体工作台" />
          <div>
            <div className="name">AI新媒体工作台</div>
            <div className="sub">Rust 原生 · 双平台轻量版</div>
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
          <div className="conn-pill" title="Rust 核心与零 Python 运行态">
            <span className={`dot ${health?.ok ? 'ok' : ''}`} />
            <span>{health?.ok ? 'Rust 核心在线' : '检测运行态…'}</span>
          </div>
          <div className="tiny" style={{ color: 'var(--text-3)', marginTop: 6, paddingLeft: 4 }}>
            {health ? `${health.os}/${health.arch} · v${health.appVersion}` : 'Tauri 2 Native'}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumbs">
            {view === 'home' ? (
              <b>首页</b>
            ) : isContentGroup ? (
              <>
                <span>内容</span>
                <Icon name="chevron" className="ic" size={14} />
                <b>{title}</b>
              </>
            ) : (
              <b>{title}</b>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setMotionDemoOpen(true)}
            >
              动效预览
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
              title="切换浅色/深色主题"
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="ic" size={15} />
              <span>{theme === 'dark' ? '浅色' : '深色'}</span>
            </button>
          </div>
        </header>

        <main className="page">
          <PageTransition viewKey={view} className="motion-page-stage">
            <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="card" style={{ padding: 22 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <span className="badge" style={{ marginBottom: 8, display: 'inline-block' }}>
                      {meta.phase}
                    </span>
                    <h2 style={{ margin: '4px 0 6px', fontSize: 20, fontWeight: 700 }}>{title}</h2>
                    <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 13.5 }}>{meta.summary}</p>
                  </div>
                </div>
              </div>

              {view === 'home' ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
                  <StaggerItem index={0}>
                    <InteractiveCard className="card" onClick={() => setView('settings')}>
                      <div style={{ padding: 18 }}>
                        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>运行时架构</div>
                        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>Tauri 2 + Rust 原生</div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 6 }}>
                          零 Electron · 零 Python 环境 · 零 iframe 嵌套
                        </div>
                      </div>
                    </InteractiveCard>
                  </StaggerItem>

                  <StaggerItem index={1}>
                    <InteractiveCard className="card" onClick={() => setView('xuanti')}>
                      <div style={{ padding: 18 }}>
                        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>本机浏览器引擎（Phase 3 CDP）</div>
                        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>
                          {health?.browser.found ? `已就绪 · ${health.browser.name}` : '未检测到 Chrome / Edge'}
                        </div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 6, wordBreak: 'break-all' }}>
                          {health?.browser.path || '首次采集前将引导复用本机浏览器'}
                        </div>
                      </div>
                    </InteractiveCard>
                  </StaggerItem>

                  <StaggerItem index={2}>
                    <InteractiveCard className="card" onClick={() => setView('settings')}>
                      <div style={{ padding: 18 }}>
                        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>旧版 Electron 数据探测（Phase 2 迁移）</div>
                        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6 }}>
                          {health?.legacy.detected ? '检测到旧版配置' : '未检测到旧版目录'}
                        </div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 6 }}>
                          {health?.legacy.detected
                            ? `旧版可释放运行时约 ${formatMB(health.legacy.runtimeBytes)}`
                            : '支持随时在设置页手动导入旧版配置'}
                        </div>
                      </div>
                    </InteractiveCard>
                  </StaggerItem>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                  {meta.highlights.map((item, idx) => (
                    <StaggerItem key={item} index={idx}>
                      <div className="card" style={{ padding: 16 }}>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{item}</div>
                      </div>
                    </StaggerItem>
                  ))}
                </div>
              )}
            </div>
          </PageTransition>
        </main>
      </div>

      <SpringModal open={motionDemoOpen} onClose={() => setMotionDemoOpen(false)} maxWidth={460}>
        <div className="modal-head">
          <h3>Motion 物理动效基座验证</h3>
          <button type="button" className="modal-close" onClick={() => setMotionDemoOpen(false)}>
            ×
          </button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
            当前已接入 <code>motion/react</code>（LazyMotion + MotionConfig reducedMotion），用于导航滑块、页面过渡、原生下载进度和弹窗层。
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
              <span>原生下载进度弹性补间预览</span>
              <b>{demoPercent}%</b>
            </div>
            <SpringProgress percent={demoPercent} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[15, 52, 84, 100].map((v) => (
              <m.button
                key={v}
                type="button"
                className="btn ghost sm"
                whileTap={{ scale: 0.96 }}
                onClick={() => setDemoPercent(v)}
              >
                {v}%
              </m.button>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn primary sm" onClick={() => setMotionDemoOpen(false)}>
            完成
          </button>
        </div>
      </SpringModal>
    </div>
  );
}
