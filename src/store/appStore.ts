// 跨视图状态总线：对齐原型 STATE / WORKFLOW / LIB（切换模块不丢输入与生成结果）。
// 用 useSyncExternalStore 实现，零额外依赖。
import { useSyncExternalStore } from 'react';
import { PLAT_COLORS } from '../data/sample';
import type { HotItem, SearchItem } from '../data/sample';
import { api } from '../api/client';

export type CapId = 'text' | 'visionImg' | 'visionVideo' | 'image';
export type ProviderProtocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages';

export interface ProviderModelSummary {
  id: string;
  label?: string;
  capabilities: CapId[];
}

export interface ProviderSummary {
  id: string;
  label: string;
  portal?: string;
  baseURL: string;
  protocol: ProviderProtocol;
  models: ProviderModelSummary[];
  builtin: boolean;
  keyConfigured: boolean;
  configured: boolean;
  revision: number;
  scopeCap?: CapId | null;
}

export interface CapabilityModelConfigSummary {
  providerId: string;
  providerLabel: string;
  model: string;
  modelLabel: string;
  baseURL: string;
  protocol: ProviderProtocol;
  builtin: boolean;
  scopeCap?: CapId | null;
  configured: boolean;
  active: boolean;
  verified: boolean;
}

export interface CapSummary {
  cap: CapId;
  label: string;
  locked: boolean;
  model: string;
  alternatives: string[];
  models?: string[];
  modelLabels?: Record<string, string>;
  provider?: string;
  providerLabel?: string;
  providerPortal?: string | null;
  providerOptions?: {
    id: string;
    label: string;
    portal?: string;
    protocol: ProviderProtocol;
    configured: boolean;
    models: string[];
    modelLabels?: Record<string, string>;
  }[];
  configured: boolean;
  verified?: boolean;
  configurations: CapabilityModelConfigSummary[];
}

export interface SettingsSummary {
  rootDir: string | null;
  xhsDownloadDir: string | null;
  suppliers: Record<string, string>;
  caps: CapSummary[];
  providers: ProviderSummary[];
}

export type LibKind = 'x' | 'w' | 'i';
export interface LibFile {
  folder: '选题' | '创意' | '洗稿' | '图片';
  name: string;
  date: string;
  kind: LibKind;
  localPath?: string;
  size?: number;
  modifiedAt?: number;
  topics?: {
    title: string;
    source: '热榜' | '搜索';
    platform: string;
    heat?: string;
    likes?: string;
    comments?: string;
    link?: string;
  }[];
}

export interface WorkflowStatus {
  xuanti: boolean;
  xigao: boolean;
  tishici: boolean;
  chutu: boolean;
  ruku: boolean;
}

export interface Topic {
  id: string;
  title: string;
  source: '热榜' | '搜索';
  platform: string;
  heat: string;
  likes: string;
  comments: string;
  link: string;
}

export interface SourceFeedback {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  items: string[];
}

export interface XigaoTableRecord {
  id: string;
  title: string;
  link: string;
  content: string;
  date: string;
  source: '热榜' | '搜索' | '—';
  platform: string;
  /** 单篇洗稿导出到本地素材库时的真实 Word 文件名。 */
  fileName?: string;
}

export interface CreativeTableRecord {
  id: string;
  title: string;
  hotTitle: string;
  hotLink: string;
  content: string;
  fileName: string;
  date: string;
}

