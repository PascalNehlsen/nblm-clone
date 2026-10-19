"use client";

import { useEffect } from "react";

// Replaces the browser's validation bubbles and hover tooltips with the app's own message
// below the field. The browser still validates (required, type, maxLength); this only changes
// how the result is shown. Empty title attributes stop Firefox's hover tooltip on invalid fields.

function message(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  const v = field.validity;
  if (v.valueMissing) return field instanceof HTMLInputElement && field.type === "file" ? "Bitte wähl eine Datei aus." : "Bitte füll dieses Feld aus.";
  if (v.typeMismatch && field instanceof HTMLInputElement && field.type === "url") return "Bitte gib eine gültige Webadresse ein.";
  if (v.tooLong) return "Das ist zu lang.";
  return "Bitte prüf diese Eingabe.";
}

let counter = 0;

function clear(field: Element) {
  const id = field.getAttribute("aria-describedby");
  if (id?.startsWith("feld-fehler-")) {
    document.getElementById(id)?.remove();
    field.removeAttribute("aria-describedby");
  }
  field.removeAttribute("aria-invalid");
}

export function FormValidation() {
  useEffect(() => {
    const quiet = (root: ParentNode) => {
      root.querySelectorAll("input:not([title]), textarea:not([title]), select:not([title])").forEach((el) => el.setAttribute("title", ""));
    };
    quiet(document);
    const observer = new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach((n) => n instanceof Element && quiet(n.parentNode ?? n));
    });
    observer.observe(document.body, { childList: true, subtree: true });

    let focused = false;
    const onInvalid = (e: Event) => {
      const field = e.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return;
      e.preventDefault();
      clear(field);
      const note = document.createElement("p");
      note.id = `feld-fehler-${++counter}`;
      note.className = "field-error";
      note.setAttribute("role", "alert");
      note.textContent = message(field);
      (field.closest("label") ?? field).insertAdjacentElement("afterend", note);
      field.setAttribute("aria-invalid", "true");
      field.setAttribute("aria-describedby", note.id);
      if (!focused) {
        focused = true;
        field.focus();
        queueMicrotask(() => (focused = false));
      }
    };
    const onInput = (e: Event) => {
      if (e.target instanceof Element && e.target.getAttribute("aria-invalid") === "true") clear(e.target);
    };
    document.addEventListener("invalid", onInvalid, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onInput, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("invalid", onInvalid, true);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("change", onInput, true);
    };
  }, []);
  return null;
}
