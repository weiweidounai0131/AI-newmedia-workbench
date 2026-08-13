import { useEffect, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Spinner } from '@heroui/react';
import { api } from '../api/client';
import { Icon } from '../icons';

type RuntimeStatus = Awaited<ReturnType<typeof api.runtimeStatus>>;

export function FirstRunGuide({ open, onFinish }: { open: boolean; onFinish: () => void }) {
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [cookies, setCookies] = useState<Record<string, boolean>>({});
  const [loggingIn, setLoggingIn] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [next, login] = await Promise.all([api.runtimeStatus(), api.scrapeStatus().catch(() => ({ electron: false, platforms: {} }))]);
      setRuntime(next); setCookies(login.platforms || {}); setError(null); return next;
    } catch (e: any) { setError(e?.message || '环境状态读取失败'); return null; }
  };
  useEffect(() => { if (open) void refresh(); }, [open]);
  useEffect(() => {
    if (!runtime?.installing && !installing) return;
    const timer = window.setInterval(() => { void refresh().then((next) => { if (next && !next.installing) setInstalling(false); }); }, 1800);
    return () => window.clearInterval(timer);
  }, [runtime?.installing, installing]);
  useEffect(() => {
    if (!loggingIn) return;
    const timer = window.setInterval(() => { void api.scrapeLoginSession(loggingIn).then((result) => {
      if (result.connected) { setCookies((value) => ({ ...value, [loggingIn]: true })); setLoggingIn(null); setQr(null); }
    }).catch(() => {}); }, 1800);
    return () => window.clearInterval(timer);
  }, [loggingIn]);

  const install = async () => { setInstalling(true); try { setRuntime(await api.installRuntime()); } catch (e: any) { setInstalling(false); setError(e?.message || '环境安装未启动'); } };
  const login = async (platform: '抖音' | '小红书') => {
    setLoggingIn(platform); setError(null);
    try {
      const result = await api.scrapeLoginQr(platform); setQr(result.qr || null);
      if (result.connected) { setCookies((value) => ({ ...value, [platform]: true })); setLoggingIn(null); }
    } catch (e: any) { setLoggingIn(null); setError(e?.message || `无法打开${platform}登录窗口`); }
  };
  const ready = !!runtime?.ready;
  return <Modal isOpen={open} isDismissable={false} hideCloseButton backdrop="blur" size="2xl"><ModalContent>
    <ModalHeader>首次使用引导</ModalHeader>
    <ModalBody>
      <div className="onboarding-intro">先完成本机运行环境与平台登录设置。所有数据和 Cookie 仅保存在这台电脑。</div>
      <section className="onboarding-step"><div className="onboarding-title"><span className={`onboarding-number ${ready ? 'done' : ''}`}>{ready ? '✓' : '1'}</span><div><b>本机环境</b><small>{runtime?.message || '正在检查…'} 优先复用本机 Chrome / Edge，未检测到时才下载浏览器运行时。</small></div></div>
        <div className="onboarding-components">{(runtime?.components || []).map((item) => <span key={item.id} className={`onboarding-chip ${item.ready ? 'ready' : ''}`}>{item.ready ? '✓' : '•'} {item.label} · {item.detail}</span>)}</div>
        {!ready && <Button color="primary" size="sm" isLoading={installing || !!runtime?.installing} onPress={install}>安装本机环境</Button>}
      </section>
      <section className={`onboarding-step ${ready ? '' : 'disabled'}`}><div className="onboarding-title"><span className={`onboarding-number ${cookies['抖音'] && cookies['小红书'] ? 'done' : ''}`}>{cookies['抖音'] && cookies['小红书'] ? '✓' : '2'}</span><div><b>平台登录与 Cookie</b><small>登录后可用于搜索、链接解析与本地下载。</small></div></div>
        <div className="onboarding-login-grid">{(['抖音', '小红书'] as const).map((platform) => <div className="onboarding-login" key={platform}><span>{platform}</span><span className={cookies[platform] ? 'status-ready' : 'status-wait'}>{cookies[platform] ? '已获取' : '未获取'}</span><Button size="sm" variant="bordered" isDisabled={!ready} isLoading={loggingIn === platform} onPress={() => login(platform)}>{cookies[platform] ? '重新登录' : '登录'}</Button></div>)}</div>
        {loggingIn && <div className="onboarding-poll"><Spinner size="sm" /> 正在等待「{loggingIn}」完成登录；请在弹出的浏览器中扫码或验证。</div>}{qr && <img className="onboarding-qr" src={qr} alt="平台登录二维码" />}
      </section>
      {error && <div className="onboarding-error"><Icon name="alert" className="ic" size={16} /> {error}</div>}
    </ModalBody>
    <ModalFooter><Button variant="light" onPress={onFinish}>暂时跳过</Button><Button color="primary" onPress={onFinish} isDisabled={!ready}>进入工作台</Button></ModalFooter>
  </ModalContent></Modal>;
}
