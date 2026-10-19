"use client";

import { useRef, useState } from "react";
import { startDemo } from "@/app/auth/actions";
import { loginErrorMessage } from "@/lib/auth/errors";
import { createBrowserSupabase } from "@/lib/supabase/client";

// "Demo starten" (block F2, ADR 0012). The Turnstile script loads only after the click, so
// visitors who use GitHub never reach Cloudflare. Supabase checks the token (built-in
// captcha); without a site key (local, CI) the sign-in runs without one and Supabase decides.

interface Turnstile {
  render: (el: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "error-callback": () => void }) => void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

function loadTurnstile(): Promise<Turnstile> {
  return new Promise((resolve, reject) => {
    if (window.turnstile) {
      resolve(window.turnstile);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile")));
    script.onerror = () => reject(new Error("turnstile"));
    document.head.appendChild(script);
  });
}

export function DemoButton({ siteKey }: { siteKey: string | null }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const widget = useRef<HTMLDivElement>(null);
  // One widget per page and one sign-in per click: Turnstile can call back again (refresh of
  // an expired token), and every extra call would create another anonymous user.
  const rendered = useRef(false);
  const signingIn = useRef(false);

  function fail() {
    signingIn.current = false;
    setFailed(true);
    setBusy(false);
  }

  async function signIn(captchaToken?: string) {
    if (signingIn.current) return;
    signingIn.current = true;
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
    if (error) {
      fail();
      return;
    }
    try {
      await startDemo();
    } catch (e) {
      // redirect() from the server action surfaces as a thrown navigation signal; let it pass.
      if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) {
        throw e;
      }
      fail();
    }
  }

  async function onClick() {
    setBusy(true);
    setFailed(false);
    if (!siteKey) {
      await signIn();
      return;
    }
    if (rendered.current) return; // the widget is already on the page and calls back itself
    try {
      const turnstile = await loadTurnstile();
      if (!widget.current) throw new Error("turnstile");
      rendered.current = true;
      turnstile.render(widget.current, {
        sitekey: siteKey,
        callback: (token) => void signIn(token),
        "error-callback": fail,
      });
    } catch {
      fail();
    }
  }

  return (
    <div className="demo">
      <button type="button" onClick={onClick} disabled={busy}>
        Demo starten (ohne Anmeldung)
      </button>
      <p>Die Demo-Daten werden nach 24 Stunden gelöscht.</p>
      <div ref={widget} />
      {failed ? <p role="alert">{loginErrorMessage("sicherheitspruefung")}</p> : null}
    </div>
  );
}
