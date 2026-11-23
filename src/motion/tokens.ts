import type { Transition } from 'motion/react';

/**
 * 统一动效物理参数（Motion for React / motion.dev）
 * 面向高频桌面内容生产场景：快响应（150-240ms）、清晰阻尼、绝不拖慢操作。
 */
export const MOTION_EASE = {
  /** 标准减速（Apple 风格平滑停靠） */
  outExpo: [0.16, 1, 0.3, 1] as const,
  /** 退场加速（干脆收尾） */
  inQuint: [0.4, 0, 1, 1] as const,
};

export const MOTION_SPRING = {
  /** 侧栏指示条、Tab 滑块：跟手、零多余回弹 */
  tab: {
    type: 'spring',
    stiffness: 520,
    damping: 38,
    mass: 0.85,
  } satisfies Transition,

  /** 弹窗、抽屉、浮层卡片：微弹性、有重量感 */
  modal: {
    type: 'spring',
    stiffness: 420,
    damping: 32,
    mass: 0.9,
  } satisfies Transition,

  /** 按钮按压、轻卡片交互 */
  snappy: {
    type: 'spring',
    stiffness: 600,
    damping: 36,
    mass: 0.7,
  } satisfies Transition,

  /** 进度条数值补间 */
  progress: {
    stiffness: 180,
    damping: 26,
    mass: 0.6,
  },
} as const;

export const PAGE_TRANSITION: Transition = {
  duration: 0.2,
  ease: MOTION_EASE.outExpo,
};

export const PAGE_EXIT_TRANSITION: Transition = {
  duration: 0.12,
  ease: MOTION_EASE.inQuint,
};
