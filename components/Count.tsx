"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A formatted amount, like "EUR 1,204.50", that adds itself up from zero when it
 * scrolls into view. The server renders the final figure, so the page reads the
 * same without scripts or with reduced motion.
 */
export function Count({ value, ms = 1400 }: { value: string; ms?: number }) {
  const [shown, setShown] = useState(value);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    const m = value.match(/^(.*?)([\d,]+(?:\.(\d+))?)(.*)$/);
    if (!el || !m || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const [, pre, num, dec = "", post] = m;
    const target = Number(num.replace(/,/g, ""));
    const at = (n: number) =>
      pre + n.toLocaleString("en-US", { minimumFractionDigits: dec.length, maximumFractionDigits: dec.length }) + post;

    let frame = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const p = Math.min(1, (now - start) / ms);
          setShown(at(target * (1 - (1 - p) ** 3)));
          if (p < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    setShown(at(0));
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
      setShown(value);
    };
  }, [value, ms]);

  return <span ref={ref}>{shown}</span>;
}
