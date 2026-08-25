import { useEffect, useState, useRef } from 'react';
import { Button, Input, Select, SelectItem, Chip, Spinner, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from '@heroui/react';
import { CAP_SLOTS, type CapId } from '../../electron/main/server/services/caps';
import { useApp, setSettings, setView } from '../store/appStore';
import { api, getApiBase, type UpdateStatus } from '../api/client';
import { Icon } from '../icons';
import { useToastMsg } from '../lib/ui';
import appIcon from '../assets/app-icon.png';

const API_KEY_PORTALS: Record<CapId, string> = {
  text: 'https://platform.deepseek.com/',
  visionImg: 'https://open.bigmodel.cn/',
  visionVideo: 'https://bailian.console.aliyun.com/',
  image: 'https://aihubmix.com/',
};

export default function Settings() {
  const settings = useApp((s) => s.settings);
  const toast = useToastMsg();
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [verifying, setVerifying] = useState<Record<string, boolean>>({});
  const [capState, setCapState] = useState<Record<string, 'saved' | 'verified'>>({});
  const [editingCap, setEditingCap] = useState<Record<string, boolean>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  // M3：导出根目录可编辑并真实写入（POST /api/settings/rootdir）
  const [rootDirInput, setRootDirInput] = useState<string>('');
  const [savingRoot, setSavingRoot] = useState(false);
  // M4：抓取账号登录态
  const [scrapeStatus, setScrapeStatus] = useState<{ electron: boolean; platforms: Record<string, boolean> }>({ electron: false, platforms: {} });
  const [loginLoading, setLoginLoading] = useState<string | null>(null);
  // 二维码弹窗登录
  const [qrModal, setQrModal] = useState<{
    open: boolean;
    platform: string;
    qr: string | null;
    headful: boolean;
    error: string | null;
  }>({ open: false, platform: '', qr: null, headful: true, error: null });
  const [runtime, setRuntime] = useState<Awaited<ReturnType<typeof api.runtimeStatus>> | null>(null);
  const [runtimeInstalling, setRuntimeInstalling] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ phase: 'idle', percent: 0 });
  const [appVersion, setAppVersion] = useState('');
  const [mcpEndpoint, setMcpEndpoint] = useState('');
  const [mcpOnline, setMcpOnline] = useState<boolean | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (settings?.rootDir) setRootDirInput(settings.rootDir);
  }, [settings?.rootDir]);

  useEffect(() => {
    let active = true;
    void api.getUpdateStatus().then((status) => { if (active) setUpdateStatus(status); });
    return api.onUpdateStatus((status) => { if (active) setUpdateStatus(status); });
  }, []);

  useEffect(() => {
    let active = true;
    void api.getAppVersion().then((version) => { if (active) setAppVersion(version); });
    return () => { active = false; };
  }, []);

  // MCP 是工作台的备用入口；这里仅显示本机地址和健康状态，不把 Key 或认证信息暴露到前端。
  useEffect(() => {
    let active = true;
    const refreshMcp = async () => {
      try {
        const base = await getApiBase();
        const endpoint = `${base}/mcp`;
        const response = await fetch(`${endpoint}/health`, { cache: 'no-store' });
        if (active) {
          setMcpEndpoint(endpoint);
          setMcpOnline(response.ok);
        }
      } catch {
        if (active) setMcpOnline(false);
      }
    };
    void refreshMcp();
    const timer = window.setInterval(refreshMcp, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function copyMcpEndpoint() {
    if (!mcpEndpoint) return toast('MCP 地址尚未准备好，请稍候', 'warning');
    try {
      await navigator.clipboard.writeText(mcpEndpoint);
      toast('MCP 本机地址已复制', 'success');
    } catch {
      toast('复制失败，请手动选中地址复制', 'warning');
    }
  }

  // 拉取各平台抓取登录态
  useEffect(() => {
    api
      .scrapeStatus()
      .then(setScrapeStatus)
      .catch(() => {
        /* 后端不可用时保持未登录态 */
      });
    return () => stopPoll();
  }, []);

  function stopPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function startPoll(platform: string) {
    stopPoll();
    pollRef.current = setInterval(async () => {
    try {
      const r = await api.scrapeLoginSession(platform);
      if (r.error) {
        setQrModal((m) => ({ ...m, error: r.error ?? null }));
      }
        if (r.connected) {
          stopPoll();
          setQrModal({ open: false, platform: '', qr: null, headful: true, error: null });
          setScrapeStatus((s) => ({ ...s, platforms: { ...s.platforms, [platform]: true } }));
          toast(`已登录「${platform}」`, 'success');
          setLoginLoading(null);
        }
      } catch (e: any) {
        setQrModal((m) => ({ ...m, error: e?.message || '登录状态查询失败' }));
      }
    }, 2000);
  }

  async function scrapeLogin(platform: string) {
    setLoginLoading(platform);
    setQrModal({ open: true, platform, qr: null, headful: true, error: null });
    try {
      const r = await api.scrapeLoginQr(platform);
      if (r.error) {
        setQrModal((m) => ({ ...m, error: r.error ?? null }));
      } else if (r.connected) {
        setQrModal({ open: false, platform: '', qr: null, headful: true, error: null });
        setScrapeStatus((s) => ({ ...s, platforms: { ...s.platforms, [platform]: true } }));
        toast(`已登录「${platform}」`, 'success');
        setLoginLoading(null);
        return;
      } else {
        setQrModal((m) => ({ ...m, qr: r.qr, headful: r.headful }));
      }
      startPoll(platform);
    } catch (e: any) {
      setQrModal((m) => ({ ...m, error: e?.message || '登录失败' }));
      startPoll(platform); // 仍尝试轮询，用户可能手动在浏览器窗口扫码
    }
  }

  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch(() => toast('读取设置失败，请确认后端已启动', 'danger'));
  }, [toast]);

  useEffect(() => {
    let active = true;
    const refresh = () => api.runtimeStatus().then((value) => { if (active) { setRuntime(value); setRuntimeInstalling(value.installing); } }).catch(() => {});
    void refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  async function installRuntime() {
    setRuntimeInstalling(true);
    try {
      setRuntime(await api.installRuntime());
      toast('环境安装已开始，请保持网络连接', 'success');
    } catch (e: any) {
      toast(e?.message || '环境安装未能启动', 'danger');
      setRuntimeInstalling(false);
    }
  }

  async function checkForUpdates() {
    setCheckingUpdate(true);
    try {
      const result = await api.checkForUpdates();
      if (!result.ok) {
        const message: Record<string, string> = {
          'not-packaged': '请在已安装的软件中检查更新',
          'not-configured': '更新服务尚未配置',
          checking: '正在检查更新，请稍候',
          failed: '检查更新失败，请稍后重试',
        };
        toast(message[result.reason || 'failed'] || '检查更新失败，请稍后重试', result.reason === 'checking' ? 'warning' : 'danger');
      }
      // 有新版本或已是最新版本均由系统弹窗提示，避免与应用内提示重复。
    } catch (e: any) {
      toast(e?.message || '检查更新失败，请稍后重试', 'danger');
    } finally {
      setCheckingUpdate(false);
    }
  }

  const capMeta = (cap: CapId) => {
    const def = CAP_SLOTS[cap];
    const sum = settings?.caps.find((c) => c.cap === cap);
    return { def, configured: sum?.configured ?? false, verified: sum?.verified ?? false, model: sum?.model ?? def.defaultModel };
  };

  async function saveKey(cap: CapId) {
    const key = (keys[cap] ?? '').trim();
    if (!key) return toast('请先填写 Key', 'warning');
    setSaving((s) => ({ ...s, [cap]: true }));
    try {
      const r = await api.setKey(cap, key);
      if (r.error) throw new Error(r.error);
      toast(`${CAP_SLOTS[cap].label} Key 已本地加密保存`, 'success');
      setCapState((s) => ({ ...s, [cap]: 'saved' }));
      setEditingCap((s) => ({ ...s, [cap]: false }));
      setKeys((s) => ({ ...s, [cap]: '' }));
      await api.getSettings().then(setSettings);
    } catch (e: any) {
      toast(e?.message || '保存失败', 'danger');
    } finally {
      setSaving((s) => ({ ...s, [cap]: false }));
    }
  }

  async function verify(cap: CapId) {
    setVerifying((s) => ({ ...s, [cap]: true }));
    try {
      const r = await api.verifyCap(cap);
      if (r.ok) {
        setCapState((s) => ({ ...s, [cap]: 'verified' }));
        toast(`${CAP_SLOTS[cap].label} 验证通过（${r.model}）`, 'success');
      } else {
        setCapState((s) => ({ ...s, [cap]: 'saved' }));
        toast(`${CAP_SLOTS[cap].label} 验证失败：${r.error}`, 'danger');
      }
    } catch (e: any) {
      toast(e?.message || '验证失败', 'danger');
    } finally {
      setVerifying((s) => ({ ...s, [cap]: false }));
    }
  }

  async function saveRootDir() {
    const v = rootDirInput.trim();
    if (!v) return toast('请填写导出根目录', 'warning');
    setSavingRoot(true);
    try {
      await api.setRootDir(v);
      await api.getSettings().then(setSettings);
      toast('导出根目录已更新并生效', 'success');
    } catch (e: any) {
      toast(e?.message || '保存失败', 'danger');
    } finally {
      setSavingRoot(false);
    }
  }

  return (
    <div className="settings-wrap">
      <div className="warn-box">
        <Icon name="alert" className="ic" size={18} />
        <div>
          <b>抓取合规提醒</b>：自动抓取需平台登录态，违反抖音 / 小红书 ToS，有封号 / IP 风险。仅限自用、限频、不转卖；未配置时退化为手动贴链接。
        </div>
      </div>

      {/* AI 模型（按能力分层） */}
      <div className="panel">
        <div className="panel-head">
          <h3>
            <Icon name="layers" className="ic" size={18} /> AI 模型（按能力分层）
          </h3>
          <div className="spacer" />
          <span className="set-status ok">
            <Icon name="check" className="ic" size={14} /> 四能力槽位
          </span>
        </div>
        <div className="panel-body">
          <div className="cap-note">
            <Icon name="spark" className="ic" size={16} />
            <div>
              不固化单一厂商：每种能力对应一个「供应商」槽位，可一键切换。API Key 本地加密，所有调用经<b>后端代理（AI 代理层）</b>，前端不持有 Key。
            </div>
          </div>

          {Object.values(CAP_SLOTS).map((def) => {
            const { configured, verified, model } = capMeta(def.id);
            const status = capState[def.id] ?? (verified ? 'verified' : configured ? 'saved' : null);
            const keyLocked = configured && !editingCap[def.id];
            return (
              <div className="set-row cap-row" key={def.id}>
                <div className="s-main">
                  <div className="s-t">
                    {def.label}
                    {def.locked && <span className="lock-tag">固定</span>}
                  </div>
                  <div className="s-d">{def.id === 'image' ? `AIHubMix · ${model} · OpenAI 兼容接口` : def.keyId}</div>
                </div>
                <a className="cap-key-link" href={API_KEY_PORTALS[def.id]} target="_blank" rel="noreferrer">点击获取 API Key</a>
                <div className="cap-ctl">
                  <Select
                    className="cap-select"
                    selectedKeys={new Set([model])}
                    disallowEmptySelection
                    isDisabled={def.locked}
                    size="sm"
                    onSelectionChange={(k) => {
                      const v = [...k][0] as string;
                      api.setSupplier(def.id, v).then(() => api.getSettings().then(setSettings));
                    }}
                  >
                    {[def.defaultModel, ...def.alternatives].map((m) => (
                      <SelectItem key={m}>{m}</SelectItem>
                    ))}
                  </Select>
                  <Input
                    className="cap-input"
                    type={keyLocked ? 'text' : 'password'}
                    isReadOnly={keyLocked}
                    placeholder={def.id === 'image' ? 'sk-...（AIHubMix）' : `sk-...（${def.keyId}）`}
                    value={keyLocked ? '••••••••••••••••' : keys[def.id] ?? ''}
                    onValueChange={(v) => setKeys((s) => ({ ...s, [def.id]: v }))}
                    size="sm"
                  />
                  {keyLocked ? (
                    <Button
                      className="cap-btn topic-outline-button"
                      variant="bordered"
                      size="sm"
                      onPress={() => setEditingCap((s) => ({ ...s, [def.id]: true }))}
                    >
                      <Icon name="pen" className="ic" size={14} /> 修改
                    </Button>
                  ) : (
                    <Button
                      className="cap-btn"
                      color="primary"
                      size="sm"
                      isLoading={saving[def.id]}
                      onPress={() => saveKey(def.id)}
                    >
                      <Icon name="check" className="ic" size={14} /> 保存
                    </Button>
                  )}
                  <Button
                    className="cap-btn topic-outline-button"
                    size="sm"
                    variant="bordered"
                    isLoading={verifying[def.id]}
                    onPress={() => verify(def.id)}
                  >
                    验证
                  </Button>
                  <span className={`cap-status set-status ${status ? 'ok' : 'no'}`}>
                    <Icon name={status ? 'check' : 'alert'} className="ic" size={14} />
                    {status === 'verified' ? '已验证' : status === 'saved' ? '已保存' : '未配置'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 首次运行环境 */}
      <div className="panel">
        <div className="panel-head">
          <h3><Icon name="layers" className="ic" size={18} /> 本机运行环境</h3>
          <div className="spacer" />
          <span className={`set-status ${runtime?.ready ? 'ok' : 'no'}`}>
            <Icon name={runtime?.ready ? 'check' : 'alert'} className="ic" size={14} /> {runtime?.ready ? '已就绪' : runtime?.installing ? '安装中' : '待安装'}
          </span>
        </div>
        <div className="panel-body">
          <div className="set-row" style={{ border: 'none' }}>
            <div className="s-main">
              <div className="s-t">抓取与下载组件</div>
              <div className="s-d">首次使用时会安装 Python 与抓取工具；优先复用电脑已安装的 Chrome / Edge，未检测到时才下载浏览器运行时。安装包不会携带任何登录态。</div>
              <div className="onboarding-components">{(runtime?.components || []).map((item) => <span className={`onboarding-chip ${item.ready ? 'ready' : ''}`} key={item.id}>{item.ready ? '✓' : '•'} {item.label} · {item.detail}</span>)}</div>
            </div>
            {!runtime?.ready && runtime?.packaged && <Button size="sm" color="primary" isLoading={runtimeInstalling || !!runtime?.installing} onPress={installRuntime}>安装环境</Button>}
          </div>
          <div className="tiny" style={{ color: 'var(--text-3)' }}>{runtime?.message || '正在检测本机环境…'}</div>
        </div>
      </div>

      {/* AI 代理层 */}
      <div className="panel">
        <div className="panel-head">
          <h3>
            <Icon name="settings" className="ic" size={18} /> AI 代理层
          </h3>
          <div className="spacer" />
          <span className="set-status ok">
            <Icon name="check" className="ic" size={14} /> 已启用
          </span>
        </div>
        <div className="panel-body">
          <div className="set-row" style={{ border: 'none' }}>
            <div className="s-main">
              <div className="s-t">安全调用</div>
              <div className="s-d">
                所有模型请求均通过本地工作台安全转发，Key 仅保存在本机加密存储中，不会展示在页面上。
              </div>
            </div>
            <span className="set-status ok" aria-label="安全调用已启用">
              <Icon name="check" className="ic" size={14} /> 已启用
            </span>
          </div>
        </div>
      </div>

      {/* 网页 ChatGPT MCP 备用入口 */}
      <div className="panel">
        <div className="panel-head">
          <h3><Icon name="spark" className="ic" size={18} /> 网页 ChatGPT 连接（MCP）</h3>
          <div className="spacer" />
          <span className={`set-status ${mcpOnline ? 'ok' : mcpOnline === false ? 'no' : ''}`}>
            <Icon name={mcpOnline ? 'check' : 'alert'} className="ic" size={14} />
            {mcpOnline ? '本机服务已就绪' : mcpOnline === false ? '本机服务未连接' : '检测中'}
          </span>
        </div>
        <div className="panel-body">
          <div className="set-row" style={{ border: 'none' }}>
            <div className="s-main">
              <div className="s-t">MCP 本机地址</div>
              <div className="s-d">这是工作台提供给网页 ChatGPT 的备用工作流入口。网页端不能直接访问 localhost，需要通过受信任的 HTTPS 隧道转发后再添加连接器。</div>
              <div className="s-d" style={{ fontFamily: 'var(--mono)', marginTop: 8, wordBreak: 'break-all' }}>
                {mcpEndpoint || '正在读取本机地址…'}
              </div>
            </div>
            <Button size="sm" variant="bordered" className="topic-outline-button" isDisabled={!mcpEndpoint} onPress={() => void copyMcpEndpoint()}>
              复制地址
            </Button>
          </div>
          <div className="tiny" style={{ color: 'var(--text-3)' }}>
            当前最小闭环：网页 ChatGPT 负责校对与改写，工作台负责链接解析、状态门和 Word 导出；不会把 Cookie、API Key 或本机文件路径发送到网页端。
          </div>
        </div>
      </div>

      {/* 素材库 */}
      <div className="panel">
        <div className="panel-head">
          <h3>
            <Icon name="archive" className="ic" size={18} /> 素材库（本地文件夹）
          </h3>
          <div className="spacer" />
          <span className="set-status ok">
            <Icon name="check" className="ic" size={14} /> 本地文件夹
          </span>
        </div>
        <div className="panel-body">
          <div className="set-row">
            <div className="s-main">
              <div className="s-t">导出根目录</div>
              <div className="s-d">
                所有导出的 Excel、Word 和图片都会直接保存到此目录下的“选题 / 创意 / 洗稿 / 图片”文件夹中；可放在 iCloud 或 OneDrive 自动同步。
              </div>
            </div>
          </div>
          <div className="set-row">
            <div className="s-main" style={{ flex: 1 }}>
              <Input
                value={rootDirInput}
                onValueChange={setRootDirInput}
                placeholder="~/Documents/AI新媒体工作台"
                size="sm"
                className="rootdir-input"
              />
            </div>
            <Button size="sm" color="primary" isLoading={savingRoot} onPress={saveRootDir}>
              <Icon name="check" className="ic" size={14} /> 保存目录
            </Button>
            <Button size="sm" variant="light" onPress={() => setView('sucai')}>
              <Icon name="archive" className="ic" size={14} /> 打开素材库
            </Button>
          </div>
          <div className="set-row" style={{ border: 'none' }}>
            <div className="s-main">
              <div className="s-t" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                {settings?.rootDir || '~/Documents/AI新媒体工作台'}
              </div>
              <div className="s-d">选题 / 创意 / 洗稿 / 图片。文件实际保存在本机，可在电脑文件夹中管理。</div>
            </div>
          </div>
        </div>
      </div>

      {/* 抓取账号 */}
      <div className="panel">
        <div className="panel-head">
          <h3>
            <Icon name="flame" className="ic" size={18} /> 抓取账号（登录态）
          </h3>
          <div className="spacer" />
          <span className={`set-status ${Object.values(scrapeStatus.platforms).some(Boolean) ? 'ok' : 'no'}`}>
            <Icon name={Object.values(scrapeStatus.platforms).some(Boolean) ? 'check' : 'alert'} className="ic" size={14} />
            {scrapeStatus.electron ? (Object.values(scrapeStatus.platforms).some(Boolean) ? '部分已登录' : '未登录') : '代理未就绪'}
          </span>
        </div>
        <div className="panel-body">
          <div className="set-row" style={{ border: 'none' }}>
            <div className="s-main">
              <div className="s-t">平台登录状态</div>
              <div className="s-d">
                点击登录后会打开平台授权页面；扫码成功后，工作台会在后续搜索与链接解析中复用登录状态。请仅限自用并注意平台规则与访问频率。
              </div>
            </div>
          </div>
          {(['抖音', '小红书'] as const).map((p) => {
            const connected = !!scrapeStatus.platforms[p];
            return (
              <div className="set-row scrape-row" key={p}>
                <div className="s-main">
                  <div className="s-t">{p}</div>
                  <div className="s-d">{connected ? '已持有登录态 cookie' : '未登录'}</div>
                </div>
                <span className={`set-status ${connected ? 'ok' : 'no'}`}>
                  <Icon name={connected ? 'check' : 'alert'} className="ic" size={14} />
                  {connected ? '已连接' : '未连接'}
                </span>
                <Button
                  size="sm"
                  variant={connected ? 'light' : 'flat'}
                  color={connected ? 'default' : 'primary'}
                  isLoading={loginLoading === p}
                  onPress={() => scrapeLogin(p)}
                >
                  {!loginLoading && <Icon name="spark" className="ic" size={14} />} {connected ? '重新登录' : '登录'}
                </Button>
              </div>
            );
          })}
          {!scrapeStatus.electron && (
            <div className="tiny" style={{ marginTop: 6, color: 'var(--text-3)' }}>
              <Icon name="alert" className="ic" size={13} /> 抓取服务暂未启动，登录与真实搜索暂不可用。请先完成“本机运行环境”安装，随后重试。
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3><Icon name="refresh" className="ic" size={18} /> 软件更新</h3>
        </div>
        <div className="panel-body">
          <div className="set-row" style={{ border: 'none' }}>
            <div className="s-main">
              <div className="s-t">检查新版本</div>
              <div className="s-d">工作台每次启动会自动检查更新；你也可以随时手动检查。发现新版后可自行选择下载并重启安装。</div>
            </div>
            <Button size="sm" variant="bordered" className="topic-outline-button" isLoading={checkingUpdate} onPress={() => void checkForUpdates()}>
              <Icon name="refresh" className="ic" size={14} /> 检查更新
            </Button>
          </div>
          {updateStatus.phase === 'downloading' && (
            <div className="update-download-progress" role="status" aria-live="polite">
              <div className="update-download-copy">
                <span>{updateStatus.message || '正在下载更新…'}</span>
                <strong>{updateStatus.percent}%</strong>
              </div>
              <div className="update-download-track"><div style={{ width: `${updateStatus.percent}%` }} /></div>
            </div>
          )}
          {updateStatus.phase === 'installing' && <div className="tiny update-status-text">正在安装更新并重启，请稍候…</div>}
          {updateStatus.phase === 'error' && <div className="tiny update-status-error">{updateStatus.message || '更新失败，请稍后重试。'}</div>}
        </div>
      </div>

      <div className="panel about-panel">
        <div className="panel-head">
          <h3><Icon name="info" className="ic" size={18} /> 关于</h3>
        </div>
        <div className="panel-body">
          <div className="about-content">
            <img className="about-icon" src={appIcon} alt="AI新媒体工作台图标" />
            <div className="about-copy">
              <div className="about-name">AI新媒体工作台</div>
              <div className="about-meta">版本：{appVersion || '读取中…'}</div>
              <div className="about-meta">开发者：jiangjiawei</div>
              <p>面向日常新媒体内容创作的本地工作台，覆盖选题、创意、洗稿、提示词、出图与本地素材归档。</p>
              <div className="about-copyright">Copyright © 2026 jiangjiawei. 保留所有权利。</div>
            </div>
          </div>
        </div>
      </div>

      {/* 二维码登录弹窗 */}
      <Modal
        isOpen={qrModal.open}
        onOpenChange={() => {
          setQrModal({ open: false, platform: '', qr: null, headful: true, error: null });
          stopPoll();
          setLoginLoading(null);
        }}
        backdrop="blur"
      >
        <ModalContent>
          {() => (
            <>
              <ModalHeader>
                <Icon name="spark" className="ic" size={18} /> 登录「{qrModal.platform}」
              </ModalHeader>
              <ModalBody style={{ minHeight: 220, textAlign: 'center' }}>
                {qrModal.error ? (
                  <div className="warn-box" style={{ textAlign: 'left' }}>
                    <Icon name="alert" className="ic" size={18} />
                    <div>{qrModal.error}</div>
                  </div>
                ) : null}

                {qrModal.qr ? (
                  <>
                    <img
                      src={qrModal.qr}
                      alt="登录二维码"
                      style={{ width: 180, height: 180, margin: '0 auto', borderRadius: 8, border: '1px solid var(--line)' }}
                    />
                    <div className="tiny" style={{ marginTop: 12, color: 'var(--text-3)' }}>
                      请使用「{qrModal.platform}」App 扫描上方二维码
                    </div>
                  </>
                ) : qrModal.headful && !qrModal.error ? (
                  <div style={{ paddingTop: 40 }}>
                    <Spinner />
                    <div className="tiny" style={{ marginTop: 16, color: 'var(--text-3)' }}>
                      正在打开「{qrModal.platform}」登录窗口…
                      <br />
                      若未显示二维码，请在弹出的浏览器窗口中扫码
                    </div>
                  </div>
                ) : null}

                {!qrModal.qr && !qrModal.headful && !qrModal.error && (
                  <div className="tiny" style={{ color: 'var(--text-3)' }}>
                    当前为无头模式，可能触发平台风控，建议启用有头模式后重试。
                  </div>
                )}
              </ModalBody>
              <ModalFooter>
                <Button
                  size="sm"
                  variant="light"
                  onPress={() => {
                    setQrModal({ open: false, platform: '', qr: null, headful: true, error: null });
                    stopPoll();
                    setLoginLoading(null);
                  }}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  color="primary"
                  isLoading={!!loginLoading}
                  onPress={() => scrapeLogin(qrModal.platform)}
                >
                  刷新二维码
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <div style={{ height: 40 }} />
    </div>
  );
}
