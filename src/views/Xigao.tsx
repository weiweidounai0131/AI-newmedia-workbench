import { useEffect, useState, Fragment } from 'react';
import { Button, Textarea, Input, Chip, Checkbox, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Spinner } from '@heroui/react';
import { useApp, setXigao, exportTextToLib, addXigaoTableRecord, clearXigaoTable } from '../store/appStore';
import { api } from '../api/client';
import { Icon } from '../icons';
import { useToastMsg } from '../lib/ui';
import { extractHttpUrl } from '../lib/link';

function platformFromLink(link: string): string {
  try {
    const host = new URL(extractHttpUrl(link)).hostname.toLowerCase();
    if (host.includes('douyin.com')) return '抖音';
    if (host.includes('xiaohongshu.com') || host.includes('xhslink.com')) return '小红书';
  } catch { /* 链接尚未输入完整 */ }
  return '';
}
function formatRemain(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function sourceTitle(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !/^#/.test(item) && !/^(文字（OCR）|画面描述|标题|正文)[：:]/.test(item))
    || text.trim();
  return line
    .replace(/^(文字（OCR）|画面描述|标题|正文)[：:]\s*/u, '')
    .split(/[。！？!?]/u)[0]
    .replace(/[\\/:*?"<>|]/g, '＿')
    .trim()
    .slice(0, 36) || '未命名稿件';
}

export default function Xigao() {
  const x = useApp((s) => s.xigao);
  const xigaoTable = useApp((s) => s.xigaoTable);
  const topics = useApp((s) => s.xuanti.topics);
  const toast = useToastMsg();
  const [tab, setTab] = useState<'work' | 'lib'>('work');
  const [optimizeHint, setOptimizeHint] = useState('');
  const [topicImportOpen, setTopicImportOpen] = useState(false);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [cooldowns, setCooldowns] = useState<Record<string, { expiresAt: number }>>({});
  const [clock, setClock] = useState(Date.now());
  const [wordExporting, setWordExporting] = useState(false);
  const loading = x.rewriteLoading;
  const req = x.rewriteRequirement;
  const parseStatus = x.parseStatus;
  const parseStatusText = x.parseStatusText;
  const douyinModalOpen = x.parseModalOpen && x.parseTaskPlatform === '抖音';
  const xhsModalOpen = x.parseModalOpen && x.parseTaskPlatform === '小红书';
  const douyinTaskError = x.parseTaskPlatform === '抖音' ? x.parseTaskError : '';
  const xhsTaskError = x.parseTaskPlatform === '小红书' ? x.parseTaskError : '';
  const douyinTaskStatus = x.parseTaskPlatform === '抖音' ? x.parseTaskStatus : 'idle';
  const xhsTaskStatus = x.parseTaskPlatform === '小红书' ? x.parseTaskStatus : 'idle';

  async function refreshCooldowns() {
    try {
      const r = await api.scrapeCooldowns('rewrite');
      setCooldowns(r.platforms || {});
    } catch { /* 不影响其他本地编辑功能 */ }
  }

  useEffect(() => {
    refreshCooldowns();
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 下载任务的编号和状态都在共享状态中：即使离开洗稿页，重新回来也会继续轮询同一任务。
  useEffect(() => {
    if (x.parseStatus !== 'loading' || !x.parseTaskId || !x.parseTaskPlatform) return;
    let stopped = false;
    const poll = async () => {
      try {
        const isDouyin = x.parseTaskPlatform === '抖音';
        const task = isDouyin ? await api.xigaoDouyinStatus(x.parseTaskId) : await api.xigaoXhsStatus(x.parseTaskId);
        if (stopped) return;
        if (task.status === 'completed' && task.result?.path) {
          const source = isDouyin
            ? await api.xigaoDouyinSource({ path: task.result.path, title: task.result.title })
            : await api.xigaoXhsSource({ path: task.result.path, title: task.result.title });
          if (stopped) return;
          if (source.error || !source.sourceId || (isDouyin && !source.feedback)) throw new Error(source.error || '下载完成，但未能导入洗稿工作台');
          const successText = isDouyin ? '解析成功：抖音视频已下载，可以开始识别内容' : '解析成功：小红书图片和文案已下载，可以开始识别内容';
          setXigao({
            stage: 'source', recog: '', recogMsg: '', mediaType: isDouyin ? 'video' : 'image', vlModel: 'wechat-mp-tools',
            importTitle: source.title || x.importTitle, sourceId: source.sourceId, sourceFeedback: source.feedback || null,
            parseStatus: 'success', parseStatusText: successText, parseTaskId: '', parseTaskStatus: 'completed', parseTaskError: '', parseModalOpen: false,
          });
          toast(isDouyin ? '抖音解析成功，已下载视频；现在可以开始洗稿' : '小红书图文解析成功，现在可以开始 AI 识别', 'success');
        } else if (task.status === 'failed') {
          const message = task.error || (isDouyin ? '抖音视频下载失败' : '小红书图文下载失败');
          setXigao({ parseStatus: 'error', parseStatusText: `解析失败：${message}`, parseTaskStatus: 'failed', parseTaskError: message });
        } else {
          setXigao({ parseTaskStatus: task.status || 'running' });
        }
      } catch (error: any) {
        if (!stopped) {
          const message = error?.message || '下载状态读取失败';
          setXigao({ parseStatus: 'error', parseStatusText: `解析失败：${message}`, parseTaskStatus: 'failed', parseTaskError: message });
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [x.parseStatus, x.parseTaskId, x.parseTaskPlatform]);

  const isLink = x.mode === 'link';
  const hasOut = !!x.out.trim();
  const linkPlatform = platformFromLink(x.link) || x.platform;
  const linkRemain = Math.max(0, Math.ceil(((cooldowns[linkPlatform]?.expiresAt || 0) - clock) / 1000));

  async function runRewite(optimize = false, sourceOverride?: string) {
    if (x.rewriteLoading) return toast('AI 改写仍在进行中，请等待完成后再操作', 'warning');
    if (optimize && !optimizeHint.trim()) return toast('请先填写优化意见', 'warning');
    const src = (sourceOverride ?? (optimize ? x.out : x.src)).trim();
    if (!src) return toast(optimize ? '暂无可优化的洗稿文案' : '请先粘贴原稿件内容', 'warning');
    setXigao({ rewriteLoading: true });
    try {
      const r = await api.xigaoRewrite({ source: src, req, optimizeHint: optimize ? optimizeHint.trim() : undefined });
      if (r.error) throw new Error(r.error);
      setXigao({ out: r.out, stage: 'done' });
      toast(optimize ? '已按意见优化' : '洗稿完成', 'success');
    } catch (e: any) {
      toast(e?.message || '洗稿失败', 'danger');
    } finally {
      setXigao({ rewriteLoading: false });
    }
  }

  // 链接解析：抖音、小红书均委托 wechat-mp-tools 下载到本地后再识别。
  async function runRecognize() {
    if (x.parseStatus === 'loading') return toast('链接仍在解析中，请等待完成后再操作', 'warning');
    const rawLink = x.link.trim();
    const link = extractHttpUrl(rawLink);
    if (!link) return toast('请粘贴平台分享文本或其中的 http(s) 链接', 'warning');
    const detectedPlatform = platformFromLink(link) || x.platform;
    if (!detectedPlatform) return toast('暂时只能解析抖音或小红书链接', 'warning');
    // “解析链接”仅负责获取并准备来源；真正的 AI 识别由下方按钮单独触发。
    setXigao({
      link, platform: detectedPlatform, stage: 'idle', recog: '', recogMsg: '', mediaType: '', vlModel: '', sourceId: '', sourceFeedback: null,
      parseStatus: 'loading', parseStatusText: '正在解析链接，请稍候…', parseTaskId: '', parseTaskPlatform: detectedPlatform as '抖音' | '小红书', parseTaskStatus: 'starting', parseTaskError: '', parseModalOpen: false,
    });
    try {
      if (detectedPlatform === '抖音') {
        const task = await api.xigaoDouyinStart(link);
        if (task.error || !task.taskId) throw new Error(task.error || '未能启动 wechat-mp-tools 下载');
        setXigao({ parseTaskId: task.taskId, parseTaskPlatform: '抖音', parseTaskStatus: 'starting', parseModalOpen: true, parseStatusText: '正在调用抖音下载工具解析视频…' });
        toast('已打开 wechat-mp-tools 原解析页面，正在下载抖音视频', 'default');
        return;
      }
      const task = await api.xigaoXhsStart(link);
      if (task.error || !task.taskId) throw new Error(task.error || '未能启动 wechat-mp-tools 小红书下载');
      setXigao({ parseTaskId: task.taskId, parseTaskPlatform: '小红书', parseTaskStatus: 'starting', parseModalOpen: true, parseStatusText: '正在调用小红书下载工具解析图文…' });
      toast('已打开 wechat-mp-tools 原解析页面，正在下载图片和文案', 'default');
      return;
    } catch (e: any) {
      const message = e?.message || '来源检查失败';
      setXigao({ stage: 'idle', recog: '', recogMsg: '', mediaType: '', vlModel: '', sourceId: '', sourceFeedback: null, parseStatus: 'error', parseStatusText: `解析失败：${message}`, parseTaskStatus: 'failed', parseTaskError: message, parseModalOpen: true });
      toast(message, 'danger');
    } finally {
      refreshCooldowns();
    }
  }

  // 解析成功后点击「开始洗稿」，才调用视觉/文字 AI。
  async function runSourceRecognition() {
    if (!x.sourceId) return toast('请先完成稿件来源检查', 'warning');
    setXigao({ stage: 'recognizing', recog: '', recogMsg: '' });
    try {
      const r = await api.xigaoRecognizeSource(x.sourceId);
      if (r.error) throw new Error(r.error);
      setXigao({ stage: 'review', recog: r.recog || '', recogMsg: r.message || '', mediaType: r.mediaType || x.mediaType, vlModel: r.model || '', sourceFeedback: r.feedback || x.sourceFeedback });
      toast('已完成稿件识别，请确认内容后改写', 'success');
    } catch (e: any) {
      setXigao({ stage: 'source' });
      toast(e?.message || '稿件识别失败', 'danger');
    }
  }

  // 手动贴入的原稿无需再访问任何平台；统一进入右侧的人工确认与改写步骤，
  // 保证「洗稿要求」只在确认内容之后填写。
  function usePastedDraft() {
    const content = x.src.trim();
    if (!content) return toast('请先粘贴原稿件内容', 'warning');
    setXigao({
      stage: 'review', recog: content, recogMsg: '原稿件已导入，请校对内容并填写洗稿要求。',
      mediaType: 'article', vlModel: '手动导入', out: '',
    });
  }

  // 确认识别稿件 → 作为 source 交给 DeepSeek 改写
  async function confirmAndRewrite() {
    if (!x.recog.trim()) return toast('识别内容为空，无法改写', 'warning');
    await runRewite(false, x.recog);
  }

  async function exportToLibrary() {
    if (!hasOut) return toast('请先完成洗稿再导出', 'warning');
    const title = sourceTitle(x.mode === 'link' ? x.recog : x.src);
    const link = x.mode === 'link' ? x.link : '';
    const topic = topics.find((item) => item.link === link);
    const fileName = `洗稿+${title}.docx`;
    setWordExporting(true);
    try {
      await exportTextToLib('洗稿', fileName, x.out);
      addXigaoTableRecord({
        title,
        link,
        content: x.out,
        source: topic?.source || '—',
        platform: topic?.platform || platformFromLink(link) || x.platform || '—',
        fileName,
      });
      toast(`已导出到素材库 · 洗稿 / ${fileName}`, 'success');
    } catch (error: any) {
      toast(error?.message || '导出到素材库失败', 'danger');
    } finally {
      setWordExporting(false);
    }
  }

  async function downloadWord(content: string, title: string) {
    if (!content.trim()) return toast('没有可导出的洗稿内容', 'warning');
    setWordExporting(true);
    try {
      const blob = await api.downloadWord({ name: `洗稿+${title}`, content });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `洗稿+${title}.docx`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
      toast('Word 已开始下载', 'success');
    } catch (error: any) {
      toast(error?.message || 'Word 导出失败', 'danger');
    } finally {
      setWordExporting(false);
    }
  }

  const importableTopics = topics
    .filter((topic) => topic.source === '搜索' && Boolean(topic.link))
    .sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));

  function openTopicImport() {
    if (!importableTopics.length) return toast('选题表没有可导入的搜索内容，热榜内容请前往「创意」模块使用', 'warning');
    setSelectedTopicId(importableTopics[0]?.id || null);
    setTopicImportOpen(true);
  }

  function importSelectedTopic() {
    const topic = importableTopics.find((item) => item.id === selectedTopicId);
    if (!topic) return toast('请选择一条选题链接', 'warning');
    setXigao({ link: topic.link, platform: topic.platform || '', importTitle: topic.title, mode: 'link', stage: 'idle', recog: '', out: '' });
    setXigao({ parseStatus: 'idle', parseStatusText: '已导入链接，请先解析链接', parseTaskId: '', parseTaskPlatform: '', parseTaskStatus: 'idle', parseTaskError: '', parseModalOpen: false });
    setTopicImportOpen(false);
    toast(`已导入选题「${topic.title}」的链接`, 'success');
  }

  return (
    <div className="xuanti-wrap">
      <div className="xuanti-tabs" role="tablist">
        <button className={`xuanti-tab ${tab === 'work' ? 'active' : ''}`} onClick={() => setTab('work')}>
          <Icon name="pen" className="ic" size={18} /> <span>洗稿</span>
        </button>
        <button className={`xuanti-tab ${tab === 'lib' ? 'active' : ''}`} onClick={() => setTab('lib')}>
          <Icon name="inbox" className="ic" size={18} /> <span>洗稿表</span>
          {xigaoTable.length > 0 && <span className="count">{xigaoTable.length}</span>}
        </button>
      </div>

      {tab === 'work' && isLink && (
        <div className="flow-steps" aria-label="链接洗稿流程">
          {['解析来源', 'AI 识别稿件', '人工确认内容', 'AI 改写'].map((s, i, arr) => {
            const curIdx = x.stage === 'recognizing' ? (x.sourceId ? 1 : 0) : x.stage === 'source' ? 1 : x.stage === 'review' ? 2 : x.stage === 'done' ? 3 : 0;
            const done = i < curIdx;
            const cur = i === curIdx;
            return (
              <Fragment key={s}>
                <div className={`fstep ${done ? 'done' : ''} ${cur ? 'cur' : ''}`}>
                  <i>{done ? '✓' : i + 1}</i>
                  <span>{s}</span>
                </div>
                {i < arr.length - 1 && <em className="fsep" aria-hidden="true" />}
              </Fragment>
            );
          })}
        </div>
      )}

      {tab === 'work' && (
        <div className="two-col">
          <div>
            <div className="panel">
              <div className="panel-head">
                <h3>
                  <Icon name="pen" className="ic" size={18} /> 稿件来源
                </h3>
                <div className="spacer" />
                {isLink && (
                  <Button size="sm" variant="bordered" className="topic-outline-button" onPress={openTopicImport}>
                    <Icon name="upload" className="ic" size={14} /> 从选题表导入
                  </Button>
                )}
              </div>
              <div className="panel-body">
                <div className="src-mode">
                  <button className={`src-mode-btn ${x.mode === 'link' ? 'active' : ''}`} onClick={() => setXigao({ mode: 'link', stage: 'idle', recog: '', out: '' })}>
                    填原稿件链接
                  </button>
                  <button className={`src-mode-btn ${x.mode === 'draft' ? 'active' : ''}`} onClick={() => setXigao({ mode: 'draft', stage: 'idle', recog: '', out: '' })}>
                    贴原稿件
                  </button>
                </div>
                {x.mode === 'draft' && (
                  <div className="field">
                    <label>稿件（从 Word / 网页中复制贴入）</label>
                    <Textarea
                      value={x.src}
                      onValueChange={(v) => setXigao({ src: v })}
                      minRows={6}
                      placeholder="在此粘贴原文正文…"
                    />
                  </div>
                )}
                {x.mode === 'link' && (
                  <div className="field">
                    <label>原稿件链接</label>
                    <Input
                      value={x.link}
                      onValueChange={(v) => {
                        setXigao({ link: v, stage: 'idle', recog: '', recogMsg: '', mediaType: '', vlModel: '', sourceId: '', sourceFeedback: null });
                        setXigao({ parseStatus: 'idle', parseStatusText: '链接已修改，请重新解析', parseTaskId: '', parseTaskPlatform: '', parseTaskStatus: 'idle', parseTaskError: '', parseModalOpen: false });
                      }}
                      placeholder="粘贴平台分享文本或 URL（抖音 / 小红书均可）"
                    />
                    <span className="hint">支持直接粘贴平台分享文案，系统会自动提取其中的链接；需先在「设置 → 抓取账号」登录平台。</span>
                    <div className={`link-parse-action ${parseStatus}`}>
                      <Button size="sm" variant="bordered" color="primary" isLoading={parseStatus === 'loading' && !douyinModalOpen && !xhsModalOpen} isDisabled={!x.link.trim() || linkRemain > 0 || parseStatus === 'loading'} onPress={runRecognize}>
                        <Icon name="spark" className="ic" size={14} /> {linkRemain > 0 ? `冷却中 · ${formatRemain(linkRemain)}` : '解析链接'}
                      </Button>
                      <span role="status">{parseStatusText}</span>
                    </div>
                  </div>
                )}
                {isLink ? (
                  <Button color="primary" className="w-full" isLoading={x.stage === 'recognizing' && Boolean(x.sourceId)} isDisabled={x.stage !== 'source' || !x.sourceId} onPress={runSourceRecognition}>
                    AI 识别内容
                  </Button>
                ) : (
                  <Button color="primary" className="w-full" onPress={usePastedDraft}>
                    确认原稿件
                  </Button>
                )}
              </div>
            </div>
          </div>
          <div>
            <div className="panel recog-panel">
                <div className="panel-head">
                  <h3>
                    <Icon name="eye" className="ic" size={18} /> 识别稿件 · 待你确认
                  </h3>
                  <div className="spacer" />
                  {x.mediaType && <span className="vl-tag">{x.mediaType} · {x.vlModel}</span>}
                </div>
                <div className="panel-body">
                  {isLink && x.stage === 'source' ? (
                    <div className="out-box empty">链接已解析完成。点击左侧「AI 识别内容」后，{x.mediaType === 'video' ? '将从本地视频抽取关键画面' : '将逐张读取本地图片与文案'}并由 AI 生成稿件内容。</div>
                  ) : isLink && x.stage === 'recognizing' ? (
                    <>
                      <div className="skeleton sk-line" style={{ width: '92%' }} />
                      <div className="skeleton sk-line" style={{ width: '78%' }} />
                      <div className="skeleton sk-line" style={{ width: '85%' }} />
                      <div className="tiny" style={{ marginTop: 8 }}>{x.mediaType === 'video' ? '正在从本地视频抽取关键画面，并交给 AI 识别…' : '正在识别原稿件内容…'}</div>
                    </>
                  ) : (x.stage === 'review' || x.stage === 'done') && x.recog ? (
                    <>
                      {x.recogMsg && <div className="info-box" role="status">{x.recogMsg}</div>}
                      <Textarea
                        aria-label="可编辑识别稿件"
                        className="output-editor"
                        value={x.recog}
                        onValueChange={(v) => setXigao({ recog: v })}
                        minRows={10}
                        maxRows={18}
                      />
                      <div className="rewrite-action">
                        <div className="field">
                          <label>洗稿要求（你定方向）</label>
                          <Input value={req} onValueChange={(value) => setXigao({ rewriteRequirement: value })} placeholder="例：改朋友圈口语风。" />
                        </div>
                        {x.stage === 'review' && (
                          <Button color="primary" className="w-full" isLoading={loading} isDisabled={loading} onClick={() => { void confirmAndRewrite(); }}>
                            确认并改写
                          </Button>
                        )}
                      </div>
                    </>
                  ) : x.stage === 'review' && x.recogMsg ? (
                    <div className="out-box empty">{x.recogMsg}</div>
                  ) : (
                    <div className="out-box empty">{isLink ? '填入链接后，点击左侧「解析链接」；解析成功后才能开始洗稿' : '贴入原稿件后，点击左侧「确认原稿件」，再填写洗稿要求并改写。'}</div>
                  )}
                </div>
              </div>
            
            <div className="panel">
              <div className="panel-head">
                <h3>
                  <Icon name="pen" className="ic" size={18} /> 洗稿文案
                </h3>
                <div className="spacer" />
                <Button size="sm" color="primary" isLoading={wordExporting} isDisabled={!hasOut || wordExporting} onPress={() => { void exportToLibrary(); }}>
                  <Icon name="archive" className="ic" size={14} /> 导出到素材库
                </Button>
                <Button size="sm" variant="bordered" isLoading={wordExporting} isDisabled={!hasOut || wordExporting} onPress={() => downloadWord(x.out, sourceTitle(x.mode === 'link' ? x.recog : x.src))}>
                  <Icon name="file" className="ic" size={14} /> 导出 Word
                </Button>
              </div>
              <div className="panel-body">
                <div className={`out-box ${hasOut ? '' : 'empty'}`}>
                  {x.out || (isLink ? '确认上方识别稿件后，AI 自动改写' : '点左侧「AI 洗稿」生成文案')}
                </div>
                <div className="optimize">
                  <div>
                    <div className="lab">不满意？输入修改意见，AI 即优化</div>
                    <Input
                      aria-label="洗稿优化意见"
                      value={optimizeHint}
                      onValueChange={setOptimizeHint}
                      placeholder="例：再口语点，加个 emoji"
                      size="sm"
                    />
                  </div>
                  <Button size="sm" isDisabled={!hasOut || loading} variant="bordered" onPress={() => runRewite(true)}>
                    <Icon name="refresh" className="ic" size={14} /> AI 优化
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <Modal isOpen={douyinModalOpen} onOpenChange={(open) => setXigao({ parseModalOpen: open })} size="5xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>抖音解析与下载</ModalHeader>
          <ModalBody>
            <div className="douyin-tool-intro">当前抖音链接已交给 wechat-mp-tools 原软件处理。下载过程中可直接查看下方原软件页面的解析与下载进度。</div>
            {douyinTaskError && <div className="source-feedback danger" role="alert"><div className="source-feedback-title"><Icon name="alert" className="ic" size={15} /> 抖音下载失败</div><div>{douyinTaskError}</div></div>}
            <div className="tool-frame-wrap">
              <iframe className="douyin-tool-frame" title="wechat-mp-tools 抖音解析页面" src="http://127.0.0.1:5200/#dy_parse" />
              {!douyinTaskError && douyinTaskStatus !== 'completed' && (
                <div className="tool-wait-overlay" role="status">
                  <Spinner size="sm" color="primary" />
                  <strong>正在下载视频，请耐心等待</strong>
                  <span>下载完成前，请勿点击或操作下方原软件页面。</span>
                </div>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <span className="tiny">{douyinTaskStatus === 'completed' ? '下载成功，正在返回工作台…' : douyinTaskError ? '请关闭弹窗后检查 Cookie 或重试' : '正在等待原软件完成下载…'}</span>
            <Button variant="light" onPress={() => setXigao({ parseModalOpen: false })}>关闭</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={xhsModalOpen} onOpenChange={(open) => setXigao({ parseModalOpen: open })} size="5xl" scrollBehavior="inside">
        <ModalContent>
          <ModalHeader>小红书图文解析与下载</ModalHeader>
          <ModalBody>
            <div className="douyin-tool-intro">当前小红书链接已交给 wechat-mp-tools 原软件处理。图文会下载为本地图片和文案，下载完成后才会解锁 AI 识别。</div>
            {xhsTaskError && <div className="source-feedback danger" role="alert"><div className="source-feedback-title"><Icon name="alert" className="ic" size={15} /> 小红书下载失败</div><div>{xhsTaskError}</div></div>}
            <div className="tool-frame-wrap">
              <iframe className="douyin-tool-frame" title="wechat-mp-tools 小红书图文下载页面" src="http://127.0.0.1:5200/#xhs_download" />
              {!xhsTaskError && xhsTaskStatus !== 'completed' && (
                <div className="tool-wait-overlay" role="status">
                  <Spinner size="sm" color="primary" />
                  <strong>正在下载图片和文案，请耐心等待</strong>
                  <span>下载完成前，请勿点击或操作下方原软件页面。</span>
                </div>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <span className="tiny">{xhsTaskStatus === 'completed' ? '下载成功，正在返回工作台…' : xhsTaskError ? '请关闭弹窗后检查 Cookie 或重试' : '正在等待原软件完成图片和文案下载…'}</span>
            <Button variant="light" onPress={() => setXigao({ parseModalOpen: false })}>关闭</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={topicImportOpen} onOpenChange={setTopicImportOpen} size="lg" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>从选题表导入链接</ModalHeader>
              <ModalBody>
                <p className="tiny" style={{ marginTop: -4 }}>选择一条已采用的选题，导入其原内容链接后再识别并洗稿。</p>
                <div style={{ display: 'grid', gap: 6 }}>
                  {importableTopics.map((topic) => {
                    const selected = topic.id === selectedTopicId;
                    return (
                      <label
                        key={topic.id}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', padding: '9px 10px',
                          border: `1px solid ${selected ? 'var(--accent-line)' : 'var(--border)'}`,
                          borderRadius: 'var(--radius-sm)', background: selected ? 'var(--accent-weak)' : 'var(--surface)',
                          color: 'var(--text)', textAlign: 'left', cursor: 'pointer',
                        }}
                      >
                        <Checkbox size="sm" isSelected={selected} onValueChange={() => setSelectedTopicId(topic.id)} aria-label={`选择 ${topic.title}`} />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>{topic.title}</span>
                          <span className="tiny" style={{ display: 'block', marginTop: 3 }}>{topic.platform} · {topic.source} · 已获取原内容链接</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose}>取消</Button>
                <Button color="primary" isDisabled={!selectedTopicId} onPress={importSelectedTopic}>
                  导入所选链接
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {tab === 'lib' && (
        <div className="panel">
          <div className="panel-head">
            <h3>
              <Icon name="inbox" className="ic" size={18} /> 洗稿表
            </h3>
            <div className="spacer" />
            <Button size="sm" color="danger" isDisabled={!xigaoTable.length} onPress={() => { clearXigaoTable(); toast('洗稿表已清空', 'default'); }}>
              <Icon name="trash" className="ic" size={14} /> 清空
            </Button>
          </div>
          <div className="panel-body">
            <div className="table-wrap">
              <table className="topic-table">
                <thead>
                  <tr>
                    <th>序列</th>
                    <th>原稿件标题</th>
                    <th>来源</th>
                    <th>原稿件链接</th>
                    <th>洗稿后文件</th>
                  </tr>
                </thead>
                <tbody>
                  {xigaoTable.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="empty-row">
                        还没有洗稿记录 · 完成洗稿后点「导出到素材库」
                      </td>
                    </tr>
                  ) : (
                    xigaoTable.map((f, i) => (
                      <tr key={f.id}>
                        <td className="seq">{i + 1}</td>
                        <td className="t-title">{f.title}</td>
                        <td>{f.source === '—' ? '—' : <span className={`topic-source topic-source-${f.source === '热榜' ? 'hot' : 'search'}`}>{f.source}</span>}</td>
                        <td>{f.link ? <a className="t-link" href={f.link} target="_blank" rel="noreferrer">打开 ↗</a> : '—'}</td>
                        <td>
                          <a className="t-link" onClick={() => downloadWord(f.content, f.title)}>{f.fileName || `洗稿+${f.title}.docx`} ↧</a>
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
