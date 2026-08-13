import { useEffect, useState } from 'react';
import { Button, Input, Link, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Select, SelectItem, Spinner, Tab, Tabs } from '@heroui/react';
import { useApp, setXuanti, addTopic, clearTopics, exportTextToLib, fmtYMD, loadHotRanks } from '../store/appStore';
import { api } from '../api/client';
import { Icon } from '../icons';
import { useToastMsg } from '../lib/ui';
import { PLAT_COLORS, type SearchItem } from '../data/sample';

const HOT_PLATFORMS = ['抖音', '小红书', '微博', '知乎'];
const SEARCH_PLATFORMS = ['抖音', '小红书'];

function formatRemain(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function Xuanti() {
  const xuanti = useApp((s) => s.xuanti);
  const toast = useToastMsg();
  const [kw, setKw] = useState(xuanti.search.kw);
  const [searchConfirmOpen, setSearchConfirmOpen] = useState(false);
  const [searchRiskNoticeOpen, setSearchRiskNoticeOpen] = useState(false);
  const [platform, setPlatform] = useState(xuanti.search.platform);
  const [cooldowns, setCooldowns] = useState<Record<string, { expiresAt: number }>>({});
  const [clock, setClock] = useState(Date.now());
  const hotRanks = useApp((s) => s.hotRanks);
  const searching = xuanti.search.status === 'searching';
  const hot = hotRanks.items;
  const search: SearchItem[] = xuanti.search.items;
  const searchLive = xuanti.search.live;
  const searchMsg = xuanti.search.message;

  const tab = xuanti.tab;
  const orderedTopics = [...xuanti.topics].sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
  const searchRemain = Math.max(0, Math.ceil(((cooldowns[platform]?.expiresAt || 0) - clock) / 1000));

  async function refreshCooldowns() {
    try {
      const r = await api.scrapeCooldowns('topic');
      setCooldowns(r.platforms || {});
    } catch { /* 后端强制限流仍会兜底 */ }
  }

  function switchTab(t: 'hot' | 'search' | 'topics') {
    setXuanti({ tab: t });
    if (t === 'search' && !window.localStorage.getItem('newmedia-search-risk-notice-read')) {
      setSearchRiskNoticeOpen(true);
    }
  }

  function confirmSearchRiskNotice(): void {
    window.localStorage.setItem('newmedia-search-risk-notice-read', '1');
    setSearchRiskNoticeOpen(false);
  }

  const collected = (source: '热榜' | '搜索', p: string, title: string) =>
    xuanti.topics.some((t) => t.source === source && t.platform === p && t.title === title);

  function collect(p: string, title: string, heat: string, link?: string) {
    if (collected('热榜', p, title)) return;
    if (!link) return toast('该热点暂未提供可用链接，无法采集到选题表', 'warning');
    addTopic({ title, source: '热榜', platform: p, heat, likes: '', comments: '', link });
    toast(`已采集「${title}」到选题表`, 'success');
  }

  function adopt(i: number) {
    const s = search[i];
    if (!s) return;
    if (collected('搜索', platform, s.t)) return;
    if (!s.url) return toast('该搜索结果暂未提供可用链接，无法加入选题表', 'warning');
    addTopic({
      title: s.t,
      source: '搜索',
      platform,
      heat: '',
      likes: s.l,
      comments: s.c,
      link: s.url,
    });
    toast(`已采用「${s.t}」并加入选题表`, 'success');
  }

  async function runSearch() {
    if (searching) return;
    const keyword = kw.trim();
    if (!keyword) return toast('请先输入搜索关键词', 'warning');
    setXuanti({ search: { kw: keyword, platform, items: [], live: null, message: null, status: 'searching' } });
    try {
      const r = await api.getSearch(keyword, platform);
      if (r.live) {
        setXuanti({ search: { kw: keyword, platform, items: r.items || [], live: true, message: null, status: 'done' } });
      } else {
        setXuanti({ search: { kw: keyword, platform, items: [], live: false, message: r.message || null, status: 'error' } });
        toast(r.message || `「${platform}」未获取到真实结果，请检查登录态`, 'warning');
      }
    } catch (e: any) {
      setXuanti({ search: { kw: keyword, platform, items: [], live: false, message: e?.message || '搜索失败，请确认后端已启动', status: 'error' } });
      toast(e?.message || '搜索失败，请确认后端已启动', 'danger');
    } finally {
      refreshCooldowns();
    }
  }

  // 热榜结果在共享状态中按整点缓存，切页不会重新拉取。
  useEffect(() => {
    void loadHotRanks();
  }, []);

  useEffect(() => {
    refreshCooldowns();
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function exportToLib() {
    if (!xuanti.topics.length) return toast('选题表为空，先采集或采用', 'warning');
    const ymd = fmtYMD(new Date());
    const name = `选题表${ymd}.xlsx`;
    const topics = orderedTopics.map(({ title, source, platform: topicPlatform, heat, likes, comments, link }) => ({
      title,
      source,
      platform: topicPlatform,
      heat: source === '热榜' ? heat || '—' : '—',
      likes: source === '搜索' ? likes || '—' : '—',
      comments: source === '搜索' ? comments || '—' : '—',
      link,
    }));
    try {
      await exportTextToLib('选题', name, '', topics);
      toast(`已导出到素材库 · 选题 / ${name}（同日覆盖）`, 'success');
    } catch (error: any) {
      toast(error?.message || '请先设置素材库目录', 'warning');
    }
  }

  const tabs = [
    { id: 'hot', label: '热门', icon: 'flame' },
    { id: 'search', label: '主动搜索', icon: 'search' },
    { id: 'topics', label: '选题表', icon: 'inbox', count: xuanti.topics.length },
  ];

  return (
    <div className="xuanti-wrap">
      <Tabs
        aria-label="选题功能"
        className="heroui-topic-tabs"
        selectedKey={tab}
        onSelectionChange={(key) => switchTab(key as 'hot' | 'search' | 'topics')}
        variant="bordered"
        radius="sm"
        size="sm"
      >
        {tabs.map((tb) => (
          <Tab
            key={tb.id}
            title={
              <span className="topic-tab-label">
                <Icon name={tb.icon} className="ic" size={16} />
                {tb.label}
                {tb.count ? <span className="count">{tb.count}</span> : null}
              </span>
            }
          />
        ))}
      </Tabs>

      {tab === 'hot' && (
        <div className="panel">
          <div className="panel-head">
            <h3>
              <Icon name="flame" className="ic" size={18} /> 热门 · 全网热榜
            </h3>
            <div className="spacer" />
            <span className="tiny">每个平台最多展示 20 条</span>
          </div>
          <div className="panel-body">
            {hotRanks.loading && !Object.keys(hot).length && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 82, color: 'var(--text-3)', fontSize: 13 }}>
                <Spinner size="sm" color="primary" />
                正在加载全网热榜…
              </div>
            )}
            <div className="hot-grid" style={hotRanks.loading && !Object.keys(hot).length ? { opacity: 0.55 } : undefined}>
              {HOT_PLATFORMS.map((p) => {
                const items = hot[p] || [];
                return (
                  <div className="hot-col" key={p}>
                    <div className="hot-col-head">
                      <span className="plat-dot" style={{ background: PLAT_COLORS[p] }} />
                      <span className="plat-name">{p}</span>
                    </div>
                    <div className="hot-items">
                      {hotRanks.loading && !items.length ? (
                        [0, 1, 2].map((idx) => (
                          <div key={idx} className="skeleton sk-line" style={{ width: '90%', margin: '8px 6px' }} />
                        ))
                      ) : items.length ? (
                        items.slice(0, 20).map((it, i) => (
                          <div className="hot-item" key={i}>
                            <span className={`rank ${i < 3 ? 'top' : ''}`}>{i + 1}</span>
                            {it.link ? (
                              <Link className="hot-title" color="foreground" href={it.link} isExternal title={`打开「${it.t}」来源`}>
                                {it.t}
                              </Link>
                            ) : (
                              <span className="hot-title" title="该热点暂无可用链接">{it.t}</span>
                            )}
                            <div className="hot-meta">
                              <span className="hot-heat">{it.heat}</span>
                              {it.tag && <span className="hot-tag">{it.tag}</span>}
                            </div>
                            <Button
                              className="collect topic-outline-button"
                              isDisabled={collected('热榜', p, it.t) || !it.link}
                              size="sm"
                              variant="bordered"
                              onPress={() => collect(p, it.t, it.heat, it.link)}
                            >
                              <Icon name={collected('热榜', p, it.t) ? 'check' : 'plus'} className="ic" size={13} />
                              {collected('热榜', p, it.t) ? '已采集' : it.link ? '采集' : '暂无链接'}
                            </Button>
                          </div>
                        ))
                      ) : (
                        <div className="tiny" style={{ padding: '16px 8px', color: 'var(--text-3)' }}>暂未获取到该平台热榜，可稍后重试。</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {tab === 'search' && (
        <div className="panel">
          <div className="panel-head">
            <h3>
              <Icon name="search" className="ic" size={18} /> 主动搜索
            </h3>
            <div className="spacer" />
          </div>
          <div className="panel-body">
            <Modal isOpen={searchRiskNoticeOpen} onOpenChange={setSearchRiskNoticeOpen} size="md" isDismissable={false} hideCloseButton>
              <ModalContent>
                <>
                  <ModalHeader>使用主动搜索前请注意</ModalHeader>
                  <ModalBody>
                    自动抓取可能触发平台风控。虽然每次抓取均已设置冷却时间，为降低风险，请尽量自行在浏览器中查找内容，并复制对应链接到工作台使用。
                  </ModalBody>
                  <ModalFooter>
                    <Button color="primary" onPress={confirmSearchRiskNotice}>我已了解</Button>
                  </ModalFooter>
                </>
              </ModalContent>
            </Modal>
            <div className="search-bar">
              <Input aria-label="搜索关键词" value={kw} isDisabled={searching} onValueChange={setKw} />
              <Select
                aria-label="搜索平台"
                selectedKeys={new Set([platform])}
                style={{ width: 128 }}
                isDisabled={searching}
                onSelectionChange={(keys) => setPlatform(String([...keys][0] || '抖音'))}
              >
                {SEARCH_PLATFORMS.map((p) => <SelectItem key={p}>{p}</SelectItem>)}
              </Select>
              <Button color="primary" isLoading={searching} isDisabled={searching || searchRemain > 0} onPress={() => setSearchConfirmOpen(true)}>
                <Icon name="search" className="ic" size={16} /> {searchRemain > 0 ? `冷却中 · ${formatRemain(searchRemain)}` : '搜索'}
              </Button>
            </div>
            <div className="tiny" style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="alert" className="ic" size={13} />
              为降低风控风险：选题搜索按平台单独冷却。抖音 15 分钟、小红书 10 分钟；触发风控后自动保护 60 分钟。
            </div>
            <Modal isOpen={searchConfirmOpen} onOpenChange={setSearchConfirmOpen} size="sm">
              <ModalContent>
                {(onClose) => (
                  <>
                    <ModalHeader>开始主动搜索</ModalHeader>
                    <ModalBody>
                      本次搜索会打开已在设置页登录的浏览器窗口。若出现登录或安全验证，请在该窗口完成验证后保持窗口打开，工作台会自动继续并返回结果；无需关闭窗口。搜索完成后，该平台会进入选题冷却期。
                    </ModalBody>
                    <ModalFooter>
                      <Button variant="light" onPress={onClose}>取消</Button>
                      <Button color="primary" onPress={() => { onClose(); runSearch(); }}>
                        开始搜索
                      </Button>
                    </ModalFooter>
                  </>
                )}
              </ModalContent>
            </Modal>
            <div id="searchList">
              {searchLive !== null && !searching && (
                <div className="tiny" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {searchLive ? (
                    <span className="set-status ok">
                      <Icon name="check" className="ic" size={13} /> 真实数据
                    </span>
                  ) : (
                    <span className="set-status no">
                      <Icon name="alert" className="ic" size={13} /> {searchMsg || '未获取到真实结果'}
                    </span>
                  )}
                </div>
              )}
              {searching ? (
                <>
                  <div className="skeleton sk-line" style={{ width: '90%' }} />
                  <div className="skeleton sk-line" style={{ width: '75%' }} />
                  <div className="skeleton sk-line" style={{ width: '82%' }} />
                </>
              ) : (
                <>
                  {search.map((s, i) => (
                    <div className="result-row" key={i}>
                      <div className="rr-body">
                        {s.url ? (
                          <Link
                            className="rr-title"
                            color="foreground"
                            href={s.url}
                            isExternal
                            title={`打开「${s.t}」原内容`}
                          >
                            {s.t}
                          </Link>
                        ) : (
                          <div className="rr-title">{s.t}</div>
                        )}
                        <div className="rr-meta">
                          {s.tags.map((tag) => (
                            <span key={tag} className={`chip ${tag.includes('⚠') ? 'warn' : 'green'}`}>{tag}</span>
                          ))}
                          <span className="tiny">点赞 {s.l || '—'} · 评论 {s.c || '—'}</span>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        className="topic-outline-button"
                        isDisabled={collected('搜索', platform, s.t)}
                        variant="bordered"
                        onPress={() => adopt(i)}
                      >
                        <Icon name="plus" className="ic" size={13} /> 采用
                      </Button>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'topics' && (
        <div className="panel">
          <div className="panel-head">
            <div className="topic-head-copy">
              <h3>
                <Icon name="inbox" className="ic" size={18} /> 选题表 · 今日采用
              </h3>
              <span className="topic-rule">
                <Icon name="clock" className="ic" size={13} />
                <span>规则：每日 0 点自动清空当日选题表</span>
              </span>
            </div>
            <div className="spacer" />
            <Button size="sm" color="danger" onPress={() => clearTopics()}>
              <Icon name="trash" className="ic" size={14} /> 清空
            </Button>
            <Button className="topic-outline-button" size="sm" variant="bordered" onPress={() => toast('可通过右侧“导出 Excel”生成选题表文件', 'default')}>
              <Icon name="download" className="ic" size={14} /> 导出 Excel
            </Button>
            <Button size="sm" color="primary" onPress={exportToLib}>
              <Icon name="archive" className="ic" size={14} /> 导出到素材库
            </Button>
          </div>
          <div className="panel-body topic-table-body">
            <div className="table-wrap">
              <table className="topic-table">
                <thead>
                  <tr>
                    <th>序列</th>
                    <th>标题</th>
                    <th>来源</th>
                    <th>平台</th>
                    <th>热度</th>
                    <th>点赞</th>
                    <th>评论</th>
                    <th>链接</th>
                  </tr>
                </thead>
                <tbody>
                  {xuanti.topics.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="empty-row">
                        今天还没采用选题 · 从上方热榜「采集」或搜索后「采用」
                      </td>
                    </tr>
                  ) : (
                    orderedTopics.map((t, i) => (
                      <tr key={t.id}>
                        <td className="seq">{i + 1}</td>
                        <td className="t-title">{t.title}</td>
                        <td>
                          <span className={`topic-source topic-source-${t.source === '热榜' ? 'hot' : 'search'}`}>
                            {t.source}
                          </span>
                        </td>
                        <td>
                          <span className="plat-tag" style={{ '--c': PLAT_COLORS[t.platform] || '#888' } as React.CSSProperties}>
                            <span className="d" />
                            {t.platform}
                          </span>
                        </td>
                        <td>{t.source === '热榜' ? t.heat || '—' : '—'}</td>
                        <td>{t.source === '搜索' ? t.likes || '—' : '—'}</td>
                        <td>{t.source === '搜索' ? t.comments || '—' : '—'}</td>
                        <td>
                          {t.link ? <Link className="t-link" href={t.link} isExternal showAnchorIcon>打开</Link> : '—'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
