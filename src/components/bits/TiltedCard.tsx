'use client';

/**
 * TiltedCard (react-bits, adapted): upstream is image-only with a tooltip and
 * a mobile warning banner. SnapList's version keeps the spring-tilt physics
 * but takes arbitrary children (our platform listing cards), drops the
 * tooltip/warning, and disables itself under prefers-reduced-motion.
 */

import type { SpringOptions } from 'motion/react';
import { useRef } from 'react';
import { motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react';

interface TiltedCardProps {
  children: React.ReactNode;
  className?: string;
  scaleOnHover?: number;
  rotateAmplitude?: number;
}

const springValues: SpringOptions = {
  damping: 30,
  stiffness: 100,
  mass: 2
};

export default function TiltedCard({
  children,
  className = '',
  scaleOnHover = 1.04,
  rotateAmplitude = 10
}: TiltedCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const rotateX = useSpring(useMotionValue(0), springValues);
  const rotateY = useSpring(useMotionValue(0), springValues);
  const scale = useSpring(1, springValues);

  function handleMouse(e: React.MouseEvent<HTMLDivElement>) {
    if (!ref.current || reducedMotion) return;

    const rect = ref.current.getBoundingClientRect();
    const offsetX = e.clientX - rect.left - rect.width / 2;
    const offsetY = e.clientY - rect.top - rect.height / 2;

    rotateX.set((offsetY / (rect.height / 2)) * -rotateAmplitude);
    rotateY.set((offsetX / (rect.width / 2)) * rotateAmplitude);
  }

  function handleMouseEnter() {
    if (reducedMotion) return;
    scale.set(scaleOnHover);
  }

  function handleMouseLeave() {
    scale.set(1);
    rotateX.set(0);
    rotateY.set(0);
  }

  return (
    <div
      ref={ref}
      className={`[perspective:800px] ${className}`}
      onMouseMove={handleMouse}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <motion.div
        className="h-full [transform-style:preserve-3d] will-change-transform"
        style={{ rotateX, rotateY, scale }}
      >
        {children}
      </motion.div>
    </div>
  );
}
