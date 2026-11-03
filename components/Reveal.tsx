"use client";

import { useEffect } from "react";

/**
 * Marks [data-reveal] sections once they enter the viewport, so their motion
 * starts there. Content is only held back under html.js, so the page still
 * reads with scripts off. Also marks the page once it scrolls, for the bar.
 */
export function Reveal() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("js");
    const onScroll = () => root.toggleAttribute("data-scrolled", window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    const els = document.querySelectorAll<HTMLElement>("[data-reveal]");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.setAttribute("data-seen", "");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -15% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return null;
}