export interface AppState {
  view: string;
  theme: 'light' | 'dark';
  workflow: WorkflowStatus;
  settings: SettingsSummary | null;
  lib: LibFile[];
  librarySetupRequested: boolean;
  xigaoTable: XigaoTableRecord[];
  creativeTable: CreativeTableRecord[];
  xigao: {
    mode: 'draft' | 'link';
    src: string;
    link: string;
    platform: string; // 链接来源平台（用于带登录态 cookie 抓取；留空表示公开内容）
    out: string;
    importTitle: string;
    stage: string; // idle | recognizing | source | review | done
    recog: string;
    recogMsg: string; // 识别引导/提示（如「需登录态」）
    mediaType: string;
    vlModel: string;
    sourceId: string;
    sourceFeedback: SourceFeedback | null;
    rewriteLoading: boolean;
    parseStatus: 'idle' | 'loading' | 'success' | 'error';
    parseStatusText: string;
    parseTaskId: string;
    parseTaskPlatform: '' | '抖音' | '小红书';
    parseTaskStatus: string;
    parseTaskError: string;
    parseModalOpen: boolean;
    rewriteRequirement: string;
  };
  creative: {
    link: string;
    title: string;
    integration: string;
    directions: string[];
    selected: number | null;
    requirement: string;
    out: string;
    stage: 'idle' | 'directionsLoading' | 'directionsReady' | 'generating' | 'done';
    model: string;
  };
  tishici: {
    type: 'tp' | 'img';
    src: string;
    desc: string;
    constraints: string;
    imageCount: number;
    refImg: string;
    refImgName: string;
    outText: string;
    outImg: string;
    outImgs: string[];
    done: boolean;
    parseMode: string;
    note: string;
    generating: boolean;
  };
  chutu: {
    provider: 'codex' | 'api';
    prompt: string;
    refImg: string;
    refImgName: string;
    size: string;
    quality: string;
    b64: string | null;
    done: boolean;
    // 出图请求跨页面持续执行；避免切回页面后丢失加载态或重复提交。
    generating: boolean;
    lastProvider: 'codex' | 'api' | null;
    /** 页面内持久错误提示；由用户主动关闭或下一次生成时清除。 */
    error: string;
  };
  xuanti: {
    tab: 'hot' | 'search' | 'topics';
    topics: Topic[];
    search: {
      kw: string;
      platform: string;
      items: SearchItem[];
      live: boolean | null;
      message: string | null;
      status: 'idle' | 'searching' | 'done' | 'error';
    };
  };
  hotRanks: {
    items: Record<string, HotItem[]>;
    hourKey: string;
    loading: boolean;
    error: string;
  };
}

const WORKFLOW_STEPS: (keyof WorkflowStatus)[] = ['xuanti', 'xigao', 'tishici', 'chutu', 'ruku'];

function initialWorkflow(): WorkflowStatus {
  try {
    const s = localStorage.getItem('workflow');
    if (s) return { ...{ xuanti: false, xigao: false, tishici: false, chutu: false, ruku: false }, ...JSON.parse(s) };
  } catch {
    /* ignore */
  }
  return { xuanti: false, xigao: false, tishici: false, chutu: false, ruku: false };
}

function initialTopics(): Topic[] {
  try {
    const s = localStorage.getItem('topics');
    const td = localStorage.getItem('topicsDate');
    if (s && td === fmtYMD(new Date())) {
      return (JSON.parse(s) as Partial<Topic>[]).map((item: Partial<Topic>): Topic => {
        const source = item.source === '搜索' || item.platform === '搜索' ? '搜索' : '热榜';
        return {
          id: item.id || `t${Date.now()}`,
          title: item.title || '未命名选题',
          source,
          platform: item.platform || '—',
          heat: source === '热榜' ? item.heat || '—' : '—',
          likes: source === '搜索' ? item.likes || '—' : '—',
          comments: source === '搜索' ? item.comments || '—' : '—',
          link: item.link || '',
        };
      }).sort((a, b) => topicCreatedAt(b.id) - topicCreatedAt(a.id));
    }
  } catch {
    /* ignore */
  }
  return [];
}

/** Topic id 前缀包含创建时的毫秒时间；用于跨刷新保持“最新在前”。 */
function topicCreatedAt(id: string): number {
  const matched = /^t(\d{10,})/.exec(id);
  return matched ? Number(matched[1]) : 0;
}

