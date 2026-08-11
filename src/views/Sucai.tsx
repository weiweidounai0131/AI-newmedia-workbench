import { useEffect, useState } from 'react';
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { useApp, clearLibrarySetupRequest, setLib, setSettings } from '../store/appStore';
import { api, getApiBase } from '../api/client';
import { Icon } from '../icons';
import { useToastMsg } from '../lib/ui';
import type { LibFile } from '../store/appStore';

const FOLDERS: ('选题' | '创意' | '洗稿' | '图片')[] = ['选题', '创意', '洗稿', '图片'];
type LibraryStatus = { rootDir: string | null; missingFolders: ('选题' | '创意' | '洗稿' | '图片')[]; ready: boolean; files: LibFile[] };

function sizeText(bytes?: number) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function modifiedText(time?: number) {
  if (!time) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time));
}

export default function Sucai() {
  const lib = useApp((s) => s.lib);
  const setupRequested = useApp((s) => s.librarySetupRequested);
  const toast = useToastMsg();
  const [tab, setTab] = useState<'选题' | '创意' | '洗稿' | '图片'>('图片');
  const [preview, setPreview] = useState<LibFile | null>(null);
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [rootInput, setRootInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [apiBase, setApiBase] = useState('');

  const files = lib.filter((file) => file.folder === tab);
  const ready = Boolean(status?.ready);

  async function refresh(showToast = false) {
    try {
      const next = await api.listLibrary();
      setStatus(next);
      setLib(next.files);
      if (!next.rootDir || !next.ready) setSetupOpen(true);
      if (showToast) toast('已按本地目录刷新素材库', 'success');
    } catch (error: any) {
      toast(error?.message || '素材库读取失败，请确认后端已启动', 'danger');
    }
  }

  useEffect(() => {
    void refresh();
    void getApiBase().then(setApiBase);
  }, []);

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
    if (!apiBase) return '';
    return `${apiBase}/api/library/file?folder=${encodeURIComponent(file.folder)}&name=${encodeURIComponent(file.name)}`;
  }

  return (
    <div className="panel sucai-panel">
      <div className="panel-head">
        <h3><Icon name="archive" className="ic" size={18} /> 素材库</h3>
        <div className="spacer" />
        <span className="tiny">本地文件夹同步</span>
      </div>
      <div className="panel-body">
      <div className="sucai-path">
        <span className="sp">本地素材库</span><span className="sep">/</span><b>{tab}</b>
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
        <div className="sucai-empty">
          <Icon name="folder" className="ic" size={32} />
          <div>{status?.rootDir ? '请先确认创建素材库分类文件夹' : '请先设置本地素材库目录'}</div>
          <Button color="primary" onPress={() => setSetupOpen(true)}>设置本地目录</Button>
        </div>
      ) : <>
        <div className="tiny" style={{ marginBottom: 12, color: 'var(--text-3)' }}>目录：{status?.rootDir}</div>
        <div className="xuanti-tabs" role="tablist" style={{ marginBottom: 16 }}>
          {FOLDERS.map((folder) => (
            <button key={folder} className={`xuanti-tab ${tab === folder ? 'active' : ''}`} onClick={() => setTab(folder)}>
              <Icon name="folder" className="ic" size={18} /><span>{folder}</span><span className="count">{lib.filter((file) => file.folder === folder).length}</span>
            </button>
          ))}
        </div>

        <div className="sucai-body">
          {tab === '图片' ? (
            files.length ? <div className="img-grid">
              {files.map((file) => <button className="img-cell" key={file.localPath} onClick={() => setPreview(file)}>
                {imageUrl(file) ? <img className="img-thumb-img" src={imageUrl(file)} alt={file.name} /> : <div className="img-thumb"><Icon name="image" className="ic" size={26} /></div>}
                <div className="img-name" title={file.name}>{file.name}</div>
                <div className="img-foot"><span className="img-date tiny">{file.date} · {sizeText(file.size)}</span></div>
              </button>)}
            </div> : <div className="sucai-empty"><Icon name="image" className="ic" size={30} /><div>「图片」文件夹暂无图片，去出图模块导出</div></div>
          ) : (
            files.length ? <div className="finder-list">
              <div className="finder-head"><span>名称</span><span>修改日期</span><span>大小</span><span>种类</span></div>
              {files.map((file) => {
                const excel = file.kind === 'x';
                const kindLabel = excel ? 'Microsoft Excel 工作表 (.xlsx)' : 'Word 文档 (.docx)';
                return <button className="finder-row" key={file.localPath} onClick={() => void openFile(file)} title={`查看 ${file.name}`}>
                  <span className="finder-name"><span className={`finder-file-icon ${file.kind}`}>{excel ? 'X' : 'W'}</span><span>{file.name}</span></span>
                  <span>{modifiedText(file.modifiedAt)}</span><span>{sizeText(file.size)}</span><span title={kindLabel}>{kindLabel}</span>
                </button>;
              })}
            </div> : <div className="sucai-empty"><Icon name="folder" className="ic" size={30} /><div>「{tab}」文件夹暂无文件，去对应模块导出</div></div>
          )}
        </div>
      </>}

      <div className="tiny" style={{ marginTop: 14, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="check" className="ic" size={13} /> <span>此处只展示真实本地文件；删除、移动等文件管理请在电脑文件夹中完成。</span></div>
      </div>

      <Modal isOpen={setupOpen} onOpenChange={setSetupOpen} isDismissable={Boolean(status?.rootDir && status?.ready)}>
        <ModalContent>{(onClose) => <>
          <ModalHeader>{status?.rootDir ? '确认素材库文件夹' : '设置本地素材库目录'}</ModalHeader>
          <ModalBody>
            {!status?.rootDir ? <>
              <div className="tiny">选择一个本地目录。工作台会在其中创建“选题 / 创意 / 洗稿 / 图片”四个文件夹；实体文件始终由你的电脑保存。</div>
              <Input value={rootInput} onValueChange={setRootInput} placeholder="选择或填写本地目录" />
              <Button variant="bordered" className="topic-outline-button" onPress={() => void chooseRoot()}><Icon name="folder" className="ic" size={14} /> 选择本地目录</Button>
              <div className="tiny">若未弹出目录选择器，可直接粘贴完整本地目录路径。</div>
            </> : <>
              <div>已选择目录：</div><div className="out-box" style={{ padding: 12 }}>{status.rootDir}</div>
              <div className="tiny">将创建：{(status.missingFolders || FOLDERS).join('、')}。如果它们已存在，不会改动其中任何文件。</div>
            </>}
          </ModalBody>
          <ModalFooter>
            {status?.rootDir && <Button variant="light" onPress={onClose}>稍后设置</Button>}
            {!status?.rootDir ? <Button color="primary" isLoading={saving} onPress={() => void saveRoot()}>保存目录</Button> : <Button color="primary" isLoading={saving} onPress={() => void initializeFolders()}>创建文件夹</Button>}
          </ModalFooter>
        </>}</ModalContent>
      </Modal>

      {preview && <Modal isOpen onOpenChange={(open) => { if (!open) setPreview(null); }} size="3xl"><ModalContent>{(onClose) => <>
        <ModalHeader>{preview.name}</ModalHeader><ModalBody><img className="lib-img-view" src={imageUrl(preview)} alt={preview.name} /></ModalBody>
        <ModalFooter><Button variant="light" onPress={onClose}>关闭</Button><Button variant="bordered" className="topic-outline-button" onPress={() => void openFile(preview, true)}><Icon name="folder" className="ic" size={14} /> 在文件夹中显示</Button></ModalFooter>
      </>}</ModalContent></Modal>}
    </div>
  );
}
