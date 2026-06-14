'use client';

// react-bits Dock (TS-TW registry), adapted for SnapList's mobile bottom
// tabs: items are real next/link anchors (not role="button" divs) so routing,
// prefetch, and aria-current survive; light surface + violet active state
// replace the dark default; magnification is kept for pointer devices and
// collapses to nothing under prefers-reduced-motion. Labels render as the
// original's hover tooltip on pointer devices; every link carries aria-label.
import {
  motion,
  MotionValue,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type SpringOptions,
  AnimatePresence
} from 'motion/react';
import Link from 'next/link';
import React, { useRef, useState } from 'react';

export type DockNavItem = {
  icon: React.ReactNode;
  label: string;
  href: string;
  active?: boolean;
};

export type DockProps = {
  items: DockNavItem[];
  className?: string;
  distance?: number;
  baseItemSize?: number;
  magnification?: number;
  spring?: SpringOptions;
};

function DockItem({
  item,
  mouseX,
  spring,
  distance,
  magnification,
  baseItemSize
}: {
  item: DockNavItem;
  mouseX: MotionValue<number>;
  spring: SpringOptions;
  distance: number;
  magnification: number;
  baseItemSize: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  const mouseDistance = useTransform(mouseX, val => {
    const rect = ref.current?.getBoundingClientRect() ?? {
      x: 0,
      width: baseItemSize
    };
    return val - rect.x - baseItemSize / 2;
  });

  const targetSize = useTransform(
    mouseDistance,
    [-distance, 0, distance],
    [baseItemSize, magnification, baseItemSize]
  );
  const size = useSpring(targetSize, spring);

  return (
    <motion.div
      ref={ref}
      style={{ width: size, height: size }}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      className="relative flex items-end justify-center"
    >
      <DockLabel visible={hovered}>{item.label}</DockLabel>
      <motion.span
        className="block size-full"
        whileTap={{ scale: 0.88 }}
        transition={{ duration: 0.12 }}
      >
        <Link
          href={item.href}
          aria-label={item.label}
          aria-current={item.active ? 'page' : undefined}
          className={`flex size-full items-center justify-center rounded-full border transition-colors ${
            item.active
              ? 'border-accent bg-accent text-white shadow-md'
              : 'border-border bg-surface-2 text-muted hover:text-fg-strong'
          }`}
        >
          {item.icon}
        </Link>
      </motion.span>
    </motion.div>
  );
}

function DockLabel({ children, visible }: { children: React.ReactNode; visible: boolean }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 0 }}
          animate={{ opacity: 1, y: -8 }}
          exit={{ opacity: 0, y: 0 }}
          transition={{ duration: 0.18 }}
          className="absolute -top-7 left-1/2 w-fit whitespace-pre rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-fg-strong shadow-sm"
          role="tooltip"
          style={{ x: '-50%' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default function Dock({
  items,
  className = '',
  spring = { mass: 0.1, stiffness: 180, damping: 14 },
  magnification = 58,
  distance = 110,
  baseItemSize = 44
}: DockProps) {
  const mouseX = useMotionValue(Infinity);
  const reduced = useReducedMotion();
  const magnify = reduced ? baseItemSize : magnification;

  return (
    <div
      onMouseMove={e => mouseX.set(e.pageX)}
      onMouseLeave={() => mouseX.set(Infinity)}
      className={`flex items-end justify-evenly gap-3 rounded-2xl border border-border bg-surface/95 px-4 pb-1.5 pt-1.5 shadow-lg backdrop-blur ${className}`}
    >
      {items.map(item => (
        <DockItem
          key={item.href}
          item={item}
          mouseX={mouseX}
          spring={spring}
          distance={distance}
          magnification={magnify}
          baseItemSize={baseItemSize}
        />
      ))}
    </div>
  );
}
