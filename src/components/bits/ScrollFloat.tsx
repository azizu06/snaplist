'use client';

/**
 * ScrollFloat (react-bits, adapted): per-character float-in for section
 * headings. SnapList changes: an `accentWords` prop colors matching words
 * iris-violet (our headings always carry one accent phrase), the animation
 * plays ONCE on entry instead of scrubbing (scrubbed headings sit invisible
 * at rest), proper ScrollTrigger cleanup, and a reduced-motion bail-out.
 */

import React, { useEffect, useMemo, useRef, RefObject } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

interface ScrollFloatProps {
  children: string;
  scrollContainerRef?: RefObject<HTMLElement>;
  containerClassName?: string;
  textClassName?: string;
  /** Words rendered in the iris accent color (matched case-insensitively). */
  accentWords?: string[];
  animationDuration?: number;
  ease?: string;
  scrollStart?: string;
  stagger?: number;
}

const ScrollFloat: React.FC<ScrollFloatProps> = ({
  children,
  scrollContainerRef,
  containerClassName = '',
  textClassName = '',
  accentWords = [],
  animationDuration = 0.9,
  ease = 'back.out(1.6)',
  scrollStart = 'top bottom-=15%',
  stagger = 0.03
}) => {
  const containerRef = useRef<HTMLHeadingElement>(null);

  const splitText = useMemo(() => {
    const accents = new Set(accentWords.map(w => w.toLowerCase()));
    return children.split(/(\s+)/).map((word, wordIndex) => {
      if (/^\s+$/.test(word)) return ' ';
      const isAccent = accents.has(word.toLowerCase().replace(/[.,!?]/g, ''));
      return (
        <span className="inline-block whitespace-nowrap" key={wordIndex}>
          {word.split('').map((char, charIndex) => (
            <span
              className={`scroll-float-char inline-block ${isAccent ? 'text-iris' : ''}`}
              key={charIndex}
            >
              {char}
            </span>
          ))}
        </span>
      );
    });
  }, [children, accentWords]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const scroller = scrollContainerRef && scrollContainerRef.current ? scrollContainerRef.current : window;

    const charElements = el.querySelectorAll('.scroll-float-char');

    const tween = gsap.fromTo(
      charElements,
      {
        willChange: 'opacity, transform',
        opacity: 0,
        yPercent: 120,
        scaleY: 2.3,
        scaleX: 0.7,
        transformOrigin: '50% 0%'
      },
      {
        duration: animationDuration,
        ease: ease,
        opacity: 1,
        yPercent: 0,
        scaleY: 1,
        scaleX: 1,
        stagger: stagger,
        scrollTrigger: {
          trigger: el,
          scroller,
          start: scrollStart,
          once: true
        }
      }
    );

    return () => {
      tween.scrollTrigger?.kill();
      tween.kill();
    };
  }, [scrollContainerRef, animationDuration, ease, scrollStart, stagger, children]);

  return (
    <h2 ref={containerRef} className={`overflow-hidden ${containerClassName}`}>
      <span className={`inline-block ${textClassName}`}>{splitText}</span>
    </h2>
  );
};

export default ScrollFloat;
