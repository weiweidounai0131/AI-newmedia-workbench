import { useEffect, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { useApp, setView, setXuanti, WORKFLOW_STEPS, loadHotRanks } from '../store/appStore';
import { api } from '../api/client';
import { Icon } from '../icons';
import { MOTION_SPRING, MagneticFilings, SpringProgress, StaggerItem, m } from '../motion';
import { PLAT_COLORS } from '../data/sample';

function clockStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${wk} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function greetingPrefix(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

const QUICK_ITEMS = [
  { id: 'xuanti', icon: 'target', t: '去选题', d: '四平台热榜 / 主动搜索', tone: 'blue' },
  { id: 'xigao', icon: 'pen', t: '去洗稿', d: '抖音视频 / 小红书图文', tone: 'amber' },
  { id: 'tishici', icon: 'wand', t: '生成提示词', d: '文案 + 文生图拆解', tone: 'violet' },
  { id: 'sucai', icon: 'archive', t: '翻素材库', d: '统计概览 / 本地归档', tone: 'emerald' },
] as const;

export default function Home() {
  const theme = useApp((s) => s.theme);
  const wf = useApp((s) => s.workflow);
  const topics = useApp((s) => s.xuanti.topics);
  const libraryFiles = useApp((s) => s.lib);
  const [now, setNow] = useState(clockStr());
  const [greeting, setGreeting] = useState(greetingPrefix());
  const hotRanks = useApp((s) => s.hotRanks);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(clockStr());
      setGreeting(greetingPrefix());
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void loadHotRanks();
  }, []);

  const doneCount = WORKFLOW_STEPS.filter((s) => (wf as any)[s]).length;
  const progressPct = Math.round((doneCount / WORKFLOW_STEPS.length) * 100);

  let statusText = '';
  if (doneCount === 0) statusText = '从热点或主动搜索起步，快速搭好今天的内容选题池。';
  else if (doneCount === 1) statusText = '选题已就位，下一步可以进入洗稿改写或借势创意。';
  else if (doneCount === 2) statusText = '文案已在推进中，继续提炼视觉提示词或打磨创意。';
  else if (doneCount === 3) statusText = '提示词已确认，直接进入出图模块生成成品视觉。';
  else if (doneCount === 4) statusText = '内容已接近完成，别忘了导出到本地素材库归档。';
  else statusText = '本轮全链路已完成，随时可以开启下一组内容创作。';

  const primaryAction =
    doneCount === 0
      ? { label: '去做选题', icon: 'target', onPress: () => { setXuanti({ tab: 'hot' }); setView('xuanti'); } }
      : doneCount === 1
        ? { label: '进入洗稿', icon: 'pen', onPress: () => setView('xigao') }
        : doneCount === 2
          ? { label: '生成提示词', icon: 'wand', onPress: () => setView('tishici') }
          : doneCount === 3
            ? { label: '前往出图', icon: 'image', onPress: () => setView('chutu') }
            : { label: '查看素材库', icon: 'archive', onPress: () => setView('sucai') };

  const stats = [
    {
      v: String(topics.length),
      k: '今日选题',
      trend: topics.length ? '已入选题表' : '待采集',
      icon: 'target',
      tone: 'blue',
      onClick: () => { setXuanti({ tab: 'topics' }); setView('xuanti'); },
    },
    {
      v: wf.xuanti && !wf.xigao ? '1' : '0',
      k: '待洗稿',
      trend: wf.xuanti ? (wf.xigao ? '已完成' : '待处理') : '等选题完成',
      icon: 'pen',
      tone: 'amber',
      onClick: () => setView('xigao'),
    },
    {
      v: wf.tishici && !wf.chutu ? '1' : '0',
      k: '待出图',
      trend: wf.tishici ? (wf.chutu ? '已完成' : '提示词就绪') : '等提示词确认',
      icon: 'image',
      tone: 'violet',
      onClick: () => setView('chutu'),
    },
    {
      v: String(libraryFiles.length),
      k: '素材库归档',
      trend: libraryFiles.length ? '本地已同步' : '暂无文件',
      icon: 'archive',
      tone: 'emerald',
      onClick: () => setView('sucai'),
    },
  ];

  const feed = [
    {
      id: 'xuanti',
      icon: 'target',
      done: topics.length > 0 || wf.xuanti,
      txt: topics.length ? `已采集 ${topics.length} 条选题` : '今日选题待开始',
      sub: topics.length ? '可前往洗稿或创意导入' : '浏览四平台热榜或主动搜索',
      time: topics.length ? '今天' : '待办',
      onClick: () => { setXuanti({ tab: topics.length ? 'topics' : 'hot' }); setView('xuanti'); },
    },
    {
      id: 'xigao',
      icon: 'pen',
      done: wf.xigao,
      txt: wf.xigao ? '洗稿已完成' : '洗稿改写待开始',
      sub: wf.xigao ? '文案可导出 Word 或归档' : '支持抖音视频与小红书图文识别',
      time: wf.xigao ? '已完成' : '待办',
      onClick: () => setView('xigao'),
    },
    {
      id: 'tishici',
      icon: 'wand',
      done: wf.tishici,
      txt: wf.tishici ? '提示词已生成' : '提示词待生成',
      sub: wf.tishici ? '可直接带入出图模块' : '自动拆解文案与配图提示词',
      time: wf.tishici ? '已完成' : '待办',
      onClick: () => setView('tishici'),
    },
    {
      id: 'chutu',
      icon: 'check',
      done: wf.chutu,
      txt: wf.chutu ? '成品图片已生成' : '成品出图待开始',
      sub: wf.chutu ? '支持保存 PNG 或导出至素材库' : '支持多协议 API 或 Codex 订阅出图',
      time: wf.chutu ? '已完成' : '待办',
      onClick: () => setView('chutu'),
    },
  ];

  return (
    <div className="home-root">
      {/* 第 1 层：全宽科技感 Hero 卡片 — 左侧状态与主操作 + 右侧纯 3D 科技粒子球待机动效 */}
      <section className="card home-hero" aria-label="工作台状态概览">
        <div className="home-hero-copy">
          <div className="home-hero-meta">
            <span className="home-clock-pill" id="clock">
              <span className="home-live-dot" aria-hidden="true" />
              <span>{now}</span>
            </span>
            <span className="home-progress-pill">今日流程 {doneCount}/{WORKFLOW_STEPS.length}</span>
          </div>

          <h2 id="homeGreet">
            {greeting}，今天的内容进度
            {doneCount === 0 ? '待开启' : doneCount < 3 ? '已启动' : doneCount < 5 ? '过半了' : '已全部完成'}
          </h2>
          <p id="homeStatusText">{statusText}</p>

          <div className="home-hero-actions">
            <Button color="primary" onPress={primaryAction.onPress}>
              <Icon name={primaryAction.icon} className="ic" size={16} /> {primaryAction.label}
            </Button>
            <Button
              variant="bordered"
              className="topic-outline-button"
              onPress={() => {
                setXuanti({ tab: 'topics' });
                setView('xuanti');
              }}
            >
              <Icon name="eye" className="ic" size={16} /> 查看选题表
              {topics.length > 0 && <span className="home-btn-badge">{topics.length}</span>}
            </Button>
          </div>
        </div>

        {/* 右侧纯视觉磁感微指针矩阵（源自 motion.dev Magnetic filings：待机巡航波场 + 悬停磁吸响应） */}
        <div className="home-hero-filings-stage" aria-hidden="true">
          <MagneticFilings theme={theme} />
        </div>
      </section>

      {/* 第 2 层：独立「快捷入口」横向 4 格工具栏 */}
      <section className="home-quick-strip" aria-label="快捷入口">
        {QUICK_ITEMS.map((q, idx) => (
          <StaggerItem key={q.id} index={idx}>
            <m.button
              type="button"
              className="card home-quick-tile"
              onClick={() => setView(q.id)}
              whileHover={{ y: -2, transition: MOTION_SPRING.snappy }}
              whileTap={{ scale: 0.985, transition: MOTION_SPRING.snappy }}
            >
              <span className={`home-kpi-icon tone-${q.tone}`}>
                <Icon name={q.icon} className="ic" size={17} />
              </span>
              <span className="home-quick-copy">
                <b>{q.t}</b>
                <small>{q.d}</small>
              </span>
              <span className="home-quick-arrow" aria-hidden="true">
                <Icon name="chevron" className="ic" size={14} />
              </span>
            </m.button>
          </StaggerItem>
        ))}
      </section>

      {/* 第 3 层：4 列精致数据指标条 */}
      <div className="home-kpi-grid">
        {stats.map((s, idx) => (
          <StaggerItem key={s.k} index={idx}>
            <m.button
              type="button"
              className="card home-kpi-card"
              onClick={s.onClick}
              whileHover={{ y: -2, transition: MOTION_SPRING.snappy }}
              whileTap={{ scale: 0.985, transition: MOTION_SPRING.snappy }}
            >
              <div className="home-kpi-top">
                <span className="home-kpi-label">{s.k}</span>
                <span className="home-kpi-pill">{s.trend}</span>
              </div>
              <div className="home-kpi-val">{s.v}</div>
            </m.button>
          </StaggerItem>
        ))}
      </div>

      {/* 第 4 层：非对称主从 Bento 双栏 — 左宽敞四平台当日热点 + 右侧创作动态时间轴 */}
      <div className="home-main-grid">
        <section className="panel home-hot-panel">
          <div className="panel-head">
            <h3>
              <Icon name="flame" className="ic" size={18} /> 当日热点 · 四平台风向
            </h3>
            <div className="spacer" />
            <Button
              size="sm"
              variant="light"
              isDisabled={hotRanks.loading}
              onPress={() => void loadHotRanks(true)}
            >
              <Icon name="refresh" className="ic" size={14} /> 刷新
            </Button>
            <Button
              size="sm"
              variant="bordered"
              className="topic-outline-button"
              onPress={() => {
                setXuanti({ tab: 'hot' });
                setView('xuanti');
              }}
            >
              全部热榜
            </Button>
          </div>
          <div className="panel-body home-hot-body">
            {hotRanks.loading ? (
              <div className="home-hot-state"><Spinner size="sm" /> 正在同步四平台实时热榜…</div>
            ) : Object.keys(hotRanks.items).length ? (
              <div className="today-hot home-today-hot">
                {['抖音', '小红书', '微博', '知乎'].map((p) => (
                  <div className="th-col" key={p}>
                    <div className="th-head">
                      <span className="plat-dot" style={{ background: PLAT_COLORS[p] }} />
                      <span className="plat-name">{p}</span>
                      <span className="tiny">TOP 3</span>
                    </div>
                    <div className="th-list">
                      {(hotRanks.items[p] || []).length ? (
                        (hotRanks.items[p] || []).slice(0, 3).map((it, i) => (
                          <button
                            type="button"
                            className="th-item th-item-btn"
                            key={i}
                            title={it.link ? `${it.t}（点击打开原文）` : it.t}
                            onClick={() => {
                              if (it.link) {
                                void api.openExternalUrl(it.link);
                              } else {
                                setXuanti({ tab: 'hot' });
                                setView('xuanti');
                              }
                            }}
                          >
                            <span className={`th-rank${i === 0 ? ' top' : ''}`}>{i + 1}</span>
                            <span className="th-title">{it.t}</span>
                            <span className="th-heat tiny">{it.heat}</span>
                          </button>
                        ))
                      ) : (
                        <div className="tiny" style={{ padding: '10px 6px', color: 'var(--text-3)' }}>暂未获取</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="home-hot-state">
                <Icon name="alert" className="ic" size={18} />
                <span>{hotRanks.error || '暂未获取到热点数据。'}</span>
                <div className="row">
                  <Button size="sm" variant="light" onPress={() => void loadHotRanks(true)}>重试</Button>
                  <Button size="sm" color="primary" onPress={() => setView('settings')}>去设置检查</Button>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="panel home-timeline-panel">
          <div className="panel-head">
            <h3>
              <Icon name="clock" className="ic" size={18} /> 今日创作动态
            </h3>
            <div className="spacer" />
            <span className="home-timeline-pct">{progressPct}%</span>
          </div>
          <div className="home-timeline-bar">
            <SpringProgress percent={progressPct} />
          </div>
          <div className="home-timeline-list" id="homeFeed">
            {feed.map((f, idx) => (
              <button
                type="button"
                className={`home-timeline-item ${f.done ? 'is-done' : ''}`}
                key={f.id}
                onClick={f.onClick}
              >
                <div className="home-tl-rail" aria-hidden="true">
                  <span className={`home-tl-dot ${f.done ? 'done' : ''}`}>
                    <Icon name={f.done ? 'check' : f.icon} className="ic" size={13} />
                  </span>
                  {idx < feed.length - 1 && <span className="home-tl-line" />}
                </div>
                <div className="home-tl-body">
                  <div className="home-tl-head">
                    <span className="home-tl-title">{f.txt}</span>
                    <span className={`home-tl-time ${f.done ? 'done' : ''}`}>{f.time}</span>
                  </div>
                  <div className="home-tl-sub">{f.sub}</div>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
      <div style={{ height: 24 }} />
    </div>
  );
}
