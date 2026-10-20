"use client";

import { useEffect, useState } from "react";

// Immediate feedback for every navigation: a thin bar at the top starts on a click on an
// internal link or on a form submit and ends when the address changes (Next.js updates it once
// the new page is there). A safety timeout ends it if nothing navigates.
export function NavProgress() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let watch: ReturnType<typeof setInterval> | undefined;
    let safety: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      clearInterval(watch);
      clearTimeout(safety);
      setActive(false);
    };
    const start = () => {
      stop();
      const from = window.location.href;
      setActive(true);
      watch = setInterval(() => {
        if (window.location.href !== from) stop();
      }, 100);
      safety = setTimeout(stop, 15000);
    };
    const onClick = (e: MouseEvent) => {
      // Capture phase: Next.js's <Link> calls preventDefault() on the same click for its own
      // client navigation, so this listener runs first and does not look at defaultPrevented.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      start();
    };
    const onSubmit = (e: SubmitEvent) => {
      if (!e.defaultPrevented) start();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit);
    window.addEventListener("popstate", stop);
    return () => {
      stop();
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit);
      window.removeEventListener("popstate", stop);
    };
  }, []);

  return <div className="nav-progress" data-active={active ? "" : undefined} aria-hidden="true" />;
}
