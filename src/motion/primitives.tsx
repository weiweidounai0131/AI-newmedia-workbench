import React, { useEffect } from 'react';
import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  domMax,
  m,
  useSpring,
  useTransform,
} from 'motion/react';
import { MOTION_EASE, MOTION_SPRING, PAGE_EXIT_TRANSITION, PAGE_TRANSITION } from './tokens';

/**
 * 根动效容器：
 * - LazyMotion(domMax) 按需加载布局/手势/退出特性并减小 bundle；
 * - MotionConfig reducedMotion="user" 自动尊重系统「减弱动态效果」设置。
 */
export function MotionRoot({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domMax}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/**
 * 主视图切换过渡容器：
 * 8px 轻纵向位移动效 + 透明度平滑过渡，快速退场不阻滞操作。
 */
export function PageTransition({
  viewKey,
  children,
  className = '',
}: {
  viewKey: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.div
        key={viewKey}
        className={className}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0, transition: PAGE_TRANSITION }}
        exit={{ opacity: 0, y: -5, transition: PAGE_EXIT_TRANSITION }}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}

/**
 * 共享布局弹簧指示器（侧边栏激活背景、Tab 滑块、分段控制器）。
 */
export function ActivePill({
  layoutId,
  className = '',
  style,
}: {
  layoutId: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <m.span
      layoutId={layoutId}
      className={className}
      style={style}
      transition={MOTION_SPRING.tab}
      aria-hidden="true"
    />
  );
}

/**
 * 统一弹窗与遮罩动效原语（替代突兀显隐与 iframe 弹窗）。
 */
export function SpringModal({
  open,
  onClose,
  children,
  className = '',
  maxWidth = 540,
}: {
  open: boolean;
  onClose?: () => void;
  children: React.ReactNode;
  className?: string;
  maxWidth?: number;
}) {
  return (
    <AnimatePresence>
      {open && (
        <m.div
          className="motion-modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.16, ease: MOTION_EASE.outExpo } }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose?.();
          }}
        >
          <m.div
            className={`motion-modal-panel ${className}`}
            style={{ maxWidth }}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: MOTION_SPRING.modal }}
            exit={{ opacity: 0, scale: 0.97, y: 8, transition: PAGE_EXIT_TRANSITION }}
          >
            {children}
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

/**
 * 轻量交错列表容器：仅前 10 条微错峰（间隔 22ms），长列表后续项即时出现，不制造等待感。
 */
export function StaggerItem({
  index,
  children,
  className = '',
}: {
  index: number;
  children: React.ReactNode;
  className?: string;
}) {
  const delay = Math.min(index, 10) * 0.022;
  return (
    <m.div
      className={className}
      initial={{ opacity: 0, y: 6 }}
      animate={{
        opacity: 1,
        y: 0,
        transition: { duration: 0.2, delay, ease: MOTION_EASE.outExpo },
      }}
    >
      {children}
    </m.div>
  );
}

/**
 * 弹性进度条（用于原生下载进度、迁移进度、环境检查进度）。
 */
export function SpringProgress({
  percent,
  className = '',
}: {
  percent: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const spring = useSpring(clamped, MOTION_SPRING.progress);
  const width = useTransform(spring, (v) => `${v.toFixed(1)}%`);

  useEffect(() => {
    spring.set(clamped);
  }, [clamped, spring]);

  return (
    <div className={`motion-progress-track ${className}`} role="progressbar" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100}>
      <m.div className="motion-progress-fill" style={{ width }} />
    </div>
  );
}

/**
 * 轻量交互卡片（微悬浮与微按压反馈）。
 */
export function InteractiveCard({
  children,
  className = '',
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <m.div
      className={className}
      onClick={onClick}
      whileHover={{ y: -2, transition: MOTION_SPRING.snappy }}
      whileTap={onClick ? { scale: 0.99, transition: MOTION_SPRING.snappy } : undefined}
    >
      {children}
    </m.div>
  );
}

export { AnimatePresence, m };
