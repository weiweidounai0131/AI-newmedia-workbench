import { useEffect, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { useApp, setView, WORKFLOW_STEPS, loadHotRanks } from '../store/appStore';
import { Icon } from '../icons';
import { PLAT_COLORS } from '../data/sample';

function clockStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${wk} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const QUICK = [
  { id: 'xuanti', icon: 'target', t: '去选题', d: '热榜 / 主动搜索' },
  { id: 'xigao', icon: 'pen', t: '去洗稿', d: '贴稿 + AI 改写' },
  { id: 'tishici', icon: 'wand', t: '生成提示词', d: '文案 + 文生图' },
  { id: 'sucai', icon: 'archive', t: '翻素材库', d: '长图 / 四宫格' },
];

export default function Home() {
  const wf = useApp((s) => s.workflow);
  const topics = useApp((s) => s.xuanti.topics);
  const libraryFiles = useApp((s) => s.lib);
  const [now, setNow] = useState(clockStr());
  const hotRanks = useApp((s) => s.hotRanks);

  useEffect(() => {
    const id = setInterval(() => setNow(clockStr()), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void loadHotRanks();
  }, []);

  const doneCount = WORKFLOW_STEPS.filter((s) => (wf as any)[s]).length;
  let statusText = '';
  if (doneCount === 0) statusText = '从选题开始，建立今天的内容创作流程。';
  else if (doneCount === 1) statusText = '选题已完成，下一步可以开始洗稿或创意。';
  else if (doneCount === 2) statusText = '内容已在推进中，继续生成提示词或完善创意。';
  else if (doneCount === 3) statusText = '提示词已准备好，可以进入出图环节。';
  else if (doneCount === 4) statusText = '内容已接近完成，记得导出到素材库归档。';
  else statusText = '本轮流程已完成，可以开始新的内容创作。';

  const stats = [
    { v: String(topics.length), k: '今日选题', trend: topics.length ? '已采集' : '待开始' },
    { v: wf.xuanti && !wf.xigao ? '1' : '0', k: '待洗稿', trend: wf.xuanti ? (wf.xigao ? '已完成' : '待开始') : '等选题完成' },
    { v: wf.tishici && !wf.chutu ? '1' : '0', k: '待出图', trend: wf.tishici ? (wf.chutu ? '已完成' : '提示词已确认') : '等提示词确认' },
    { v: String(libraryFiles.length), k: '素材库', trend: libraryFiles.length ? '本地已同步' : '暂无文件' },
  ];

  const feed = [
    { icon: 'check', cls: 'green', txt: wf.chutu ? '图片已生成，可导出到素材库' : '出图待开始', time: wf.chutu ? '刚刚' : '待办' },
    { icon: 'wand', cls: '', txt: wf.tishici ? '提示词已生成' : '提示词待生成', time: wf.tishici ? '刚刚' : '待办' },
    { icon: 'pen', cls: '', txt: wf.xigao ? '洗稿已完成' : '洗稿待开始', time: wf.xigao ? '刚刚' : '待办' },
    { icon: 'target', cls: '', txt: topics.length ? `已采集 ${topics.length} 条选题` : '今日选题待开始', time: topics.length ? '今天' : '待办' },
  ];

  return (
    <div>
      <div className="hero-grid">
        <div className="card greet">
          <div className="glow" />
          <div className="clock" id="clock">{now}</div>
          <h2 id="homeGreet">下午好，今天的内容进度{doneCount === 0 ? '待开启' : doneCount < 3 ? '开头了' : '过半了'}</h2>
          <p id="homeStatusText">{statusText}</p>
          <div className="row">
            <Button color="primary" onPress={() => setView('xuanti')}>
              <Icon name="target" className="ic" size={16} /> 去做选题
            </Button>
            <Button variant="bordered" onPress={() => setView('xuanti')}>
              <Icon name="eye" className="ic" size={16} /> 查看选题
            </Button>
          </div>
        </div>
        <div className="card quick-card">
          <div className="panel-head" style={{ padding: '0 0 12px', border: 'none' }}>
            <h3>快捷入口</h3>
          </div>
          <div className="quick">
            {QUICK.map((q) => (
              <a key={q.id} onClick={() => setView(q.id)}>
                <Icon name={q.icon} className="ic" size={20} />
                <div>
                  <div className="q-t">{q.t}</div>
                  <div className="q-d">{q.d}</div>
                </div>
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="stats">
        {stats.map((s) => (
          <div className="card stat" key={s.k}>
            <div className="v">{s.v}</div>
            <div className="k">{s.k}</div>
            <div className="trend">{s.trend}</div>
          </div>
        ))}
      </div>

      <div className="two-col">
        <div className="panel">
          <div className="panel-head">
            <h3>
              <Icon name="clock" className="ic" size={18} /> 最近动态
            </h3>
            <div className="spacer" />
            <span className="tiny">实时</span>
          </div>
          <div className="feed" id="homeFeed">
            {feed.map((f, i) => (
              <div className="feed-item" key={i}>
                <div className={`ic ${f.cls}`}>
                  <Icon name={f.icon} className="ic" size={16} />
                </div>
                <div className="txt">{f.txt}</div>
                <div className="time">{f.time}</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="panel-head" style={{ padding: '0 0 12px', border: 'none' }}>
            <h3>当日热点</h3>
          </div>
          <div className="today-hot">
            {hotRanks.loading ? (
              <div className="home-hot-state"><Spinner size="sm" /> 正在加载当日热点…</div>
            ) : Object.keys(hotRanks.items).length ? (
              Object.keys(hotRanks.items).map((p) => (
                  <div className="th-col" key={p}>
                    <div className="th-head">
                      <span className="plat-dot" style={{ background: PLAT_COLORS[p] }} />
                      <span className="plat-name">{p}</span>
                      <span className="tiny">TOP 3</span>
                    </div>
                    <div className="th-list">
                      {hotRanks.items[p].slice(0, 3).map((it, i) => (
                        <div className="th-item" key={i}>
                          <span className={`th-rank${i === 0 ? ' top' : ''}`}>{i + 1}</span>
                          <span className="th-title" title={it.t}>{it.t}</span>
                          <span className="th-heat tiny">{it.heat}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
            ) : (
              <div className="home-hot-state">
                <Icon name="alert" className="ic" size={18} />
                <span>{hotRanks.error || '暂未获取到热点数据。'}</span>
                <div className="row">
                  <Button size="sm" variant="light" onPress={() => void loadHotRanks(true)}>重试</Button>
                  <Button size="sm" color="primary" onPress={() => setView('settings')}>去设置登录</Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={{ height: 24 }} />
    </div>
  );
}
