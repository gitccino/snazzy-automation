import React, { useEffect, useId, useRef, useState } from "react";

let gooFilterMounted = false;

export function LiquidGooFilter() {
  useEffect(() => {
    gooFilterMounted = true;
    return () => {
      gooFilterMounted = false;
    };
  }, []);

  return (
    <svg
      aria-hidden="true"
      className="liq-svg-defs"
      width="0"
      height="0"
      focusable="false"
    >
      <defs>
        <filter id="liq-goo" x="-35%" y="-35%" width="170%" height="170%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="6.5" result="smear" />
          <feColorMatrix
            in="smear"
            type="matrix"
            values="
              1 0 0 0 0
              0 1 0 0 0
              0 0 1 0 0
              0 0 0 19 -9"
          />
        </filter>
      </defs>
    </svg>
  );
}

export interface LiquidToggleProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
  ariaLabel?: string;
  size?: "default" | "sm";
  stretch?: number;
  speed?: number;
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export function LiquidToggle({
  id,
  checked,
  onChange,
  disabled = false,
  ariaDescribedBy,
  ariaInvalid,
  ariaLabel,
  size = "default",
  stretch = 42,
  speed = 54,
}: LiquidToggleProps) {
  const fallbackId = useId();
  const inputId = id ?? `liq-sw-${fallbackId}`;

  // Track geometry matching bencho.dev/?c=liq-toggle&theme=dark
  const isSmall = size === "sm";
  const thumbSize = isSmall ? 24 : 32;
  const dropSize = isSmall ? 18 : 24;
  const startX = isSmall ? 4 : 5;
  const endX = isSmall ? 36 : 45;
  const midX = (startX + endX) / 2;

  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const dropRef = useRef<HTMLSpanElement>(null);

  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);

  const physicsRef = useRef({
    x: checked ? endX : startX,
    vx: 0,
    chaseX: checked ? endX : startX,
    chaseVx: 0,
    scale: 1,
    scaleV: 0,
    raf: 0,
    lastTime: 0,
  });

  const dragRef = useRef<{
    pointerId: number;
    grabOffset: number | null;
    moved: boolean;
  } | null>(null);

  const applyTransform = () => {
    const p = physicsRef.current;
    const thumbEl = thumbRef.current;
    const dropEl = dropRef.current;
    if (!thumbEl || !dropEl) return;

    const stretchRatio = clamp(stretch, 0, 100) / 100;
    const velStretch =
      1 + Math.min(0.42, Math.abs(p.vx) / 560) * stretchRatio;
    const sx = velStretch * p.scale;
    const sy = p.scale / velStretch;

    thumbEl.style.transform = `translate3d(${p.x.toFixed(2)}px, 0, 0) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;

    const dropOffset = (thumbSize - dropSize) / 2;
    const dist = Math.abs(p.x - p.chaseX);
    const dropStretch = 1 + Math.min(0.35, dist / 28) * stretchRatio;
    dropEl.style.transform = `translate3d(${(p.chaseX + dropOffset).toFixed(2)}px, 0, 0) scale(${dropStretch.toFixed(3)}, ${(1 / dropStretch).toFixed(3)})`;
  };

  const startSpringLoop = (targetX: number, targetScale: number) => {
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      physicsRef.current.x = targetX;
      physicsRef.current.chaseX = targetX;
      physicsRef.current.scale = targetScale;
      applyTransform();
      return;
    }

    const stiffness = 175 - (50 - speed) * 1.1;
    const damping = 21.5;
    const mass = 0.9;

    const chaseStiff = 135;
    const chaseDamp = 19;

    const step = (now: number) => {
      const p = physicsRef.current;
      const dt = p.lastTime ? Math.min(0.032, (now - p.lastTime) / 1000) : 1 / 60;
      p.lastTime = now;

      if (!dragging) {
        const ax = ((targetX - p.x) * stiffness - p.vx * damping) / mass;
        p.vx += ax * dt;
        p.x += p.vx * dt;
      }

      const aChase = (p.x - p.chaseX) * chaseStiff - p.chaseVx * chaseDamp;
      p.chaseVx += aChase * dt;
      p.chaseX += p.chaseVx * dt;

      const aScale = (targetScale - p.scale) * 380 - p.scaleV * 34;
      p.scaleV += aScale * dt;
      p.scale += p.scaleV * dt;

      applyTransform();

      const settled =
        !dragging &&
        Math.abs(targetX - p.x) < 0.08 &&
        Math.abs(p.vx) < 0.5 &&
        Math.abs(p.x - p.chaseX) < 0.08 &&
        Math.abs(p.chaseVx) < 0.5 &&
        Math.abs(targetScale - p.scale) < 0.005;

      if (settled) {
        p.x = targetX;
        p.vx = 0;
        p.chaseX = targetX;
        p.chaseVx = 0;
        p.scale = targetScale;
        p.scaleV = 0;
        p.raf = 0;
        p.lastTime = 0;
        applyTransform();
      } else {
        p.raf = window.requestAnimationFrame(step);
      }
    };

    if (!physicsRef.current.raf) {
      physicsRef.current.lastTime = 0;
      physicsRef.current.raf = window.requestAnimationFrame(step);
    }
  };

  useEffect(() => {
    const targetX = checked ? endX : startX;
    const targetScale = hovered ? 1.04 : 1;
    startSpringLoop(targetX, targetScale);
  }, [checked, hovered, dragging, endX, startX]);

  useEffect(() => {
    applyTransform();
    return () => {
      if (physicsRef.current.raf && typeof window !== "undefined") {
        window.cancelAnimationFrame(physicsRef.current.raf);
      }
    };
  }, []);

  const toLocalX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const scale = rect.width / (el.offsetWidth || rect.width) || 1;
    return (clientX - rect.left) / scale;
  };

  return (
    <div
      ref={trackRef}
      className="liq-sw"
      data-on={checked}
      data-size={size}
      data-disabled={disabled || undefined}
      style={
        {
          "--liq-thumb": `${thumbSize}px`,
          "--liq-drop": `${dropSize}px`,
        } as React.CSSProperties
      }
      onPointerEnter={() => !disabled && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        dragRef.current = {
          pointerId: e.pointerId,
          grabOffset: null,
          moved: false,
        };
        setDragging(true);
        try {
          trackRef.current?.setPointerCapture(e.pointerId);
        } catch {
          // ignore in non-pointer environments
        }
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId || disabled) return;
        const localX = toLocalX(e.clientX);
        if (d.grabOffset === null) {
          d.grabOffset = localX - physicsRef.current.x;
        }
        const nextX = clamp(localX - d.grabOffset, startX, endX);
        if (Math.abs(nextX - physicsRef.current.x) > 0.6) {
          d.moved = true;
        }
        physicsRef.current.vx = (nextX - physicsRef.current.x) * 42;
        physicsRef.current.x = nextX;
        startSpringLoop(nextX, hovered ? 1.04 : 1);
        const nextChecked = nextX > midX;
        if (nextChecked !== checked) {
          onChange(nextChecked);
        }
      }}
      onPointerUp={(e) => {
        const d = dragRef.current;
        if (!d) return;
        dragRef.current = null;
        try {
          trackRef.current?.releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }
        setDragging(false);
      }}
      onPointerCancel={(e) => {
        if (!dragRef.current) return;
        dragRef.current = null;
        try {
          trackRef.current?.releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }
        setDragging(false);
      }}
    >
      {!gooFilterMounted && <LiquidGooFilter />}
      <span className="liq-sw-blobs" aria-hidden="true">
        <span ref={dropRef} className="liq-drop" />
        <span ref={thumbRef} className="liq-thumb" />
      </span>
      <input
        id={inputId}
        type="checkbox"
        role="switch"
        className="liq-native-input"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        onChange={(e) => {
          if (dragRef.current?.moved) return;
          onChange(e.target.checked);
        }}
      />
    </div>
  );
}
