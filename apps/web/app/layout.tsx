import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { FormValidation } from "@/components/form-validation";
import { PointerLight } from "@/components/pointer-light";
import "./globals.css";

export const metadata: Metadata = {
  title: "nblm-clone",
  description: "Quellen hochladen, Fragen stellen, Antworten mit belegten Zitaten erhalten.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f3ea" },
    { media: "(prefers-color-scheme: dark)", color: "#15130f" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>
        <a className="skip" href="#inhalt">
          Zum Inhalt springen
        </a>
        <header className="topbar">
          <Link href="/" className="brand">
            <Logo /> nblm
          </Link>
        </header>
        {children}
        <PointerLight />
        <FormValidation />
      </body>
    </html>
  );
}
