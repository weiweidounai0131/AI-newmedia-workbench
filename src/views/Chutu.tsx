import { useEffect, useState } from 'react';
import { Button, Textarea, Chip, Input } from '@heroui/react';
import { useApp, setChutu, exportImageToLib } from '../store/appStore';
import { api } from '../api/client';
import { Icon } from '../icons';
import { useToastMsg, mapSize, mapQuality } from '../lib/ui';

// API 默认 gpt-image-2：按已确认的 AIHubMix 能力开放 1K / 2K / 4K 画幅。
const AIHUBMIX_SIZES = ['自动', '1024×1024', '1536×1024', '1024×1536', '2048×2048', '2048×1152', '3840×2160', '2160×3840'];
const QUALITIES = ['自动', '低', '中', '高'];

export default function Chutu() {
  const chutu = useApp((s) => s.chutu);
  const toast = useToastMsg();
  const [optimizeHint, setOptimizeHint] = useState('');
  const [codexStatus, setCodexStatus] = useState<{ available: boolean; message: string; version?: string } | null>(null);
  const [usedProvider, setUsedProvider] = useState<'api' | 'codex' | null>(null);

  useEffect(() => {
    api.chutuProviders()
      .then((result) => {
        setCodexStatus(result.codex);
        if (!result.codex.available && chutu.provider === 'codex') setChutu({ provider: 'api' });
      })
      .catch(() => {
        setCodexStatus({ available: false, message: '无法检查本机 Codex 状态' });
        if (chutu.provider === 'codex') setChutu({ provider: 'api' });
      });
  // 仅在首次打开页面时检测本机订阅；避免切页后重复检测。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = r.result as string;
      setChutu({ refImg: dataUrl, refImgName: f.name });
    };
    r.readAsDataURL(f);
  }

  async function generate(optimize = false) {
    if (chutu.generating) return toast('当前图片仍在生成中，请等待完成后再操作', 'warning');
    const prompt = chutu.prompt.trim();
    if (!prompt) return toast('请先填写提示词', 'warning');
    if (optimize && !optimizeHint.trim()) return toast('请先填写优化意见', 'warning');
    setChutu({ generating: true, b64: null, done: false, error: '' });
    try {
      const refImgs = chutu.refImg
        ? [
            {
              type: 'image' as const,
              data: chutu.refImg.split(',')[1] || '',
              mime: chutu.refImg.match(/data:(.*);/)?.[1] || 'image/png',
            },
          ]
        : undefined;
      const r = await api.chutu({
        prompt,
        provider: chutu.provider,
        refImgs, // 首次生成与优化都携带相同参考图
        size: mapSize(chutu.size),
        quality: mapQuality(chutu.quality),
        optimizeHint: optimize ? optimizeHint.trim() : undefined,
      });
      if (r.error) throw new Error(r.error);
      const img = r.images?.[0]?.b64;
      if (!img) throw new Error('上游未返回图片');
      setChutu({ b64: img, done: true, lastProvider: r.provider || chutu.provider, error: '' });
      setUsedProvider(r.provider || chutu.provider);
      toast(chutu.provider === 'codex' ? 'Codex 订阅出图完成' : 'API 出图完成', 'success');
    } catch (e: any) {
      const raw = e?.message || '出图失败';
      const message = /connection error|fetch failed/i.test(raw)
        ? '无法连接 AIHubMix 主网关，图片没有生成。请检查网络后重试。'
        : `生图失败：${raw}`;
      setChutu({ error: message, done: false, b64: null });
      toast(message, 'danger');
    } finally {
      setChutu({ generating: false });
    }
  }

  function download() {
    if (!chutu.b64) return;
    const a = document.createElement('a');
    a.href = `data:image/png;base64,${chutu.b64}`;
    a.download = `${chutu.refImgName || '海报'}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast('已下载', 'success');
  }

  async function exportLib() {
    if (!chutu.b64) return toast('请先生成成品', 'warning');
    const name = (chutu.refImgName || '海报').replace(/\.\w+$/, '');
    try {
      await exportImageToLib(name, `data:image/png;base64,${chutu.b64}`);
      toast(`已导出到素材库 · 图片 / ${name}.png`, 'success');
    } catch (error: any) {
      toast(error?.message || '请先设置素材库目录', 'warning');
    }
  }

  return (
    <div className="two-col">
      <div>
        <div className="panel">
          <div className="panel-head">
            <h3>
              <Icon name="image" className="ic" size={18} /> 出图
            </h3>
            <div className="spacer" />
          </div>
          <div className="panel-body">
            <div className="field">
              <label>出图方式</label>
              <div className="chip-row" style={{ gap: 8 }}>
                <Button
                  size="sm"
                  color={chutu.provider === 'api' ? 'primary' : 'default'}
                  variant={chutu.provider === 'api' ? 'solid' : 'bordered'}
                  className={chutu.provider === 'api' ? undefined : 'topic-outline-button'}
                  isDisabled={chutu.generating}
                  onPress={() => setChutu({
                    provider: 'api',
                    size: AIHUBMIX_SIZES.includes(chutu.size) ? chutu.size : '自动',
                    b64: null,
                    done: false,
                  })}
                >
                  API（AIHubMix）
                </Button>
                {codexStatus?.available && (
                  <Button
                    size="sm"
                    color={chutu.provider === 'codex' ? 'primary' : 'default'}
                    variant={chutu.provider === 'codex' ? 'solid' : 'bordered'}
                    className={chutu.provider === 'codex' ? undefined : 'topic-outline-button'}
                    isDisabled={chutu.generating}
                    onPress={() => setChutu({ provider: 'codex', b64: null, done: false })}
                  >
                    Codex 订阅（本机）
                  </Button>
                )}
              </div>
              <div className={`tiny ${chutu.provider === 'codex' && !codexStatus?.available ? 'err-text' : ''}`} style={{ marginTop: 7 }}>
                {chutu.provider === 'codex' ? (codexStatus?.message || '正在检查本机 Codex 订阅…') : 'AIHubMix · gpt-image-2 · 使用设置页已保存的 Key'}
              </div>
            </div>
            <div className="field">
              <label>提示词（从提示词模块确认后贴入）</label>
              <Textarea
                value={chutu.prompt}
                onValueChange={(v) => setChutu({ prompt: v })}
                isDisabled={chutu.generating}
                minRows={6}
                placeholder="贴入图片提示词…"
              />
            </div>
            <label className="upload" htmlFor="cUp" style={chutu.generating ? { opacity: 0.55, pointerEvents: 'none' } : undefined}>
              <Icon name="upload" className="ic" size={26} />
              <div>上传参考图（可选）</div>
              <input id="cUp" type="file" accept="image/*" onChange={onUpload} />
            </label>
            {chutu.refImg && (
              <img className="preview-img" src={chutu.refImg} alt="参考图" style={{ display: 'block' }} />
            )}
            {chutu.provider === 'api' && <div className="params">
              <div className="param-row">
                <div className="param-head">
                  <span className="param-name">尺寸</span>
                  <span className="param-type">size</span>
                </div>
                <div className="chip-row">
                  {AIHUBMIX_SIZES.map((s) => (
                    <span
                      key={s}
                      className={`chip ${s === chutu.size ? 'active' : ''}`}
                      onClick={() => { if (!chutu.generating) setChutu({ size: s }); }}
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
              <div className="param-row">
                <div className="param-head">
                  <span className="param-name">质量</span>
                  <span className="param-type">quality</span>
                </div>
                <div className="chip-row">
                  {QUALITIES.map((q) => (
                    <span
                      key={q}
                      className={`chip ${q === chutu.quality ? 'active' : ''}`}
                      onClick={() => { if (!chutu.generating) setChutu({ quality: q }); }}
                    >
                      {q}
                    </span>
                  ))}
                </div>
              </div>
            </div>}
            <div className="divider" />
            <Button color="primary" className="w-full" isLoading={chutu.generating} isDisabled={chutu.generating} onPress={() => generate(false)}>
              生成成品
            </Button>
          </div>
        </div>
      </div>

      <div>
        <div className="panel">
          <div className="panel-head">
            <h3>
              <Icon name="image" className="ic" size={18} /> 成品预览
            </h3>
            <div className="spacer" />
            <Button size="sm" variant="bordered" className="topic-outline-button" isDisabled={!chutu.done || chutu.generating} onPress={download}>
              <Icon name="download" className="ic" size={14} /> 下载
            </Button>
            <Button size="sm" variant="bordered" className="topic-outline-button" isDisabled={!chutu.done || chutu.generating} onPress={exportLib}>
              <Icon name="archive" className="ic" size={14} /> 导出
            </Button>
          </div>
          <div className="panel-body" style={{ display: 'grid', placeItems: 'center', minHeight: 320 }}>
            {chutu.generating ? (
              <div style={{ width: '72%', display: 'grid', gap: 11 }} aria-label="模型生成中">
                <div className="skeleton sk-line" style={{ width: '94%', height: 14 }} />
                <div className="skeleton sk-line" style={{ width: '76%', height: 14 }} />
                <div className="skeleton sk-line" style={{ width: '86%', height: 14 }} />
                <div className="tiny" style={{ marginTop: 4, textAlign: 'center' }}>模型生成中，请稍候…</div>
              </div>
            ) : chutu.b64 ? (
              <img
                src={`data:image/png;base64,${chutu.b64}`}
                alt="成品"
                style={{ width: '100%', maxWidth: 300, borderRadius: 12, boxShadow: 'var(--shadow)' }}
              />
            ) : (
              <div className="empty-state">
                <Icon name="image" className="ic" size={40} />
                <div className="e-t">尚未生成</div>
                <div className="e-d">点左侧「生成成品」调模型出图</div>
              </div>
            )}
          </div>
          {chutu.error && (
            <div className="chutu-error" role="alert">
              <Icon name="alert" className="ic" size={18} />
              <div><b>上一次生图未完成</b><span>{chutu.error}</span></div>
              <Button isIconOnly size="sm" variant="light" aria-label="关闭失败提示" onPress={() => setChutu({ error: '' })}><Icon name="x" className="ic" size={16} /></Button>
            </div>
          )}
          <div className="panel-body" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="optimize" style={{ marginTop: 0, paddingTop: 0, border: 'none' }}>
              <div>
                <div className="lab">不满意？输入修改意见，重新出图</div>
                <Input
                  aria-label="出图优化意见"
                  value={optimizeHint}
                  onValueChange={setOptimizeHint}
                  placeholder="例：背景再清新点"
                  size="sm"
                />
              </div>
              <Button size="sm" isDisabled={!chutu.done || chutu.generating} variant="bordered" className="topic-outline-button" onPress={() => generate(true)}>
                <Icon name="refresh" className="ic" size={14} /> AI 优化
              </Button>
            </div>
          </div>
        </div>
        {chutu.b64 && (
          <div style={{ marginTop: 10, textAlign: 'center' }}>
            <Chip color="success" variant="flat">
              已生成 · 固定 1 张 · {(chutu.lastProvider || usedProvider) === 'codex' ? 'Codex 订阅' : 'API'}
            </Chip>
          </div>
        )}
      </div>
    </div>
  );
}
