import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import {
  api,
  type LegacyMigrationPreview,
  type MigrationReport,
} from '../api/client';
import { Icon } from '../icons';
import { SpringModal, SpringProgress } from '../motion';
import { setLib, setSettings } from '../store/appStore';
import { useToastMsg } from '../lib/ui';

function fmtMB(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function MigrationModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToastMsg();
  const [customDir, setCustomDir] = useState<string>('');
  const [preview, setPreview] = useState<LegacyMigrationPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [migrateSettings, setMigrateSettings] = useState(true);
  const [migrateKeys, setMigrateKeys] = useState(true);
  const [copyProfiles, setCopyProfiles] = useState(false);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  async function refreshPreview(dir?: string) {
    setLoading(true);
    try {
      const p = await api.inspectLegacyMigration(dir ?? (customDir || null));
      setPreview(p);
    } catch (e: any) {
      toast(e?.message || '扫描旧版目录失败', 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      setReport(null);
      setCleanupConfirmed(false);
      setProgress(0);
      void refreshPreview();
    }
  }, [open]);

  async function pickLegacyDir() {
    const dir = await api.chooseLibraryRoot();
    if (dir) {
      setCustomDir(dir);
      void refreshPreview(dir);
    }
  }

  async function startMigration() {
    setRunning(true);
    setProgress(25);
    try {
      const res = await api.runLegacyMigration({
        customLegacyDir: customDir || null,
        migrateSettings,
        migrateKeys,
        copyBrowserProfiles: copyProfiles,
      });
      setProgress(85);
      const [nextSettings, nextLib] = await Promise.all([
        api.getSettings().catch(() => null),
        api.listLibrary().catch(() => null),
      ]);
      if (nextSettings) setSettings(nextSettings);
      if (nextLib) setLib(nextLib.files);
      setProgress(100);
      setReport(res);
      toast('旧版数据迁移完成', 'success');
    } catch (e: any) {
      setProgress(0);
      toast(e?.message || '迁移失败', 'danger');
    } finally {
      setRunning(false);
    }
  }

  async function runCleanup() {
    if (!cleanupConfirmed) return;
    setCleaning(true);
    try {
      const res = await api.cleanupLegacyRuntime(customDir || null, 'CLEAN_LEGACY_RUNTIME');
      toast(res.message, 'success');
      setCleanupConfirmed(false);
      void refreshPreview();
    } catch (e: any) {
      toast(e?.message || '清理旧版运行时失败', 'danger');
    } finally {
      setCleaning(false);
    }
  }

  return (
    <SpringModal open={open} onClose={onClose} maxWidth={580}>
      <div className="modal-head">
        <h3>旧版 Electron 数据无损迁移</h3>
        <button type="button" className="modal-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="tiny" style={{ color: 'var(--text-2)', lineHeight: 1.6 }}>
          全程只读扫描旧版 <code>newmedia-workbench</code> 数据目录，自动将四能力模型配置、自定义供应商、加密 API Key（macOS 钥匙串 / Windows DPAPI / AES）及素材库路径安全导入新版，<b>绝不改动旧版原目录或素材库</b>。
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="out-box" style={{ flex: 1, padding: '8px 10px', fontSize: 12, wordBreak: 'break-all' }}>
            {preview?.legacyDir || customDir || '未自动检测到旧版目录，可手动选择'}
          </div>
          <Button size="sm" variant="bordered" onPress={() => void pickLegacyDir()}>
            选择目录
          </Button>
          <Button size="sm" variant="flat" isLoading={loading} onPress={() => void refreshPreview()}>
            重新扫描
          </Button>
        </div>

        {preview?.detected ? (
          <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>检测到的可迁移资产</div>
            <div className="tiny" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, color: 'var(--text-2)' }}>
              <span>配置档案：{preview.hasSettings ? '已找到 settings.json' : '未找到'}</span>
              <span>自定义供应商：{preview.providerCount} 个</span>
              <span>加密 API Key：{preview.keyIds.length} 项</span>
              <span>素材库路径：{preview.rootDir ? '已配置' : '未配置'}</span>
              <span>抖音登录 Profile：{preview.hasDouyinProfile ? '已存在' : '无'}</span>
              <span>小红书登录 Profile：{preview.hasXhsProfile ? '已存在' : '无'}</span>
            </div>

            {!report && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={migrateSettings} onChange={(e) => setMigrateSettings(e.target.checked)} />
                  <span>迁移四能力模型配置、自定义供应商与素材库目录</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={migrateKeys} onChange={(e) => setMigrateKeys(e.target.checked)} />
                  <span>自动解密并重存加密 API Key 到新版系统安全存储（macOS 首次会弹出钥匙串授权）</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={copyProfiles} onChange={(e) => setCopyProfiles(e.target.checked)} />
                  <span>复制旧版抖音/小红书浏览器登录 Profile（可选，失效可重新扫码）</span>
                </label>
              </div>
            )}
          </div>
        ) : (
          <div className="card" style={{ padding: 16, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
            当前未检测到旧版 Electron 数据目录，如需迁移请点击上方「选择目录」。
          </div>
        )}

        {(running || progress > 0) && (
          <div>
            <div className="tiny" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span>{running ? '正在执行无损迁移…' : '迁移完成'}</span>
              <b>{progress}%</b>
            </div>
            <SpringProgress percent={progress} />
          </div>
        )}

        {report && (
          <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'var(--accent-line)' }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="check" className="ic" size={15} /> 迁移核验报告
            </div>
            <div className="tiny" style={{ color: 'var(--text-2)', lineHeight: 1.7 }}>
              <div>• 已迁移能力配置：{report.capsMigrated} 项 ｜ 自定义供应商：{report.providersMigrated} 个</div>
              <div>• 成功解密并重存 API Key：{report.keysMigrated.length ? report.keysMigrated.join('、') : '无'}</div>
              <div>• 素材库根目录：{report.rootDirMigrated ? '已迁移' : '未变更'} ｜ 小红书目录：{report.xhsDirMigrated ? '已迁移' : '未变更'}</div>
              {report.profilesCopied.length > 0 && (
                <div>• 已复制登录 Profile：{report.profilesCopied.join('、')}</div>
              )}
            </div>
            {report.keysFailed.length > 0 && (
              <div className="source-feedback warning" style={{ marginTop: 4 }}>
                <div className="source-feedback-title">部分 Key 需手动补填（{report.keysFailed.length} 项）</div>
                {report.keysFailed.map((f) => (
                  <div key={f.keyId} className="tiny">
                    • {f.keyId}：{f.reason}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {preview && preview.runtimeBytes > 0 && (
          <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              可选：释放旧版 Python 运行时空间（可释放 {fmtMB(preview.runtimeBytes)}）
            </div>
            <div className="tiny" style={{ color: 'var(--text-3)' }}>
              仅删除旧版 <code>runtime/</code> 下的两套 Python 虚拟环境；绝不删除旧版 <code>settings.json</code> 与你的任何素材库文件。建议确认新版可用后再执行。
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={cleanupConfirmed}
                onChange={(e) => setCleanupConfirmed(e.target.checked)}
              />
              <span>我已确认新版配置正常，同意仅删除旧版 Python runtime 目录</span>
            </label>
            <div>
              <Button
                size="sm"
                color="danger"
                variant="flat"
                isDisabled={!cleanupConfirmed}
                isLoading={cleaning}
                onPress={() => void runCleanup()}
              >
                释放 {fmtMB(preview.runtimeBytes)} 旧版运行环境
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="modal-foot">
        <Button variant="light" onPress={onClose}>
          关闭
        </Button>
        {preview?.detected && !report && (
          <Button color="primary" isLoading={running} onPress={() => void startMigration()}>
            开始无损迁移
          </Button>
        )}
      </div>
    </SpringModal>
  );
}
