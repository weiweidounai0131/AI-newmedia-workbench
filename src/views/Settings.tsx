import { useEffect, useState, useRef } from 'react';
import { Button, Input, Spinner, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from '@heroui/react';
import { CAP_SLOTS, type CapId } from '../../electron/main/server/services/caps';
import { useApp, setSettings, setView, type CapabilityModelConfigSummary } from '../store/appStore';
import { api, type ProviderDraftRequest, type UpdateStatus } from '../api/client';
import { Icon } from '../icons';
import { useToastMsg } from '../lib/ui';
import appIcon from '../assets/app-icon.png';

const CAPABILITY_TITLES: Record<CapId, string> = {
  text: '文字改写',
  visionImg: '图片识别',
  visionVideo: '视频识别',
  image: '图片生成',
};

export default function Settings() {
  const settings = useApp((s) => s.settings);
  const toast = useToastMsg();
  const [verifying, setVerifying] = useState<Record<string, boolean>>({});
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [configModalCap, setConfigModalCap] = useState<CapId | null>(null);
  const [configEditorOpen, setConfigEditorOpen] = useState(false);
  const [providerDraft, setProviderDraft] = useState<ProviderDraftRequest>({ label: '', baseURL: '', protocol: 'openai-chat-completions', apiKey: '', models: [] });
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [manualModelId, setManualModelId] = useState('');
  const [modelFetchState, setModelFetchState] = useState<{ busy: boolean; message: string; error: boolean }>({ busy: false, message: '', error: false });
  const [providerSaving, setProviderSaving] = useState(false);
  const providerFetchEpoch = useRef(0);
  const providerFetchController = useRef<AbortController | null>(null);

  useEffect(() => () => {
    providerFetchEpoch.current += 1;
    providerFetchController.current?.abort();
    providerFetchController.current = null;
  }, []);
  // M3：导出根目录可编辑并真实写入（POST /api/settings/rootdir）
  const [rootDirInput, setRootDirInput] = useState<string>('');
  const [savingRoot, setSavingRoot] = useState(false);
  // 小红书图文下载与洗稿解析使用同一个可固定目录，避免下载服务与工作台各找各的路径。
  const [xhsDownloadDirInput, setXhsDownloadDirInput] = useState<string>('');
  const [savingXhsDownloadDir, setSavingXhsDownloadDir] = useState(false);
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (settings?.rootDir) setRootDirInput(settings.rootDir);
  }, [settings?.rootDir]);

  useEffect(() => {
    setXhsDownloadDirInput(settings?.xhsDownloadDir || '');
  }, [settings?.xhsDownloadDir]);

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

  function invalidateModelDiscovery() {
    providerFetchEpoch.current += 1;
    providerFetchController.current?.abort();
    providerFetchController.current = null;
    setModelFetchState({ busy: false, message: '', error: false });
  }

  function updateProviderRequestConfig(patch: Partial<Pick<ProviderDraftRequest, 'baseURL' | 'protocol' | 'apiKey'>>) {
    invalidateModelDiscovery();
    setProviderDraft((draft) => ({ ...draft, ...patch }));
  }

  function openCapabilitySettings(cap: CapId) {
    invalidateModelDiscovery();
    setConfigModalCap(cap);
    setConfigEditorOpen(false);
    setConfigModalOpen(true);
  }

  function closeCapabilitySettings() {
    invalidateModelDiscovery();
    setConfigModalOpen(false);
    setConfigEditorOpen(false);
    setConfigModalCap(null);
  }

  function startNewCapabilityConfig(cap: CapId) {
    invalidateModelDiscovery();
    setProviderDraft({ mode: 'create', cap, label: '', baseURL: '', protocol: 'openai-chat-completions', apiKey: '', models: [] });
    setAvailableModelIds([]);
    setManualModelId('');
    setConfigEditorOpen(true);
  }

  function startConfigFromTemplate(cap: CapId, providerId: string, modelId: string) {
    const provider = settings?.providers.find((item) => item.id === providerId);
    if (!provider) return;
    invalidateModelDiscovery();
    setProviderDraft({
      mode: 'create',
      cap,
      sourceProviderId: provider.id,
      label: provider.label,
      baseURL: provider.baseURL,
      protocol: provider.protocol,
      apiKey: '',
      models: [{ id: modelId, capabilities: [cap] }],
    });
    setAvailableModelIds(provider.models.filter((model) => model.capabilities.includes(cap)).map((model) => model.id));
    setManualModelId('');
    setConfigEditorOpen(true);
  }

  function startEditCapabilityConfig(cap: CapId, config: CapabilityModelConfigSummary) {
    const provider = settings?.providers.find((item) => item.id === config.providerId);
    if (!provider) return;
    invalidateModelDiscovery();
    setProviderDraft({
      mode: 'edit',
      ...(provider.scopeCap === cap && !provider.builtin ? { id: provider.id } : {}),
      cap,
      sourceProviderId: provider.id,
      sourceModel: config.model,
      label: provider.label,
      baseURL: provider.baseURL,
      protocol: provider.protocol,
      apiKey: '',
      models: [{ id: config.model, capabilities: [cap] }],
    });
    setAvailableModelIds([config.model]);
    setManualModelId('');
    setConfigEditorOpen(true);
  }

  function selectedDraftModel(): string {
    return providerDraft.models[0]?.id ?? '';
  }

  function selectDraftModel(modelId: string) {
    const cap = providerDraft.cap;
    if (!cap) return;
    setProviderDraft((draft) => ({ ...draft, models: modelId ? [{ id: modelId, capabilities: [cap] }] : [] }));
  }

  function addManualModel() {
    const id = manualModelId.trim();
    if (!id) return;
    setAvailableModelIds((models) => models.includes(id) ? models : [...models, id]);
    selectDraftModel(id);
    setManualModelId('');
  }

  async function discoverModels() {
    providerFetchController.current?.abort();
    const requestEpoch = ++providerFetchEpoch.current;
    const controller = new AbortController();
    providerFetchController.current = controller;
    const requestedDraftId = providerDraft.id;
    const requestedSourceProviderId = providerDraft.sourceProviderId;
    const requestedConfig = {
      cap: providerDraft.cap,
      id: requestedDraftId || requestedSourceProviderId,
      baseURL: providerDraft.baseURL,
      protocol: providerDraft.protocol,
      apiKey: providerDraft.apiKey,
    };
    const isCurrent = () => providerFetchEpoch.current === requestEpoch
      && providerFetchController.current === controller
      && configModalOpen
      && configEditorOpen
      && providerDraft.cap === requestedConfig.cap
      && providerDraft.id === requestedDraftId
      && providerDraft.sourceProviderId === requestedSourceProviderId
      && (providerDraft.id || providerDraft.sourceProviderId) === requestedConfig.id
      && providerDraft.baseURL === requestedConfig.baseURL
      && providerDraft.protocol === requestedConfig.protocol
      && providerDraft.apiKey === requestedConfig.apiKey;
    setModelFetchState({ busy: true, message: '', error: false });
    try {
      const result = await api.fetchProviderModels(requestedConfig, controller.signal);
      if (!isCurrent()) return;
      setAvailableModelIds((models) => [...new Set([...models, ...result.models])]);
      if (!selectedDraftModel() && result.models[0]) selectDraftModel(result.models[0]);
      setModelFetchState({ busy: false, message: `找到 ${result.models.length} 个模型，请选择本配置要使用的模型。`, error: false });
    } catch (error: any) {
      if (!isCurrent()) return;
      setModelFetchState({ busy: false, message: error?.message || '获取模型失败；可手工添加模型 ID。', error: true });
    } finally {
      if (providerFetchEpoch.current === requestEpoch && providerFetchController.current === controller) {
        providerFetchController.current = null;
        setModelFetchState((current) => current.busy ? { ...current, busy: false } : current);
      }
    }
  }

  function protocolAllowed(protocol: ProviderDraftRequest['protocol'], cap: CapId) {
    return !((cap === 'image' || cap === 'visionVideo') && protocol !== 'openai-chat-completions');
  }

  async function saveProvider() {
    const cap = providerDraft.cap;
    const model = selectedDraftModel();
    if (!cap || !model) return toast('请先选择本配置使用的模型', 'warning');
    invalidateModelDiscovery();
    setProviderSaving(true);
    try {
      const result = await api.saveProvider({ ...providerDraft, models: [{ id: model, capabilities: [cap] }] });
      setSettings(result.settings);
      invalidateModelDiscovery();
      setConfigEditorOpen(false);
      setProviderDraft({ label: '', baseURL: '', protocol: 'openai-chat-completions', apiKey: '', models: [] });
      toast('模型配置已保存；是否启用由列表中的当前配置选择', 'success');
    } catch (error: any) {
      toast(error?.message || '提供商配置未能保存', 'danger');
    } finally {
      setProviderSaving(false);
    }
  }

  async function deleteCapabilityConfig(cap: CapId, config: CapabilityModelConfigSummary) {
    const message = config.builtin
      ? `从「${CAPABILITY_TITLES[cap]}」配置列表移除「${config.providerLabel} · ${config.model}」？其他类型不会改变。`
      : `从「${CAPABILITY_TITLES[cap]}」配置列表移除「${config.providerLabel} · ${config.model}」？若它没有被其他类型使用，专属加密 Key 也会一并清除。`;
    if (!window.confirm(message)) return;
    try {
      const result = await api.deleteCapabilityConfig(cap, config.providerId, config.model);
      setSettings(result.settings);
      toast('已从当前类型移除该配置', 'success');
    } catch (error: any) {
      toast(error?.message || '删除失败', 'danger');
    }
  }

  async function assignCapability(cap: CapId, providerId: string, modelId: string) {
    try {
      await api.setCapability(cap, providerId, modelId);
      await api.getSettings().then(setSettings);
    } catch (error: any) {
      toast(error?.message || '能力分配失败', 'danger');
    }
  }

  async function verify(cap: CapId) {
    setVerifying((s) => ({ ...s, [cap]: true }));
    try {
      const r = await api.verifyCap(cap);
      if (r.ok) {
        toast(`${CAP_SLOTS[cap].label} 验证通过（${r.model}）`, 'success');
      } else {
        toast(`${CAP_SLOTS[cap].label} 验证失败：${r.error}`, 'danger');
      }
      await api.getSettings().then(setSettings);
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

  async function chooseXhsDownloadDir() {
    const chosen = await api.chooseXhsDownloadDir();
    if (chosen) setXhsDownloadDirInput(chosen);
  }

  async function saveXhsDownloadDir() {
    const value = xhsDownloadDirInput.trim();
    setSavingXhsDownloadDir(true);
    try {
      const result = await api.setXhsDownloadDir(value);
      await api.getSettings().then(setSettings);
      toast(value ? `小红书洗稿解析目录已固定：${result.xhsDownloadDir}` : '已恢复使用下载服务默认目录', 'success');
    } catch (e: any) {
      toast(e?.message || '保存小红书解析目录失败', 'danger');
    } finally {
      setSavingXhsDownloadDir(false);
    }
  }

  const currentConfigCap = configModalCap
    ? settings?.caps.find((item) => item.cap === configModalCap)
    : undefined;
  const currentConfigOptions = currentConfigCap?.configurations ?? [];
  const editingConfig = !!providerDraft.sourceModel;
  const sourceProvider = providerDraft.sourceProviderId
    ? settings?.providers.find((item) => item.id === providerDraft.sourceProviderId)
    : undefined;
  const selectedModel = selectedDraftModel();

  function configStatus(config: CapabilityModelConfigSummary): string {
    if (config.active && config.verified) return '已验证';
    if (!config.configured) return '未配置';
    return config.active ? '已保存，未验证' : '已保存';
  }

  return (
    <div className="settings-wrap">
      <div className="warn-box">
        <Icon name="alert" className="ic" size={18} />
        <div>
          <b>抓取合规提醒</b>：自动抓取需平台登录态，违反抖音 / 小红书 ToS，有封号 / IP 风险。仅限自用、限频、不转卖；未配置时退化为手动贴链接。
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3><Icon name="layers" className="ic" size={18} /> AI模型设置</h3>
        </div>
        <div className="panel-body">
          <div className="cap-note">
            <Icon name="spark" className="ic" size={16} />
            <div>为每种工作选择要使用的模型。未配置密钥或未验证的配置也可以保存，状态会单独显示。</div>
          </div>
          <div className="ai-model-settings-grid">
            {(Object.keys(CAPABILITY_TITLES) as CapId[]).map((cap) => {
              const summary = settings?.caps.find((item) => item.cap === cap);
              const current = summary?.configurations.find((item) => item.active);
              const status = summary?.verified ? '已验证' : summary?.configured ? '已保存，未验证' : '未配置';
              return (
                <article className="ai-model-card" key={cap} data-testid={`ai-model-card-${cap}`}>
                  <div className="ai-model-card-title">{CAPABILITY_TITLES[cap]}</div>
                  <div className="ai-model-card-current">{current ? `${current.providerLabel} · ${current.model}` : `${summary?.providerLabel ?? '未配置'} · ${summary?.model ?? '未选择模型'}`}</div>
                  <span className={`ai-model-status ${status === '未配置' ? 'empty' : status === '已验证' ? 'verified' : 'saved'}`}>{status}</span>
                  <Button className="ai-model-edit-button" size="sm" variant="bordered" onPress={() => openCapabilitySettings(cap)}>修改模型</Button>
                </article>
              );
            })}
          </div>
        </div>
      </div>

      <Modal isOpen={configModalOpen} onOpenChange={(open) => { if (!open) closeCapabilitySettings(); }} size="3xl" scrollBehavior="inside">
        <ModalContent className="capability-config-modal">
          {(onClose) => (
            <>
              <ModalHeader className="capability-config-modal-head">
                <div>{configModalCap ? CAPABILITY_TITLES[configModalCap] : '模型设置'}配置</div>
                {configEditorOpen && <Button size="sm" variant="light" onPress={() => { invalidateModelDiscovery(); setConfigEditorOpen(false); }}>返回配置列表</Button>}
              </ModalHeader>
              <ModalBody className="capability-config-modal-body">
                {configModalCap && !configEditorOpen && (
                  <div className="capability-config-list" data-testid={`capability-config-list-${configModalCap}`}>
                    <div className="capability-config-list-head">
                      <div><strong>本类型可用配置</strong><p>选择后立即保存并应用到后续请求。密钥未配置时仍可先保存选择。</p></div>
                      <Button color="primary" size="sm" onPress={() => startNewCapabilityConfig(configModalCap)}>添加配置</Button>
                    </div>
                    {currentConfigOptions.map((config) => (
                      <article className={`capability-config-row ${config.active ? 'active' : ''}`} key={`${config.providerId}:${config.model}`} data-testid={`cap-config-${config.providerId}-${encodeURIComponent(config.model)}`}>
                        <label className="capability-config-radio-row">
                          <input
                            type="radio"
                            name={`active-config-${configModalCap}`}
                            aria-label={`启用 ${config.providerLabel} ${config.model}`}
                            checked={config.active}
                            onChange={() => void assignCapability(configModalCap, config.providerId, config.model)}
                          />
                          <span className="capability-config-name">
                            <strong>{config.providerLabel}</strong>
                            <span>{config.modelLabel}</span>
                          </span>
                        </label>
                        <div className="capability-config-status">
                          <span className={`ai-model-status ${configStatus(config) === '未配置' ? 'empty' : config.verified ? 'verified' : 'saved'}`}>{configStatus(config)}</span>
                          {config.active && <Button size="sm" variant="bordered" isLoading={verifying[configModalCap]} isDisabled={!config.configured} onPress={() => void verify(configModalCap)}>验证</Button>}
                        </div>
                        <div className="capability-config-actions">
                          <Button size="sm" variant="light" onPress={() => startEditCapabilityConfig(configModalCap, config)}>编辑</Button>
                          <Button size="sm" variant="light" color="danger" onPress={() => void deleteCapabilityConfig(configModalCap, config)}>移除</Button>
                        </div>
                      </article>
                    ))}
                    {currentConfigOptions.length === 0 && <div className="provider-empty-models">暂时没有可用配置，请添加一个。</div>}
                  </div>
                )}

                {configModalCap && configEditorOpen && (
                  <div className="capability-config-editor" data-testid="capability-config-editor">
                    <div className="capability-config-editor-title">{editingConfig ? '编辑本类型配置' : '新增本类型配置'}</div>
                    <p className="capability-config-editor-note">保存后配置会出现在本类型列表中；是否启用由你单独选择。</p>
                    <div className="capability-config-form-grid">
                      <label className="provider-field">
                        <span>配置名称</span>
                        <Input aria-label="配置名称" value={providerDraft.label} onValueChange={(value) => setProviderDraft((draft) => ({ ...draft, label: value }))} placeholder="例如：公司网关" />
                      </label>
                      <label className="provider-field">
                        <span>{editingConfig ? '配置来源' : '供应商模板'}</span>
                        {editingConfig ? (
                          <div className="provider-template-readonly">{sourceProvider?.label ?? providerDraft.label} · {selectedModel}</div>
                        ) : (
                          <select
                            className="cap-sel provider-template-select"
                            aria-label="供应商模板"
                            value={providerDraft.sourceProviderId ? String(currentConfigOptions.findIndex((item) => item.providerId === providerDraft.sourceProviderId && item.model === selectedModel) + 1) : 'custom'}
                            onChange={(event) => {
                              if (event.target.value === 'custom') startNewCapabilityConfig(configModalCap);
                              else {
                                const item = currentConfigOptions[Number(event.target.value) - 1];
                                if (item) startConfigFromTemplate(configModalCap, item.providerId, item.model);
                              }
                            }}
                          >
                            <option value="custom">自定义第三方</option>
                            {currentConfigOptions.map((item, index) => <option value={String(index + 1)} key={`${item.providerId}:${item.model}`}>{item.providerLabel} · {item.model}</option>)}
                          </select>
                        )}
                      </label>
                      <label className="provider-field full-width">
                        <span>API 根地址</span>
                        <Input aria-label="API 根地址" value={providerDraft.baseURL} onValueChange={(value) => updateProviderRequestConfig({ baseURL: value })} placeholder="https://api.example.com/v1" />
                        <small>填写服务提供方给出的 API 根地址。</small>
                      </label>
                      <label className="provider-field">
                        <span>接口协议</span>
                        <select
                          aria-label="接口协议"
                          className="cap-sel"
                          value={providerDraft.protocol}
                          onChange={(event) => {
                            const protocol = event.target.value as ProviderDraftRequest['protocol'];
                            if (!protocolAllowed(protocol, configModalCap)) return;
                            updateProviderRequestConfig({ protocol });
                          }}
                        >
                          <option value="openai-chat-completions">OpenAI Chat Completions</option>
                          {configModalCap !== 'image' && configModalCap !== 'visionVideo' && <>
                            <option value="openai-responses">OpenAI Responses</option>
                            <option value="anthropic-messages">Anthropic Messages</option>
                          </>}
                        </select>
                      </label>
                      <label className="provider-field provider-key-field">
                        <span>API Key</span>
                        <Input aria-label="API Key" type="password" autoComplete="new-password" value={providerDraft.apiKey ?? ''} onValueChange={(value) => updateProviderRequestConfig({ apiKey: value })} placeholder={sourceProvider?.keyConfigured ? '留空保留现有加密密钥' : '可稍后补充'} />
                        <small>密钥只会在本机加密保存，不会显示在配置列表。</small>
                      </label>
                      <div className="provider-field full-width">
                        <span>模型</span>
                        <div className="provider-model-choice-row">
                          <select aria-label="选择模型" className="cap-sel provider-model-select" value={selectedModel} onChange={(event) => selectDraftModel(event.target.value)}>
                            <option value="">请选择模型</option>
                            {availableModelIds.map((id) => <option value={id} key={id}>{id}</option>)}
                          </select>
                          <Button size="sm" variant="bordered" className="topic-outline-button" isLoading={modelFetchState.busy} onPress={() => void discoverModels()}>获取模型</Button>
                        </div>
                        {modelFetchState.message && <small role="status" className={`provider-fetch-status ${modelFetchState.error ? 'error' : 'success'}`}>{modelFetchState.message}</small>}
                        <div className="provider-manual-model">
                          <Input aria-label="手工输入模型 ID" size="sm" value={manualModelId} onValueChange={setManualModelId} placeholder="也可以手工输入模型 ID" onKeyDown={(event) => { if (event.key === 'Enter') addManualModel(); }} />
                          <Button size="sm" variant="bordered" className="topic-outline-button" onPress={addManualModel}>使用此模型</Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </ModalBody>
              {configEditorOpen ? (
                <ModalFooter className="capability-config-modal-footer">
                  <Button variant="light" onPress={() => { invalidateModelDiscovery(); setConfigEditorOpen(false); }}>取消编辑</Button>
                  <Button color="primary" isLoading={providerSaving} onPress={() => void saveProvider()}>保存配置</Button>
                </ModalFooter>
              ) : (
                <ModalFooter><Button variant="light" onPress={() => { closeCapabilitySettings(); onClose(); }}>完成</Button></ModalFooter>
              )}
            </>
          )}
        </ModalContent>
      </Modal>

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
          <div className="set-row xhs-download-dir-row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="s-main" style={{ minWidth: 260 }}>
              <div className="s-t">小红书洗稿解析目录</div>
              <div className="s-d">下载后的图片和文案会保存到这里，洗稿解析也从这里读取。固定后可避免下载服务与工作台目录不一致。</div>
            </div>
            <div style={{ display: 'flex', flex: '1 1 420px', minWidth: 280, gap: 8, alignItems: 'center' }}>
              <Input
                value={xhsDownloadDirInput}
                onValueChange={setXhsDownloadDirInput}
                placeholder="未固定，使用下载服务默认目录"
                size="sm"
                aria-label="小红书洗稿解析目录"
                className="rootdir-input"
              />
              <Button size="sm" variant="bordered" className="topic-outline-button" onPress={() => void chooseXhsDownloadDir()}>选择</Button>
              <Button size="sm" color="primary" isLoading={savingXhsDownloadDir} onPress={() => void saveXhsDownloadDir()}>保存</Button>
            </div>
          </div>
          <div className="tiny" style={{ color: 'var(--text-3)', marginTop: 6 }}>
            当前目录：<span style={{ fontFamily: 'var(--mono)' }}>{settings?.xhsDownloadDir || '下载服务默认目录'}</span>
            {settings?.xhsDownloadDir && <Button size="sm" variant="light" onPress={() => { setXhsDownloadDirInput(''); void saveXhsDownloadDir(); }} style={{ marginLeft: 8, minWidth: 0, height: 24, padding: '0 6px' }}>恢复默认</Button>}
          </div>
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
