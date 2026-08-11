import { useMemo, useState } from 'react';
import { Button, Checkbox, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Radio, RadioGroup, Textarea } from '@heroui/react';
import { addCreativeTableRecord, clearCreativeTable, exportTextToLib, useApp, setCreative } from '../store/appStore';
import { api } from '../api/client';
import { Icon } from '../icons';
import { useToastMsg } from '../lib/ui';

export default function Chuangyi() {
  const creative = useApp((s) => s.creative);
  const creativeTable = useApp((s) => s.creativeTable);
  const topics = useApp((s) => s.xuanti.topics);
  const toast = useToastMsg();
  const [tab, setTab] = useState<'work' | 'table'>('work');
  const [importOpen, setImportOpen] = useState(false);
  const [selectedTopicId, setSelectedTopicId] = useState('');
  const [optimizeHint, setOptimizeHint] = useState('');
  const [exporting, setExporting] = useState(false);
  const [optimizing, setOptimizing] = useState(false);

  const hotTopics = useMemo(() => topics.filter((topic) => topic.source === '热榜' && Boolean(topic.link)), [topics]);
  const directionsLoading = creative.stage === 'directionsLoading';
  const generating = creative.stage === 'generating';
  const hasOut = Boolean(creative.out.trim());
  const flowIndex = creative.stage === 'generating' || creative.stage === 'done' ? 2 : creative.stage === 'directionsReady' ? 1 : 0;

  function openImport() {
    if (!hotTopics.length) return toast('选题表暂无可导入的热榜链接，搜索内容请在「洗稿」模块使用', 'warning');
    setSelectedTopicId(hotTopics[0].id);
    setImportOpen(true);
  }

  function importTopic() {
    const topic = hotTopics.find((item) => item.id === selectedTopicId);
    if (!topic) return;
    setCreative({ link: topic.link, title: topic.title, directions: [], selected: null, out: '', stage: 'idle' });
    setImportOpen(false);
    toast('已导入热榜内容，可结合业务信息生成创意方向', 'success');
  }

  async function generateDirections() {
    if (directionsLoading || generating) return;
    if (!creative.link.trim()) return toast('请先填写或导入热榜链接', 'warning');
    if (!creative.integration.trim()) return toast('请填写需要结合的公司、产品或传播信息', 'warning');
    setCreative({ stage: 'directionsLoading', directions: [], selected: null, out: '' });
    try {
      const result = await api.creativeDirections({ link: creative.link.trim(), title: creative.title.trim(), integration: creative.integration.trim() });
      if (!result.directions || result.directions.length !== 4) throw new Error(result.error || 'AI 未生成完整的 4 个创意方向');
      setCreative({ directions: result.directions, selected: null, stage: 'directionsReady', model: result.model || '' });
      toast('已生成 4 个借势创意方向，请选择一个继续创作', 'success');
    } catch (error: any) {
      setCreative({ stage: 'idle' });
      toast(error?.message || '创意方向生成失败', 'danger');
    }
  }

  async function generateContent() {
    if (generating || directionsLoading) return;
    if (creative.selected === null || !creative.directions[creative.selected]) return toast('请先选择一个创作方向', 'warning');
    setCreative({ stage: 'generating', out: '' });
    try {
      const result = await api.creativeGenerate({ link: creative.link.trim(), title: creative.title.trim(), integration: creative.integration.trim(), direction: creative.directions[creative.selected], requirement: creative.requirement.trim() });
      if (!result.out?.trim()) throw new Error(result.error || 'AI 未返回内容');
      setCreative({ out: result.out, stage: 'done', model: result.model || creative.model });
      toast('创意内容已生成', 'success');
    } catch (error: any) {
      setCreative({ stage: 'directionsReady' });
      toast(error?.message || 'AI 生成失败', 'danger');
    }
  }

  async function optimizeContent() {
    if (!hasOut) return toast('请先生成创意内容', 'warning');
    if (!optimizeHint.trim()) return toast('请先填写优化意见', 'warning');
    setOptimizing(true);
    try {
      const result = await api.creativeOptimize({ content: creative.out, hint: optimizeHint.trim() });
      if (!result.out?.trim()) throw new Error(result.error || 'AI 未返回优化内容');
      setCreative({ out: result.out, stage: 'done', model: result.model || creative.model });
      toast('已按意见优化创意内容', 'success');
    } catch (error: any) {
      toast(error?.message || 'AI 优化失败', 'danger');
    } finally { setOptimizing(false); }
  }

  function creativeFileBase() {
    return (creative.title || creative.out.replace(/\s+/g, '').slice(0, 12) || '未命名创意').replace(/[\\/:*?"<>|]/g, '_');
  }

  async function downloadWord(content = creative.out, title = creativeFileBase()) {
    if (!content.trim()) return toast('没有可导出的创意内容', 'warning');
    try {
      const blob = await api.downloadWord({ name: `创意+${title}`, content });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `创意+${title}.docx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error: any) { toast(error?.message || '导出 Word 失败', 'danger'); }
  }

  async function exportToLibrary() {
    if (!hasOut) return toast('请先生成创意内容再导出', 'warning');
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const title = creativeFileBase();
    const fileName = `创意+${title}+${stamp}.docx`;
    setExporting(true);
    try {
      await exportTextToLib('创意', fileName, creative.out);
      addCreativeTableRecord({ title, hotTitle: creative.title || '未命名热点', hotLink: creative.link, content: creative.out, fileName });
      toast(`已导出到素材库 · 创意 / ${fileName}`, 'success');
    } catch (error: any) {
      toast(error?.message || '导出到素材库失败', 'danger');
    } finally { setExporting(false); }
  }

  return <>
    <div className="xuanti-tabs" role="tablist" style={{ marginBottom: 16 }}>
      <button className={`xuanti-tab ${tab === 'work' ? 'active' : ''}`} onClick={() => setTab('work')}><Icon name="spark" className="ic" size={17} /><span>创意</span></button>
      <button className={`xuanti-tab ${tab === 'table' ? 'active' : ''}`} onClick={() => setTab('table')}><Icon name="archive" className="ic" size={17} /><span>创意表</span><span className="count">{creativeTable.length}</span></button>
    </div>

    {tab === 'work' ? <>
      <div className="flow-steps flow-steps-three" aria-label="创意流程">
        {['解析来源', '确认内容', 'AI 输出'].map((step, index, all) => <span key={step} style={{ display: 'contents' }}>
          <div className={`fstep ${index < flowIndex ? 'done' : ''} ${index === flowIndex ? 'cur' : ''}`}>
            <i>{index < flowIndex ? '✓' : index + 1}</i><span>{step}</span>
          </div>
          {index < all.length - 1 && <em className="fsep" aria-hidden="true" />}
        </span>)}
      </div>
      <div className="two-col creative-layout">
      <div>
        <div className="panel">
          <div className="panel-head"><h3><Icon name="inbox" className="ic" size={18} /> 内容导入</h3><div className="spacer" /><Button size="sm" variant="bordered" className="topic-outline-button" onPress={openImport}><Icon name="upload" className="ic" size={14} /> 从选题表导入</Button></div>
          <div className="panel-body">
            <div className="tiny" style={{ marginBottom: 9 }}>仅支持热榜内容导入；搜索到的单条内容请在「洗稿」模块处理。</div>
            <div className="field"><label>热榜链接</label><Input value={creative.link} onValueChange={(link) => setCreative({ link, title: creative.title, directions: [], selected: null, out: '', stage: 'idle' })} placeholder="粘贴热榜链接" isDisabled={directionsLoading || generating} /></div>
            {creative.title && <div className="creative-topic"><span className="topic-source topic-source-hot">热榜</span><span>{creative.title}</span></div>}
          </div>
        </div>
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head"><h3><Icon name="layers" className="ic" size={18} /> 结合信息</h3></div>
          <div className="panel-body">
            <Textarea value={creative.integration} onValueChange={(integration) => setCreative({ integration, directions: [], selected: null, out: '', stage: 'idle' })} placeholder="例如：我们的产品是什么、希望融入哪些卖点，或希望借势传播的内容" minRows={6} isDisabled={directionsLoading || generating} />
            <Button className="w-full" color="primary" isLoading={directionsLoading} isDisabled={directionsLoading || generating} onPress={() => void generateDirections()} style={{ marginTop: 14 }}>AI 创意生成</Button>
          </div>
        </div>
      </div>

      <div>
        <div className="panel">
          <div className="panel-head"><h3><Icon name="spark" className="ic" size={18} /> 创作方向 · 待你确认</h3><div className="spacer" />{creative.model && <span className="tiny">{creative.model}</span>}</div>
          <div className="panel-body">
            {directionsLoading ? <div className="out-box empty">正在根据热榜与结合信息生成 4 个借势方向…</div> : creative.directions.length ? <RadioGroup value={creative.selected === null ? undefined : String(creative.selected)} onValueChange={(value) => setCreative({ selected: Number(value), out: creative.out, stage: creative.stage === 'done' ? 'directionsReady' : creative.stage })} isDisabled={generating} className="creative-direction-group"><div className="creative-direction-grid">{creative.directions.map((direction, index) => <div key={index} className={`creative-direction-card ${creative.selected === index ? 'selected' : ''}`}><div className="creative-direction-head"><b>方向 {['一', '二', '三', '四'][index]}</b><Radio value={String(index)} aria-label={`选择方向${index + 1}`} /></div><div className="creative-direction-content">{direction}</div></div>)}</div></RadioGroup> : <div className="out-box empty">填写热榜链接与结合信息后，点击「AI 创意生成」获取 4 个借势宣传方向。</div>}
            <div style={{ marginTop: 16 }}>
              <div className="field"><label>创作要求（可选）</label><Input value={creative.requirement} onValueChange={(requirement) => setCreative({ requirement })} placeholder="例如：输出一个长海报的文案" isDisabled={generating || creative.selected === null} /></div>
              <Button color="primary" className="w-full" isLoading={generating} isDisabled={creative.selected === null || generating || directionsLoading} onPress={() => void generateContent()}>AI 生成</Button>
            </div>
          </div>
        </div>
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head"><h3><Icon name="pen" className="ic" size={18} /> 创意内容</h3><div className="spacer" /><Button size="sm" color="primary" isLoading={exporting} isDisabled={!hasOut || exporting} onPress={() => void exportToLibrary()}><Icon name="archive" className="ic" size={14} /> 导出到素材库</Button><Button size="sm" variant="bordered" className="topic-outline-button" isDisabled={!hasOut || exporting} onPress={() => void downloadWord()}><Icon name="file" className="ic" size={14} /> 导出 Word</Button></div>
          <div className="panel-body">
            <div className={`out-box ${hasOut ? '' : 'empty'}`}>{generating ? '正在根据选定方向生成内容…' : creative.out || '选择一个创作方向后，填写要求并点击「AI 生成」。'}</div>
            <div className="optimize"><div><div className="lab">不满意？输入修改意见，AI 即优化</div><Input aria-label="创意优化意见" value={optimizeHint} onValueChange={setOptimizeHint} placeholder="例：更口语一点，突出产品卖点" size="sm" /></div><Button size="sm" variant="bordered" className="topic-outline-button" isLoading={optimizing} isDisabled={!hasOut || optimizing} onPress={() => void optimizeContent()}><Icon name="refresh" className="ic" size={14} /> AI 优化</Button></div>
          </div>
        </div>
      </div>
    </div></> : <div className="panel">
      <div className="panel-head"><h3><Icon name="archive" className="ic" size={18} /> 创意表</h3><div className="spacer" /><Button size="sm" color="danger" isDisabled={!creativeTable.length} onPress={() => { if (window.confirm('确认清空创意表记录？本地素材库中的 Word 文件不会被删除。')) clearCreativeTable(); }}><Icon name="trash" className="ic" size={14} /> 清空</Button></div>
      <div className="panel-body" style={{ paddingTop: 0 }}>
        <div className="finder-list creative-table-list">
          <div className="finder-head creative-table-head"><span>序列</span><span>稿件标题</span><span>热点名称</span><span>热点链接</span><span>改写后的文件</span></div>
          {creativeTable.length ? creativeTable.map((item, index) => <div className="finder-row creative-table-row" key={item.id}><span>{index + 1}</span><span title={item.title}>{item.title}</span><span title={item.hotTitle}>{item.hotTitle}</span><span>{item.hotLink ? <a className="t-link" href={item.hotLink} target="_blank" rel="noreferrer">打开 ↗</a> : '—'}</span><span><a className="t-link" onClick={() => void downloadWord(item.content, item.fileName.replace(/^创意\+/, '').replace(/\.docx$/i, ''))}>{item.fileName} ↧</a></span></div>) : <div className="sucai-empty"><Icon name="archive" className="ic" size={30} /><div>还没有创意记录 · 生成后点「导出到素材库」即可归档</div></div>}
        </div>
      </div>
    </div>}

    <Modal isOpen={importOpen} onOpenChange={setImportOpen} size="lg" scrollBehavior="inside"><ModalContent>{(onClose) => <>
      <ModalHeader>从选题表导入热榜内容</ModalHeader>
      <ModalBody>
        <p className="tiny" style={{ marginTop: -4 }}>选择一条已采用的热榜内容，导入其链接后生成借势创意。</p>
        <div style={{ display: 'grid', gap: 6 }}>
          {hotTopics.map((topic) => {
            const selected = topic.id === selectedTopicId;
            return <label key={topic.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', padding: '9px 10px', border: `1px solid ${selected ? 'var(--accent-line)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', background: selected ? 'var(--accent-weak)' : 'var(--surface)', color: 'var(--text)', textAlign: 'left', cursor: 'pointer' }}>
              <Checkbox size="sm" isSelected={selected} onValueChange={() => setSelectedTopicId(topic.id)} aria-label={`选择 ${topic.title}`} />
              <span style={{ minWidth: 0 }}><span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>{topic.title}</span><span className="tiny" style={{ display: 'block', marginTop: 3 }}>{topic.platform} · 热榜 · {topic.heat || '—'}</span></span>
            </label>;
          })}
        </div>
      </ModalBody>
      <ModalFooter><Button variant="light" onPress={onClose}>取消</Button><Button color="primary" isDisabled={!selectedTopicId} onPress={importTopic}>导入所选热榜</Button></ModalFooter>
    </>}</ModalContent></Modal>
  </>;
}
