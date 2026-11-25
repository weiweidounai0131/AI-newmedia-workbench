import { useEffect, useRef } from 'react';

interface FilingCell {
  col: number;
  row: number;
  angle: number;
  vel: number;
  energy: number;
}

/**
 * 源自 motion.dev 官方示例《Magnetic filings》的科技感纯视觉待机动效：
 * - 17 × 8 精密微指针阵列，四周柔和羽化无缝融入 Hero 卡片右侧，无多余边框与文字干扰
 * - 待机时：由双极旋转磁场 + 慢速利萨如巡航焦点驱动，微指针自然排列出流动的磁感线弧形波场与焦点流光
 * - 交互时：鼠标滑入顶部卡片任意区域，所有指针通过真实弹簧角动量阻尼丝滑转向光标；移开后无缝回归待机巡航
 * - 性能：高分屏单 Canvas 绘制，零 DOM 压力，窗口不可见或离开视口自动停帧（0% 后台 CPU），遵循 reduced-motion
 */
export function MagneticFilings({ theme }: { theme: 'light' | 'dark' }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    const COLS = 17;
    const ROWS = 8;
    const cells: FilingCell[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        cells.push({ col: c, row: r, angle: -0.4, vel: 0, energy: 0 });
      }
    }

    let width = 440;
    let height = 200;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // 监听整个 Hero 卡片，让鼠标在 Hero 内滑动时就能流畅吸引微指针
    const heroHost = canvas.closest('.home-hero') as HTMLElement | null;
    let pointerActive = false;
    let pointerX = width * 0.56;
    let pointerY = height * 0.5;

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointerX = e.clientX - rect.left;
      pointerY = e.clientY - rect.top;
      pointerActive = true;
    };
    const onPointerLeave = () => {
      pointerActive = false;
    };

    heroHost?.addEventListener('pointermove', onPointerMove);
    heroHost?.addEventListener('pointerleave', onPointerLeave);

    let fieldX = width * 0.56;
    let fieldY = height * 0.5;
    let pointerBlend = 0;
    let rafId = 0;
    let visible = true;
    const startTime = performance.now();
    let lastTime = startTime;

    const wrapAngleDiff = (target: number, current: number) => {
      let diff = (target - current) % (Math.PI * 2);
      if (diff > Math.PI) diff -= Math.PI * 2;
      if (diff < -Math.PI) diff += Math.PI * 2;
      return diff;
    };

    const drawFrame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.008, (now - lastTime) * 0.001));
      lastTime = now;
      const t = reducedMotion ? 1.8 : (now - startTime) * 0.001;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const dark = themeRef.current === 'dark';

      // 待机巡航焦点（∞ 利萨如轨迹，约 11 秒优雅缓行一圈）
      const idleX = width * (0.54 + 0.31 * Math.sin(t * 0.56));
      const idleY = height * (0.5 + 0.28 * Math.sin(t * 1.12 + 0.35));
      const targetX = pointerActive ? pointerX : idleX;
      const targetY = pointerActive ? pointerY : idleY;

      const lerpRate = pointerActive ? 0.16 : 0.065;
      fieldX += (targetX - fieldX) * lerpRate;
      fieldY += (targetY - fieldY) * lerpRate;
      pointerBlend += ((pointerActive ? 1 : 0) - pointerBlend) * 0.08;

      // 焦点柔和磁光底晕
      const glowR = Math.min(width, height) * 0.78;
      const glow = ctx.createRadialGradient(fieldX, fieldY, 4, fieldX, fieldY, glowR);
      if (dark) {
        glow.addColorStop(0, 'rgba(56, 189, 248, 0.20)');
        glow.addColorStop(0.45, 'rgba(99, 102, 241, 0.09)');
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      } else {
        glow.addColorStop(0, 'rgba(0, 114, 245, 0.14)');
        glow.addColorStop(0.48, 'rgba(99, 102, 241, 0.06)');
        glow.addColorStop(1, 'rgba(0, 114, 245, 0)');
      }
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);

      // 偶极副极坐标（仅在待机态生效，制造真实磁感线的优雅弯曲流场）
      const dipoleAngle = t * 0.38;
      const poleOffset = Math.min(width, height) * 0.42;
      const poleAx = fieldX + Math.cos(dipoleAngle) * poleOffset;
      const poleAy = fieldY + Math.sin(dipoleAngle) * poleOffset * 0.65;
      const poleBx = fieldX - Math.cos(dipoleAngle) * poleOffset;
      const poleBy = fieldY - Math.sin(dipoleAngle) * poleOffset * 0.65;

      const padX = 20;
      const padY = 18;
      const stepX = (width - padX * 2) / (COLS - 1);
      const stepY = (height - padY * 2) / (ROWS - 1);
      const influenceR = Math.max(width * 0.48, 175);

      // 真实弹簧角动量参数（丝滑且无过冲抖动）
      const stiffness = 135;
      const damping = 16.5;

      ctx.lineCap = 'round';

      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const x = padX + cell.col * stepX;
        const y = padY + cell.row * stepY;

        // 1) 光标直指向量（交互态主导）
        const pdx = fieldX - x;
        const pdy = fieldY - y;
        const dist = Math.hypot(pdx, pdy);
        const directAngle = Math.atan2(pdy, pdx);

        // 2) 双极磁感线向量（待机态形成优雅流线漩涡）
        const ax = x - poleAx;
        const ay = y - poleAy;
        const ad2 = ax * ax + ay * ay + 900;
        const bx = x - poleBx;
        const by = y - poleBy;
        const bd2 = bx * bx + by * by + 900;
        const fx = ax / ad2 - bx / bd2;
        const fy = ay / ad2 - by / bd2;
        const dipoleFieldAngle = Math.atan2(fy, fx);

        // 在待机磁感线与交互直指角之间做最短弧插值
        const desiredAngle =
          dipoleFieldAngle + wrapAngleDiff(directAngle, dipoleFieldAngle) * (0.28 + pointerBlend * 0.72);

        if (reducedMotion) {
          cell.angle = desiredAngle;
        } else {
          const diff = wrapAngleDiff(desiredAngle, cell.angle);
          const accel = diff * stiffness - cell.vel * damping;
          cell.vel += accel * dt;
          cell.angle += cell.vel * dt;
        }

        // 能量感：聚焦点附近高亮拉伸，同时叠加细腻的磁波脉冲
        const prox = Math.max(0, 1 - dist / influenceR);
        const ripple = 0.5 + 0.5 * Math.sin(dist * 0.032 - t * 2.2);
        const targetEnergy = Math.min(1, prox * prox * 0.92 + prox * ripple * 0.22);
        cell.energy += (targetEnergy - cell.energy) * (reducedMotion ? 1 : 0.14);

        // 四周柔顺羽化，无生硬边界
        const nx = (cell.col / (COLS - 1)) * 2 - 1;
        const ny = (cell.row / (ROWS - 1)) * 2 - 1;
        const edgeDist = Math.hypot(nx * 0.9, ny * 0.94);
        const edgeFade = Math.max(0.16, 1 - Math.pow(Math.max(0, edgeDist - 0.62) / 0.72, 1.75));

        const baseLen = Math.min(stepX, stepY) * 0.5;
        const len = baseLen * (0.84 + cell.energy * 0.44);
        const lineW = 1.85 + cell.energy * 0.95;

        const cosA = Math.cos(cell.angle);
        const sinA = Math.sin(cell.angle);
        const half = len * 0.5;

        if (dark) {
          // 深色模式：冷金属银灰 → 科技冰蓝 / 靛青高光
          const r = Math.round(140 - cell.energy * 96);
          const g = Math.round(158 + cell.energy * 58);
          const b = Math.round(186 + cell.energy * 69);
          const alpha = (0.3 + cell.energy * 0.68) * edgeFade;
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
        } else {
          // 浅色模式：精密冷灰蓝 → 品牌钴蓝 & 紫罗兰微光（层次分明、清晰锐利）
          const r = Math.round(138 - cell.energy * 130);
          const g = Math.round(156 - cell.energy * 48);
          const b = Math.round(184 + cell.energy * 64);
          const alpha = (0.4 + cell.energy * 0.58) * edgeFade;
          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
        }

        ctx.lineWidth = lineW;
        ctx.beginPath();
        ctx.moveTo(x - cosA * half, y - sinA * half);
        ctx.lineTo(x + cosA * half, y + sinA * half);
        ctx.stroke();

        // 高能指针尖端微光点，凸显精密仪表盘质感
        if (cell.energy > 0.3) {
          const tipAlpha = Math.min(0.95, (cell.energy - 0.3) * 1.35 * edgeFade);
          ctx.fillStyle = dark
            ? `rgba(125, 211, 252, ${tipAlpha.toFixed(3)})`
            : `rgba(0, 114, 245, ${tipAlpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x + cosA * half, y + sinA * half, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (!reducedMotion && visible && !document.hidden) {
        rafId = window.requestAnimationFrame(drawFrame);
      }
    };

    const startLoop = () => {
      if (reducedMotion) {
        drawFrame(performance.now());
        return;
      }
      if (!rafId && visible && !document.hidden) {
        lastTime = performance.now();
        rafId = window.requestAnimationFrame(drawFrame);
      }
    };

    const stopLoop = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };

    const onVisibility = () => {
      if (document.hidden) stopLoop();
      else startLoop();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[0]?.isIntersecting ?? true;
        if (visible) startLoop();
        else stopLoop();
      },
      { threshold: 0.05 },
    );
    io.observe(canvas);

    startLoop();

    return () => {
      stopLoop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      heroHost?.removeEventListener('pointermove', onPointerMove);
      heroHost?.removeEventListener('pointerleave', onPointerLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className="home-filings-canvas" aria-hidden="true" />;
}
