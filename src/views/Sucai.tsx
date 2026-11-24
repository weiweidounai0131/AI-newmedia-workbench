import { useEffect, useState } from 'react';
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { useApp, clearLibrarySetupRequest, setLib, setSettings, setSucaiTab, type LibFile, type SucaiTab } from '../store/appStore';
import { api } from '../api/client';
import { Icon } from '../icons';
import { ActivePill, MOTION_SPRING, PageTransition, StaggerItem, m } from '../motion';
import { useToastMsg } from '../lib/ui';

const FOLDERS: ('选题' | '创意' | '洗稿' | '图片')[] = ['选题', '创意', '洗稿', '图片'];
const FOLDER_META: Record<'选题' | '创意' | '洗稿' | '图片', { icon: string; desc: string; color: string }> = {
  选题: { icon: 'target', desc: '热榜与搜索选题表 (.xlsx)', color: '#159a58' },
  创意: { icon: 'spark', desc: '借势创意文案 (.docx)', color: '#7c3aed' },
  洗稿: { icon: 'pen', desc: '识别与改写稿件 (.docx)', color: '#2563eb' },
  图片: { icon: 'image', desc: 'AI 成品海报与配图', color: '#ea580c' },
};

type LibraryStatus = { rootDir: string | null; missingFolders: ('选题' | '创意' | '洗稿' | '图片')[]; ready: boolean; files: LibFile[] };

