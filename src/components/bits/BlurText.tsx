'use client';

import { motion, Transition, Easing } from 'motion/react';
import { useEffect, useRef, useState, useMemo, useSyncExternalStore } from 'react';

// Mobile-first perf gate: animate only when motion is allowed AND there's room.
// Phones / reduced-motion get the static, instant-paint copy instead of the
// per-word blur-in (the hero "jitter"). useSyncExternalStore — not setState in
// an effect (the repo lint forbids that) — keeps SSR and the first client
// render identical, then the real preference takes over right after mount.
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const SMALL_SCREEN_QUERY = '(max-width: 767px)';
const subscribeHeroMotion = (onChange: () => void) => {
  const reduced = window.matchMedia(REDUCED_MOTION_QUERY);
  const small = window.matchMedia(SMALL_SCREEN_QUERY);
  reduced.addEventListener('change', onChange);
  small.addEventListener('change', onChange);
  return () => {
    reduced.removeEventListener('change', onChange);
    small.removeEventListener('change', onChange);
  };
};
const getHeroMotion = () =>
  !(
    window.matchMedia(REDUCED_MOTION_QUERY).matches ||
    window.matchMedia(SMALL_SCREEN_QUERY).matches
  );
// Server / hydration snapshot: assume motion on, matching the pre-change markup.
const getHeroMotionServer = () => true;

type BlurTextProps = {
  text?: string;
  delay?: number;
  className?: string;
  animateBy?: 'words' | 'letters';
  direction?: 'top' | 'bottom';
  threshold?: number;
  rootMargin?: string;
  animationFrom?: Record<string, string | number>;
  animationTo?: Array<Record<string, string | number>>;
  easing?: Easing | Easing[];
  onAnimationComplete?: () => void;
  stepDuration?: number;
};

const buildKeyframes = (
  from: Record<string, string | number>,
  steps: Array<Record<string, string | number>>
): Record<string, Array<string | number>> => {
  const keys = new Set<string>([...Object.keys(from), ...steps.flatMap(s => Object.keys(s))]);

  const keyframes: Record<string, Array<string | number>> = {};
  keys.forEach(k => {
    keyframes[k] = [from[k], ...steps.map(s => s[k])];
  });
  return keyframes;
};

const BlurText: React.FC<BlurTextProps> = ({
  text = '',
  delay = 200,
  className = '',
  animateBy = 'words',
  direction = 'top',
  threshold = 0.1,
  rootMargin = '0px',
  animationFrom,
  animationTo,
  easing = (t: number) => t,
  onAnimationComplete,
  stepDuration = 0.35
}) => {
  const elements = animateBy === 'words' ? text.split(' ') : text.split('');
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  const motionOn = useSyncExternalStore(
    subscribeHeroMotion,
    getHeroMotion,
    getHeroMotionServer,
  );

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.unobserve(ref.current as Element);
        }
      },
      { threshold, rootMargin }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [threshold, rootMargin]);

  const defaultFrom = useMemo(
    () =>
      direction === 'top' ? { filter: 'blur(10px)', opacity: 0, y: -50 } : { filter: 'blur(10px)', opacity: 0, y: 50 },
    [direction]
  );

  const defaultTo = useMemo(
    () => [
      {
        filter: 'blur(5px)',
        opacity: 0.5,
        y: direction === 'top' ? 5 : -5
      },
      { filter: 'blur(0px)', opacity: 1, y: 0 }
    ],
    [direction]
  );

  const fromSnapshot = animationFrom ?? defaultFrom;
  const toSnapshots = animationTo ?? defaultTo;

  const stepCount = toSnapshots.length + 1;
  const totalDuration = stepDuration * (stepCount - 1);
  const times = Array.from({ length: stepCount }, (_, i) => (stepCount === 1 ? 0 : i / (stepCount - 1)));

  return (
    <p ref={ref} className={`blur-text ${className} flex flex-wrap`}>
      {elements.map((segment, index) => {
        const animateKeyframes = buildKeyframes(fromSnapshot, toSnapshots);

        const spanTransition: Transition = {
          duration: totalDuration,
          times,
          delay: (index * delay) / 1000,
          ease: easing
        };

        return (
          <motion.span
            key={index}
            initial={motionOn ? fromSnapshot : false}
            animate={
              motionOn
                ? inView
                  ? animateKeyframes
                  : fromSnapshot
                : { filter: 'blur(0px)', opacity: 1, y: 0 }
            }
            transition={motionOn ? spanTransition : { duration: 0 }}
            onAnimationComplete={index === elements.length - 1 ? onAnimationComplete : undefined}
            style={{
              display: 'inline-block',
              willChange: 'transform, filter, opacity'
            }}
          >
            {segment === ' ' ? '\u00A0' : segment}
            {animateBy === 'words' && index < elements.length - 1 && '\u00A0'}
          </motion.span>
        );
      })}
    </p>
  );
};

export default BlurText;
