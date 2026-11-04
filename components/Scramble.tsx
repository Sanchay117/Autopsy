"use client";

import { useEffect, useRef, useState } from "react";

const HEX = "0123456789abcdef";

/**
 * A hash worked out in front of you: once it is in view, every hex digit
 * cycles and settles left to right. The server renders the real value.
 */
export function Scramble({ text, delay = 0, ms = 1100 }: { text: string; delay?: number; ms?: number }) {
  const [shown, setShown] = useState(text);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let timer = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      timer = window.setTimeout(() => {
        const start = performance.now();
        const tick = (now: number) => {
          const p = Math.min(1, (now - start) / ms);
          const settled = Math.floor(p * text.length);
          setShown(
            [...text].map((c, i) => (i < settled || !HEX.includes(c.toLowerCase()) ? c : HEX[Math.floor(Math.random() * 16)])).join(""),
          );
          if (p < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      }, delay);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      setShown(text);
    };
  }, [text, delay, ms]);

  return <b ref={ref}>{shown}</b>;
}