function fmtYMD(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function fmtHourKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}`;
}

function initialXigaoTable(): XigaoTableRecord[] {
  try {
    const raw = localStorage.getItem('xigaoTable');
    return raw ? (JSON.parse(raw) as Partial<XigaoTableRecord>[]).map((item) => ({
      id: item.id || `x${Date.now()}`,
      title: item.title || '未命名',
      link: item.link || '',
      content: item.content || '',
      date: item.date || fmtYMD(new Date()),
      source: item.source === '热榜' || item.source === '搜索' ? item.source : '—',
      platform: item.platform || platformFromSavedLink(item.link || ''),
    })) : [];
  } catch {
    return [];
  }
}

function initialCreativeTable(): CreativeTableRecord[] {
  try {
    const raw = localStorage.getItem('creativeTable');
    return raw ? (JSON.parse(raw) as Partial<CreativeTableRecord>[]).map((item) => ({
      id: item.id || `c${Date.now()}`,
      title: item.title || '未命名创意',
      hotTitle: item.hotTitle || '未命名热点',
      hotLink: item.hotLink || '',
      content: item.content || '',
      fileName: item.fileName || '创意.docx',
      date: item.date || fmtYMD(new Date()),
    })) : [];
  } catch { return []; }
}

function platformFromSavedLink(link: string): string {
  try {
    const host = new URL(link).hostname.toLowerCase();
    if (host.includes('douyin.com')) return '抖音';
    if (host.includes('xiaohongshu.com') || host.includes('xhslink.com')) return '小红书';
    if (host.includes('weibo.com')) return '微博';
    if (host.includes('zhihu.com')) return '知乎';
  } catch { /* 旧记录无有效链接 */ }
  return '—';
}

const storedTheme = (): 'light' | 'dark' => {
  const t = localStorage.getItem('theme');
  return t === 'dark' ? 'dark' : 'light';
};

function initialCreative(): AppState['creative'] {
  const fallback: AppState['creative'] = { link: '', title: '', integration: '', directions: [], selected: null, requirement: '', out: '', stage: 'idle', model: '' };
  try {
    const raw = localStorage.getItem('creative');
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<AppState['creative']>;
    const stage = saved.stage === 'directionsLoading' || saved.stage === 'generating' ? 'idle' : saved.stage;
    return { ...fallback, ...saved, directions: Array.isArray(saved.directions) ? saved.directions.slice(0, 4) : [], stage: stage || 'idle' };
  } catch { return fallback; }
}

const initialState: AppState = {
  view: 'home',
  theme: storedTheme(),
  workflow: initialWorkflow(),
  settings: null,
  lib: [],
  librarySetupRequested: false,
  xigaoTable: initialXigaoTable(),
  creativeTable: initialCreativeTable(),
  xigao: {
    mode: 'link',
    src: '',
    link: '',
    platform: '',
    out: '',
    importTitle: '',
    stage: 'idle',
    recog: '',
    recogMsg: '',
    mediaType: '',
    vlModel: '',
    sourceId: '',
    sourceFeedback: null,
    rewriteLoading: false,
    parseStatus: 'idle',
    parseStatusText: '请先解析链接，解析成功后才能识别内容',
    parseTaskId: '',
    parseTaskPlatform: '',
    parseTaskStatus: 'idle',
    parseTaskError: '',
    parseModalOpen: false,
    rewriteRequirement: '',
  },
  creative: initialCreative(),
  tishici: {
    type: 'img',
    src: '',
    desc: '',
    constraints: '',
    imageCount: 1,
    refImg: '',
    refImgName: '',
    outText: '',
    outImg: '',
    outImgs: [],
    done: false,
    parseMode: '',
    note: '',
    generating: false,
  },
  chutu: {
    provider: 'api',
    prompt: '',
    refImg: '',
    refImgName: '',
    size: '1024×1536',
    quality: '自动',
    b64: null,
    done: false,
    generating: false,
    lastProvider: null,
    error: '',
  },
  xuanti: {
    tab: 'hot',
    topics: initialTopics(),
    search: {
      kw: '',
      platform: '抖音',
      items: [],
      live: null,
      message: null,
      status: 'idle',
    },
  },
  hotRanks: { items: {}, hourKey: '', loading: false, error: '' },
};

let state: AppState = initialState;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getState(): AppState {
  return state;
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  emit();
}

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

/* ---------------- 业务动作 ---------------- */

export function setView(view: string): void {
  setState({ view });
}

export function toggleTheme(): void {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  setState({ theme: next });
}

export function updateWorkflow(step: keyof WorkflowStatus, value = true): void {
  const workflow = { ...state.workflow, [step]: value };
  try {
    localStorage.setItem('workflow', JSON.stringify(workflow));
  } catch {
    /* ignore */
  }
  setState({ workflow });
}

export function setSettings(s: SettingsSummary | null): void {
  setState({ settings: s });
}

export function setXigao(patch: Partial<AppState['xigao']>): void {
  setState({ xigao: { ...state.xigao, ...patch } });
}

export function setCreative(patch: Partial<AppState['creative']>): void {
  const creative = { ...state.creative, ...patch };
  try { localStorage.setItem('creative', JSON.stringify(creative)); } catch { /* ignore */ }
  setState({ creative });
}

/** 洗稿表记录已归档的单篇洗稿；每条记录对应素材库中的一个 Word。 */
export function addXigaoTableRecord(record: Omit<XigaoTableRecord, 'id' | 'date'>): void {
  const item: XigaoTableRecord = { ...record, id: `x${Date.now()}${Math.floor(Math.random() * 1000)}`, date: fmtYMD(new Date()) };
  const xigaoTable = [item, ...state.xigaoTable];
  try { localStorage.setItem('xigaoTable', JSON.stringify(xigaoTable)); } catch { /* ignore */ }
  setState({ xigaoTable });
  updateWorkflow('xigao', true);
}

export function clearXigaoTable(): void {
  try { localStorage.removeItem('xigaoTable'); } catch { /* ignore */ }
  setState({ xigaoTable: [] });
}

/** 创意表记录已经归档到本地素材库的创意 Word 文件。 */
export function addCreativeTableRecord(record: Omit<CreativeTableRecord, 'id' | 'date'>): void {
  const item: CreativeTableRecord = { ...record, id: `c${Date.now()}${Math.floor(Math.random() * 1000)}`, date: fmtYMD(new Date()) };
  const creativeTable = [item, ...state.creativeTable];
  try { localStorage.setItem('creativeTable', JSON.stringify(creativeTable)); } catch { /* ignore */ }
  setState({ creativeTable });
  updateWorkflow('ruku', true);
}

export function clearCreativeTable(): void {
  try { localStorage.removeItem('creativeTable'); } catch { /* ignore */ }
  setState({ creativeTable: [] });
}

export function setTishici(patch: Partial<AppState['tishici']>): void {
  setState({ tishici: { ...state.tishici, ...patch } });
}

export function setChutu(patch: Partial<AppState['chutu']>): void {
  setState({ chutu: { ...state.chutu, ...patch } });
}

export function setXuanti(patch: Partial<AppState['xuanti']>): void {
  setState({ xuanti: { ...state.xuanti, ...patch } });
}

/** 同一自然小时内只向热榜上游取一次；切页时直接复用当前任务/结果。 */
export async function loadHotRanks(force = false): Promise<void> {
  const hourKey = fmtHourKey();
  if (state.hotRanks.loading) return;
  if (!force && state.hotRanks.hourKey === hourKey) return;
  setState({ hotRanks: { ...state.hotRanks, loading: true, error: '' } });
  try {
    const r = await api.getHot();
    const items = r.items || {};
    setState({
      hotRanks: {
        items,
        hourKey,
        loading: false,
        error: Object.keys(items).length ? '' : (r.message || '暂未获取到热点数据。'),
      },
    });
  } catch (error: any) {
    setState({ hotRanks: { ...state.hotRanks, hourKey, loading: false, error: error?.message || '热点加载失败，请确认本地服务已启动后重试。' } });
  }
}

/* 选题表 */
export function addTopic(t: Omit<Topic, 'id'>): void {
  const topic: Topic = { ...t, id: 't' + Date.now() + Math.floor(Math.random() * 1000) };
  const topics = [topic, ...state.xuanti.topics];
  setXuanti({ topics });
  try {
    localStorage.setItem('topics', JSON.stringify(topics));
    localStorage.setItem('topicsDate', fmtYMD(new Date()));
  } catch {
    /* ignore */
  }
  updateWorkflow('xuanti', true);
}

export function clearTopics(): void {
  setXuanti({ topics: [] });
  try {
    localStorage.removeItem('topics');
  } catch {
    /* ignore */
  }
}

/* 素材库：真实落盘（M3 方案 C，后端 /api/library 直写实体文件 + 索引）。
   后端不可用时降级为内存索引，保证 UI 仍可用。 */
export async function exportImageToLib(name: string, data: string): Promise<void> {
  const fn = name.trim().replace(/\.png$/i, '') + '.png';
  try {
    const r = await api.exportLib({ folder: '图片', name: fn, kind: 'i', data });
    if (r.error) throw new Error(r.error);
    setLib(r.files);
  } catch (error) {
    requestLibrarySetup();
    throw error;
  }
  updateWorkflow('ruku', true);
}

export async function exportTextToLib(
  folder: '选题' | '创意' | '洗稿',
  name: string,
  content: string,
  topics?: LibFile['topics'],
): Promise<void> {
  const kind = folder === '选题' ? 'x' : 'w';
  try {
    const r = await api.exportLib({ folder, name, kind, content, topics });
    if (r.error) throw new Error(r.error);
    setLib(r.files);
  } catch (error) {
    requestLibrarySetup();
    throw error;
  }
  updateWorkflow('ruku', true);
}

export function setLib(files: LibFile[]): void {
  setState({ lib: files });
}

/** 导出时若目录尚未设置，跳到素材库并打开目录设置弹窗。 */
export function requestLibrarySetup(): void {
  setState({ view: 'sucai', librarySetupRequested: true });
}

export function clearLibrarySetupRequest(): void {
  setState({ librarySetupRequested: false });
}

export async function loadLibrary(): Promise<void> {
  try {
    const r = await api.listLibrary();
    setLib(r.files);
  } catch {
    /* 后端不可用则保留当前（可能为空） */
  }
}

export { PLAT_COLORS, WORKFLOW_STEPS, fmtYMD };