function sizeText(bytes?: number) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function modifiedText(time?: number) {
  if (!time) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time));
}

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export default function Sucai() {
  const lib = useApp((s) => s.lib);
  const tab = useApp((s) => s.sucaiTab);
  const setupRequested = useApp((s) => s.librarySetupRequested);
  const toast = useToastMsg();
  const [preview, setPreview] = useState<LibFile | null>(null);
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [rootInput, setRootInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [thumbMap, setThumbMap] = useState<Record<string, string>>({});

  const files = tab === 'overview' ? lib : lib.filter((file) => file.folder === tab);
  const ready = Boolean(status?.ready);
  const today = todayYmd();

  const totalSize = lib.reduce((sum, f) => sum + (f.size || 0), 0);
  const todayTotal = lib.filter((f) => f.date === today).length;
  const recentFiles = [...lib].sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0)).slice(0, 6);

  async function refresh(showToast = false) {
    try {
      const next = await api.listLibrary();
      setStatus(next);
      setLib(next.files);
      if (!next.rootDir || !next.ready) setSetupOpen(true);
      if (showToast) toast('已按本地目录刷新素材库', 'success');
    } catch (error: any) {
      toast(error?.message || '素材库读取失败，请确认本地目录可访问', 'danger');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (tab !== '图片' && !preview) return;
    let active = true;
    const imgFiles = preview ? [preview] : lib.filter((f) => f.folder === '图片');
    imgFiles.forEach((file) => {
      if (file.folder !== '图片') return;
      const key = file.localPath || `${file.folder}/${file.name}`;
      if (thumbMap[key]) return;
      void api
        .readLibraryImageDataUrl(file.folder, file.name)
        .then((url) => {
          if (active) setThumbMap((prev) => ({ ...prev, [key]: url }));
        })
        .catch(() => {});
    });
    return () => {
      active = false;
    };
  }, [tab, lib, preview]);

  useEffect(() => {
    if (setupRequested) {
      setSetupOpen(true);
      clearLibrarySetupRequest();
    }
  }, [setupRequested]);

  async function chooseRoot() {
    const chosen = await api.chooseLibraryRoot();
    if (chosen) setRootInput(chosen);
  }

  async function saveRoot() {
    const rootDir = rootInput.trim();
    if (!rootDir) return toast('请先选择或填写本地目录', 'warning');
    setSaving(true);
    try {
      const next = await api.setLibraryRoot(rootDir);
      setStatus(next);
      setLib(next.files);
      await api.getSettings().then(setSettings);
      toast('本地素材库目录已保存，请确认创建分类文件夹', 'success');
    } catch (error: any) {
      toast(error?.message || '保存目录失败', 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function initializeFolders() {
    setSaving(true);
    try {
      const next = await api.initializeLibrary();
      setStatus(next);
      setLib(next.files);
      setSetupOpen(false);
      toast('已创建选题、创意、洗稿、图片四个本地文件夹', 'success');
    } catch (error: any) {
      toast(error?.message || '创建文件夹失败', 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function openFile(file: LibFile, reveal = false) {
    try { await api.openLibraryFile(file.folder, file.name, reveal); }
    catch (error: any) { toast(error?.message || '无法打开本地文件', 'danger'); }
  }

  function imageUrl(file: LibFile): string {
    const key = file.localPath || `${file.folder}/${file.name}`;
    return thumbMap[key] || '';
  }

  function openRecentItem(file: LibFile) {
    if (file.folder === '图片') {
      setPreview(file);
    } else {
      void openFile(file);
    }
  }

  const allTabs: { id: SucaiTab; label: string; icon: string; count?: number }[] = [
    { id: 'overview', label: '统计概览', icon: 'layers' },
    ...FOLDERS.map((f) => ({
      id: f as SucaiTab,
      label: f,
      icon: 'folder',
      count: lib.filter((file) => file.folder === f).length,
    })),
  ];

  return (
    <div className="panel sucai-panel">
      <div className="panel-head">
        <h3><Icon name="archive" className="ic" size={18} /> 素材库</h3>
        <div className="spacer" />
        <span className="tiny">本地文件夹同步</span>
      </div>
      <div className="panel-body">
        <div className="sucai-path">
          <button
            type="button"
            className="sp"
            style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', font: 'inherit' }}
            onClick={() => setSucaiTab('overview')}
          >
            本地素材库
          </button>
          <span className="sep">/</span>
          <b>{tab === 'overview' ? '统计概览' : tab}</b>
          <span className="sucai-total">共 {lib.length} 个文件</span>
          <div className="spacer" />
          <Button size="sm" variant="bordered" className="topic-outline-button" onPress={() => void refresh(true)}>
            <Icon name="refresh" className="ic" size={14} /> 刷新
          </Button>
          <Button size="sm" variant="bordered" className="topic-outline-button" onPress={() => setSetupOpen(true)}>
            <Icon name="folder" className="ic" size={14} /> 设置目录
          </Button>
        </div>

        {!ready ? (
          <div className="sucai-empty" style={{ minHeight: 280 }}>
            <Icon name="folder" className="ic" size={34} />
            <div style={{ fontWeight: 600, color: 'var(--text)' }}>
              {status?.rootDir ? '尚未在所选目录创建分类文件夹' : '尚未设置本地素材库目录'}
            </div>
            <div className="tiny">
              {status?.rootDir ? `目录：${status.rootDir}（缺少：${status.missingFolders.join('、')}）` : '选择本地目录后，工作台会自动在其中创建选题、创意、洗稿、图片四个文件夹。'}
            </div>
            <Button size="sm" color="primary" onPress={() => setSetupOpen(true)}>
              {status?.rootDir ? '创建分类文件夹' : '选择本地目录'}
            </Button>
          </div>
        ) : (
          <>
            <div className="tiny" style={{ marginBottom: 12, color: 'var(--text-3)' }}>目录：{status?.rootDir}</div>
            <div className="xuanti-tabs" role="tablist" style={{ marginBottom: 16 }}>
              {allTabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`xuanti-tab ${tab === item.id ? 'active' : ''}`}
                  onClick={() => setSucaiTab(item.id)}
                >
                  {tab === item.id && <ActivePill layoutId="sucai-tab-pill" className="xuanti-tab-pill" />}
                  <Icon name={item.icon} className="ic" size={16} />
                  <span>{item.label}</span>
                  {typeof item.count === 'number' && <span className="count">{item.count}</span>}
                </button>
              ))}
            </div>

            <PageTransition viewKey={tab} className="sucai-body">
              {tab === 'overview' ? (
                <div className="sucai-overview">
                  <div className="sucai-kpi-grid">
                    <div className="sucai-kpi-card">
                      <span className="sucai-kpi-label">素材总计</span>
                      <strong className="sucai-kpi-val">{lib.length}</strong>
                      <span className="tiny">4 个分类目录同步</span>
                    </div>
                    <div className="sucai-kpi-card">
                      <span className="sucai-kpi-label">今日更新</span>
                      <strong className={`sucai-kpi-val ${todayTotal > 0 ? 'accent' : ''}`}>
                        {todayTotal > 0 ? `+${todayTotal}` : '0'}
                      </strong>
                      <span className="tiny">{todayTotal > 0 ? '今日已有新素材归档' : '今日暂无新增文件'}</span>
                    </div>
                    <div className="sucai-kpi-card">
                      <span className="sucai-kpi-label">本地占用空间</span>
                      <strong className="sucai-kpi-val">{sizeText(totalSize)}</strong>
                      <span className="tiny">以磁盘真实文件为准</span>
                    </div>
                  </div>

                  <div className="sucai-folder-grid">
                    {FOLDERS.map((folder, idx) => {
                      const folderFiles = lib.filter((f) => f.folder === folder);
                      const todayCount = folderFiles.filter((f) => f.date === today).length;
                      const folderBytes = folderFiles.reduce((s, f) => s + (f.size || 0), 0);
                      const latest = [...folderFiles].sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0))[0];
                      const meta = FOLDER_META[folder];
                      return (
                        <StaggerItem key={folder} index={idx}>
                          <m.button
                            type="button"
                            className="sucai-folder-card"
                            onClick={() => setSucaiTab(folder)}
                            whileHover={{ y: -2, transition: MOTION_SPRING.snappy }}
                            whileTap={{ scale: 0.985, transition: MOTION_SPRING.snappy }}
                          >
                            <div className="sucai-folder-top">
                              <span className="sucai-folder-icon" style={{ color: meta.color, background: `${meta.color}18` }}>
                                <Icon name={meta.icon} className="ic" size={18} />
                              </span>
                              <div className="sucai-folder-title">
                                <strong>{folder}</strong>
                                <span className="tiny">{meta.desc}</span>
                              </div>
                              <span className={`sucai-today-badge ${todayCount > 0 ? 'has-new' : ''}`}>
                                今日 {todayCount > 0 ? `+${todayCount}` : '0'}
                              </span>
                            </div>

                            <div className="sucai-folder-metrics">
                              <div className="sucai-folder-count">
                                <b>{folderFiles.length}</b>
                                <span>个文件</span>
                              </div>
                              <span className="tiny">{sizeText(folderBytes)}</span>
                            </div>

                            <div className="sucai-folder-latest">
                              {latest ? (
                                <>
                                  <span className="sucai-latest-name" title={latest.name}>{latest.name}</span>
                                  <span className="tiny" style={{ flexShrink: 0 }}>{modifiedText(latest.modifiedAt)}</span>
                                </>
                              ) : (
                                <span className="tiny" style={{ color: 'var(--text-3)' }}>暂无文件，点击查看目录</span>
                              )}
                            </div>
                          </m.button>
                        </StaggerItem>
                      );
                    })}
                  </div>

                  <div className="sucai-recent-section">
                    <div className="sucai-recent-head">
                      <b>最近更新</b>
                      <span className="tiny">最新 6 条本地归档文件，点击即可查看</span>
                    </div>
                    {recentFiles.length ? (
                      <div className="finder-list">
                        <div className="finder-head">
                          <span>名称</span>
                          <span>板块</span>
                          <span>修改日期</span>
                          <span>大小</span>
                        </div>
                        {recentFiles.map((file) => {
                          const badgeKind = file.kind === 'x' ? 'x' : file.kind === 'i' ? 'i' : 'w';
                          const badgeLetter = file.kind === 'x' ? 'X' : file.kind === 'i' ? 'P' : 'W';
                          return (
                            <button
                              type="button"
                              className="finder-row"
                              key={file.localPath}
                              onClick={() => openRecentItem(file)}
                              title={`打开 ${file.name}`}
                            >
                              <span className="finder-name">
                                <span className={`finder-file-icon ${badgeKind}`}>{badgeLetter}</span>
                                <span>{file.name}</span>
                              </span>
                              <span>{file.folder}</span>
                              <span>{modifiedText(file.modifiedAt)}</span>
                              <span>{sizeText(file.size)}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="sucai-empty" style={{ padding: '28px 16px' }}>
                        <Icon name="archive" className="ic" size={26} />
                        <div>素材库暂无文件，去选题、创意、洗稿或出图模块导出即可同步展示</div>
                      </div>
                    )}
                  </div>
                </div>
              ) : tab === '图片' ? (
                files.length ? (
                  <div className="img-grid">
                    {files.map((file) => (
                      <m.button
                        type="button"
                        className="img-cell"
                        key={file.localPath}
                        onClick={() => setPreview(file)}
                        whileHover={{ y: -2, transition: MOTION_SPRING.snappy }}
                        whileTap={{ scale: 0.98, transition: MOTION_SPRING.snappy }}
                      >
                        {imageUrl(file) ? (
                          <img className="img-thumb-img" src={imageUrl(file)} alt={file.name} />
                        ) : (
                          <div className="img-thumb"><Icon name="image" className="ic" size={26} /></div>
                        )}
                        <div className="img-name" title={file.name}>{file.name}</div>
                        <div className="img-foot"><span className="img-date tiny">{file.date} · {sizeText(file.size)}</span></div>
                      </m.button>
                    ))}
                  </div>
                ) : (
                  <div className="sucai-empty"><Icon name="image" className="ic" size={30} /><div>「图片」文件夹暂无图片，去出图模块导出</div></div>
                )
              ) : (
                files.length ? (
                  <div className="finder-list">
                    <div className="finder-head"><span>名称</span><span>修改日期</span><span>大小</span><span>种类</span></div>
                    {files.map((file) => {
                      const excel = file.kind === 'x';
                      const kindLabel = excel ? 'Microsoft Excel 工作表 (.xlsx)' : 'Word 文档 (.docx)';
                      return (
                        <button type="button" className="finder-row" key={file.localPath} onClick={() => void openFile(file)} title={`查看 ${file.name}`}>
                          <span className="finder-name"><span className={`finder-file-icon ${file.kind}`}>{excel ? 'X' : 'W'}</span><span>{file.name}</span></span>
                          <span>{modifiedText(file.modifiedAt)}</span><span>{sizeText(file.size)}</span><span title={kindLabel}>{kindLabel}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="sucai-empty"><Icon name="folder" className="ic" size={30} /><div>「{tab}」文件夹暂无文件，去对应模块导出</div></div>
                )
              )}
            </PageTransition>
          </>
        )}

        <div className="tiny" style={{ marginTop: 14, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="check" className="ic" size={13} />
          <span>此处只展示真实本地文件；删除、移动等文件管理请在电脑文件夹中完成。</span>
        </div>
      </div>

      <Modal isOpen={setupOpen} onOpenChange={setSetupOpen} isDismissable={Boolean(status?.rootDir && status?.ready)}>
        <ModalContent>{(onClose) => (
          <>
            <ModalHeader>{status?.rootDir ? '确认素材库文件夹' : '设置本地素材库目录'}</ModalHeader>
            <ModalBody>
              {!status?.rootDir ? (
                <>
                  <div className="tiny">选择一个本地目录。工作台会在其中创建“选题 / 创意 / 洗稿 / 图片”四个文件夹；实体文件始终由你的电脑保存。</div>
                  <Input value={rootInput} onValueChange={setRootInput} placeholder="选择或填写本地目录" />
                  <Button variant="bordered" className="topic-outline-button" onPress={() => void chooseRoot()}>
                    <Icon name="folder" className="ic" size={14} /> 选择本地目录
                  </Button>
                  <div className="tiny">若未弹出目录选择器，可直接粘贴完整本地目录路径。</div>
                </>
              ) : (
                <>
                  <div>已选择目录：</div><div className="out-box" style={{ padding: 12 }}>{status.rootDir}</div>
                  <div className="tiny">将创建：{(status.missingFolders || FOLDERS).join('、')}。如果它们已存在，不会改动其中任何文件。</div>
                </>
              )}
            </ModalBody>
            <ModalFooter>
              {status?.rootDir && <Button variant="light" onPress={onClose}>稍后设置</Button>}
              {!status?.rootDir ? (
                <Button color="primary" isLoading={saving} onPress={() => void saveRoot()}>保存目录</Button>
              ) : (
                <Button color="primary" isLoading={saving} onPress={() => void initializeFolders()}>创建文件夹</Button>
              )}
            </ModalFooter>
          </>
        )}</ModalContent>
      </Modal>

      {preview && (
        <Modal isOpen onOpenChange={(open) => { if (!open) setPreview(null); }} size="3xl">
          <ModalContent>{(onClose) => (
            <>
              <ModalHeader>{preview.name}</ModalHeader>
              <ModalBody>
                <div className="lib-img-view">
                  {imageUrl(preview) ? (
                    <img src={imageUrl(preview)} alt={preview.name} />
                  ) : (
                    <div className="lib-noimg"><Icon name="image" className="ic" size={30} /><span>正在加载预览…</span></div>
                  )}
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose}>关闭</Button>
                <Button variant="bordered" className="topic-outline-button" onPress={() => void openFile(preview, true)}>
                  <Icon name="folder" className="ic" size={14} /> 在文件夹中显示
                </Button>
              </ModalFooter>
            </>
          )}</ModalContent>
        </Modal>
      )}
    </div>
  );
}
