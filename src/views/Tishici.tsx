import { useState } from 'react';
import { Button, Textarea, Input, Chip, Checkbox, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Slider } from '@heroui/react';
import { useApp, setChutu, setTishici, setView, updateWorkflow } from '../store/appStore';
import { api } from '../api/client';
import { Icon } from '../icons';
import { useToastMsg, copyText } from '../lib/ui';

export default function Tishici() {
  const t = useApp((s) => s.tishici);
  const xigaoTable = useApp((s) => s.xigaoTable);
  const creativeTable = useApp((s) => s.creativeTable);
  const toast = useToastMsg();
  const [optimizeHint, setOptimizeHint] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [selectedXigaoId, setSelectedXigaoId] = useState('');
  const [creativeImportOpen, setCreativeImportOpen] = useState(false);
  const [selectedCreativeId, setSelectedCreativeId] = useState('');

  async function onWordUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const text = /\.txt$/i.test(f.name) ? await f.text() : (await api.parseWord({ name: f.name, data: await fileToDataUrl(f) })).text || '';
      if (!text.trim()) throw new Error('未读取到正文内容');
      setTishici({ src: text.trim() });
      toast(`已导入 Word「${f.name}」`, 'success');
    } catch (error: any) {
      toast(error?.message || 'Word 导入失败', 'danger');
    } finally {
      e.target.value = '';
    }
  }

  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });
  }

  async function generate(optimize = false) {
    if (t.generating) return toast('提示词仍在生成中，请等待完成后再操作', 'warning');
    if (!t.src.trim()) return toast('请先填写稿件内容', 'warning');
    if (optimize && !optimizeHint.trim()) return toast('请先填写优化意见', 'warning');
    setTishici({ generating: true });
    try {
      const r = await api.genTishici({
        source: t.src,
        desc: [t.desc.trim(), t.constraints.trim() ? `约束：${t.constraints.trim()}` : ''].filter(Boolean).join('\n'),
        type: t.type,
        imageCount: t.imageCount,
        optimizeHint: optimize ? optimizeHint.trim() : undefined,
        previousText: optimize ? t.outText : undefined,
        previousImg: optimize ? t.outImg : undefined,
        previousImgs: optimize ? t.outImgs : undefined,
      });
      if (r.error) throw new Error(r.error);
      const text = t.type === 'tp' ? r.outText ?? r.text ?? '' : '';
      const responseImgs = Array.isArray(r.outImgs) ? r.outImgs : Array.isArray(r.imgs) ? r.imgs : r.outImg ? [r.outImg] : r.img ? [r.img] : [];
      const imgs = responseImgs.map((item) => String(item || ''));
      const img = imgs[0] || '';
      const requiredCount = t.imageCount;
      const complete = t.type === 'img'
        ? Boolean(img.trim())
        : Boolean(text.trim()) && imgs.length >= requiredCount && imgs.slice(0, requiredCount).every((item) => item.trim());
      setTishici({
        outText: text,
        outImg: img,
        outImgs: imgs,
        done: complete,
        parseMode: r.parseMode || r.mode || '',
      });
      const mode = r.parseMode || r.mode;
      if (optimize) toast('已按意见优化', 'success');
      else toast(mode === 'failed' ? 'AI 未按格式输出，已整段放入文案框' : mode === 'partial' ? '部分图片提示词缺失，请补齐后再出图' : mode === 'fallback' ? '已按小标题兜底拆分' : '提示词已生成', mode === 'delim' || mode === 'single' ? 'success' : 'warning');
    } catch (e: any) {
      toast(e?.message || '生成失败', 'danger');
    } finally {
      setTishici({ generating: false });
    }
  }

  const parseNote =
    t.parseMode === 'fallback'
      ? { cls: 'warn', msg: 'AI 未使用约定分隔符，系统已按「图片提示词」小标题兜底拆分，请核对两框内容是否正确。' }
      : t.parseMode === 'partial'
        ? { cls: 'warn', msg: `AI 少生成了部分图片提示词，请补齐 ${t.imageCount} 张图片的提示词后再出图。` }
      : t.parseMode === 'failed'
        ? { cls: 'err', msg: '拆分失败：AI 输出里既没有分隔符也没有小标题，已整段放入「文字文案」。可重新生成，或手动把图片提示词剪切到下框。' }
        : null;

  const outputImgs = t.outImgs?.length ? t.outImgs : t.outImg.trim() ? [t.outImg] : [];
  const visibleImageCount = t.imageCount;
  const hasAllImagePrompts = outputImgs.length >= visibleImageCount && outputImgs.slice(0, visibleImageCount).every((item) => item.trim());

  function setImagePrompt(index: number, value: string) {
    const next = Array.from({ length: visibleImageCount }, (_, current) => current === index ? value : outputImgs[current] || '');
    setTishici({
      outImg: next[0] || '',
      outImgs: next,
      done: t.type === 'img'
        ? Boolean(next[0]?.trim())
        : Boolean(t.outText.trim()) && next.every((item) => item.trim()),
    });
  }

  const washRecords = [...xigaoTable].filter((record) => record.content.trim());

  function openImportFromXigaoTable() {
    if (!washRecords.length) return toast('洗稿表暂无可导入内容，先完成一次洗稿并导出到洗稿表', 'warning');
    setSelectedXigaoId(washRecords[0].id);
    setImportOpen(true);
  }

  function importFromXigaoTable() {
    const record = washRecords.find((item) => item.id === selectedXigaoId);
    if (!record) return toast('请选择一份洗稿内容', 'warning');
    setTishici({ src: record.content.trim() });
    setImportOpen(false);
    toast(`已导入「${record.title}」的完整洗稿内容`, 'success');
  }

  const creativeRecords = [...creativeTable].filter((record) => record.content.trim());

  function openImportFromCreativeTable() {
    if (!creativeRecords.length) return toast('创意表暂无可导入内容，先完成一次创意并导出到素材库', 'warning');
    setSelectedCreativeId(creativeRecords[0].id);
    setCreativeImportOpen(true);
  }

  function importFromCreativeTable() {
    const record = creativeRecords.find((item) => item.id === selectedCreativeId);
    if (!record) return toast('请选择一份创意内容', 'warning');
    setTishici({ src: record.content.trim() });
    setCreativeImportOpen(false);
    toast(`已导入「${record.title}」的完整创意内容`, 'success');
  }

  function confirmAndGoToChutu() {
    const requiredCount = t.imageCount;
    const prompts = t.outImgs?.length ? t.outImgs : t.outImg.trim() ? [t.outImg] : [];
    if (prompts.length < requiredCount || prompts.slice(0, requiredCount).some((item) => !item.trim())) {
      return toast(`请先补齐 ${requiredCount} 张图片的提示词`, 'warning');
    }
    setChutu({
      prompt: prompts[0],
      refImg: '',
      refImgName: '',
      b64: null,
      done: false,
    });
    updateWorkflow('tishici', true);
    setView('chutu');
    toast(requiredCount > 1 ? '已带入第 1 张图片提示词；其余提示词保留在当前页面' : '提示词已确认，已带入出图', 'success');
  }

  return (
    <div className="two-col">
      <div>
        <div className="panel">
          <div className="panel-head">
            <h3>
              <Icon name="layers" className="ic" size={18} /> 内容导入
            </h3>
            <div className="spacer" />
            <Button size="sm" variant="bordered" className="topic-outline-button" onPress={openImportFromCreativeTable}>
              <Icon name="spark" className="ic" size={14} /> 从创意表导入
            </Button>
            <Button size="sm" variant="bordered" className="topic-outline-button" onPress={openImportFromXigaoTable}>
              <Icon name="inbox" className="ic" size={14} /> 从洗稿表导入
            </Button>
            <Button as="label" size="sm" variant="bordered" className="topic-outline-button" style={{ cursor: 'pointer' }}>
              <Icon name="upload" className="ic" size={14} /> 导入 Word
              <input
                type="file"
                accept=".docx,.txt,text/plain"
                style={{ display: 'none' }}
                onChange={onWordUpload}
              />
            </Button>
          </div>
          <div className="panel-body">
            <div className="subtabs" style={{ marginBottom: 14 }}>
              <button disabled={t.generating} className={`subtabs-btn ${t.type === 'img' ? 'active' : ''}`} onClick={() => setTishici({ type: 'img', outText: '', outImg: '', outImgs: [], done: false, parseMode: '' })}>
                图片
              </button>
              <button disabled={t.generating} className={`subtabs-btn ${t.type === 'tp' ? 'active' : ''}`} onClick={() => setTishici({ type: 'tp', outText: '', outImg: '', outImgs: [], done: false, parseMode: '' })}>
                文字 + 图片
              </button>
            </div>
            <div className="field">
              <label>稿件内容（贴入）</label>
              <Textarea
                value={t.src}
                onValueChange={(v) => setTishici({ src: v })}
                isDisabled={t.generating}
                minRows={6}
                placeholder="贴入洗稿后的文案…"
              />
            </div>
            <div className="field">
              <label>图需求描述</label>
              <Input
                value={t.desc}
                onValueChange={(v) => setTishici({ desc: v })}
                isDisabled={t.generating}
                placeholder="例：端午粽子 + WiFi 融合，3:4 竖版"
              />
            </div>
            <div className="field">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <label style={{ marginBottom: 0 }}>图片数量</label>
                <Chip size="sm" color="primary" variant="flat">{t.imageCount} 张</Chip>
              </div>
              <Slider
                aria-label="图片数量"
                minValue={1}
                maxValue={9}
                step={1}
                value={t.imageCount}
                isDisabled={t.generating}
                showTooltip
                showSteps
                onChange={(value) => {
                  const count = Number(Array.isArray(value) ? value[0] : value);
                  if (!Number.isNaN(count)) setTishici({ imageCount: count, outImg: '', outImgs: [], done: false, parseMode: '' });
                }}
              />
              <div className="tiny" style={{ marginTop: 4 }}>拖动选择 1–9 张配图</div>
            </div>
            <div className="field">
              <label>约束</label>
              <Input value={t.constraints} isDisabled={t.generating} onValueChange={(v) => setTishici({ constraints: v })} placeholder="例：思源黑体 · 宽 1080 · 负面：政企风 / 乱码" />
            </div>
            <Button color="primary" className="w-full" style={{ marginTop: 14 }} isLoading={t.generating} isDisabled={t.generating} onPress={() => generate(false)}>
              AI 生成提示词
            </Button>
          </div>
        </div>
      </div>

      <div>
        <div className="panel">
          <div className="panel-head">
            <h3>
              <Icon name="wand" className="ic" size={18} /> 生成提示词
            </h3>
            <div className="spacer" />
          </div>
          <div className="panel-body">
            {parseNote && (
              <div className={`parse-note ${parseNote.cls}`}>
                <Icon name="alert" className="ic" size={15} />
                <span>{parseNote.msg}</span>
                <Button size="sm" variant="light" isDisabled={t.generating} onPress={() => generate(false)}>
                  <Icon name="refresh" className="ic" size={14} /> 重新生成
                </Button>
              </div>
            )}
            {t.type === 'tp' && (
              <div id="tTextWrap">
                <div className="out-head">
                  <b style={{ fontSize: 13 }}>文字文案</b>
                  {t.parseMode === 'delim' && <Chip size="sm" variant="flat" color="success">已拆分</Chip>}
                  <div className="spacer" />
                  <Button size="sm" variant="light" isDisabled={!t.outText} onPress={() => copyText(t.outText)}>
                    <Icon name="copy" className="ic" size={14} /> 复制
                  </Button>
                </div>
                <Textarea
                  aria-label="文字文案"
                  className="output-editor"
                  value={t.outText}
                  onValueChange={(v) => setTishici({ outText: v, done: t.type === 'img' ? Boolean(outputImgs[0]?.trim()) : Boolean(v.trim()) && hasAllImagePrompts })}
                  minRows={6}
                  placeholder="点击左侧「AI 生成提示词」生成提示词"
                />
              </div>
            )}
            {Array.from({ length: visibleImageCount }, (_, index) => (
              <div key={index} id={index === 0 ? 'tImgWrap' : undefined} style={t.type === 'tp' || index > 0 ? { marginTop: 14 } : undefined}>
                <div className="out-head">
                  <b style={{ fontSize: 13 }}>{`图片 ${index + 1} 提示词`}</b>
                  <div className="spacer" />
                  <Button size="sm" variant="light" isDisabled={!outputImgs[index]} onPress={() => copyText(outputImgs[index] || '')}>
                    <Icon name="copy" className="ic" size={14} /> 复制
                  </Button>
                </div>
                <Textarea
                  aria-label={`图片 ${index + 1} 提示词`}
                  className="output-editor output-editor-code"
                  value={outputImgs[index] || ''}
                  onValueChange={(v) => setImagePrompt(index, v)}
                  minRows={6}
                  placeholder="点击左侧「AI 生成提示词」生成提示词"
                />
              </div>
            ))}
            <div className="optimize">
              <div>
                <div className="lab">不满意？输入修改意见</div>
                <Input
                  aria-label="提示词优化意见"
                  value={optimizeHint}
                  onValueChange={setOptimizeHint}
                  placeholder="例：标题再俏皮点"
                  size="sm"
                />
              </div>
              <Button size="sm" isDisabled={!t.done || t.generating} variant="bordered" className="topic-outline-button" onPress={() => generate(true)}>
                <Icon name="refresh" className="ic" size={14} /> AI 优化
              </Button>
            </div>
            <div className="confirm-handoff">
              <span>确认人工编辑后的图片提示词，再进入出图。</span>
              <Button color="primary" isDisabled={!hasAllImagePrompts} onPress={confirmAndGoToChutu}>
                <Icon name="image" className="ic" size={14} /> 确认并出图
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Modal isOpen={importOpen} onOpenChange={setImportOpen} size="lg" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>从洗稿表导入内容</ModalHeader>
              <ModalBody>
                <p className="tiny" style={{ marginTop: -4 }}>选择一条已完成的洗稿记录，直接导入其洗稿后正文。</p>
                <div style={{ display: 'grid', gap: 6 }}>
                  {washRecords.map((record) => {
                    const selected = record.id === selectedXigaoId;
                    return (
                      <label
                        key={record.id}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', padding: '9px 10px',
                          border: `1px solid ${selected ? 'var(--accent-line)' : 'var(--border)'}`,
                          borderRadius: 'var(--radius-sm)', background: selected ? 'var(--accent-weak)' : 'var(--surface)',
                          color: 'var(--text)', textAlign: 'left', cursor: 'pointer',
                        }}
                      >
                        <Checkbox size="sm" isSelected={selected} onValueChange={() => setSelectedXigaoId(record.id)} aria-label={`选择 ${record.title}`} />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>{record.title}</span>
                          <span className="tiny" style={{ display: 'block', marginTop: 3 }}>{record.source === '—' ? '手动导入' : record.source} · 已完成洗稿</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose}>取消</Button>
                <Button color="primary" isDisabled={!selectedXigaoId} onPress={importFromXigaoTable}>导入所选洗稿</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
      <Modal isOpen={creativeImportOpen} onOpenChange={setCreativeImportOpen} size="lg" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>从创意表导入内容</ModalHeader>
              <ModalBody>
                <p className="tiny" style={{ marginTop: -4 }}>选择一条已归档的创意记录，直接导入其完整创意正文。</p>
                <div style={{ display: 'grid', gap: 6 }}>
                  {creativeRecords.map((record) => {
                    const selected = record.id === selectedCreativeId;
                    return <label key={record.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', padding: '9px 10px', border: `1px solid ${selected ? 'var(--accent-line)' : 'var(--border)'}`, borderRadius: 'var(--radius-sm)', background: selected ? 'var(--accent-weak)' : 'var(--surface)', color: 'var(--text)', textAlign: 'left', cursor: 'pointer' }}>
                      <Checkbox size="sm" isSelected={selected} onValueChange={() => setSelectedCreativeId(record.id)} aria-label={`选择 ${record.title}`} />
                      <span style={{ minWidth: 0 }}><span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 13, fontWeight: 600, lineHeight: 1.4 }}>{record.title}</span><span className="tiny" style={{ display: 'block', marginTop: 3 }}>热点：{record.hotTitle || '—'} · 已完成创意</span></span>
                    </label>;
                  })}
                </div>
              </ModalBody>
              <ModalFooter><Button variant="light" onPress={onClose}>取消</Button><Button color="primary" isDisabled={!selectedCreativeId} onPress={importFromCreativeTable}>导入所选创意</Button></ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
