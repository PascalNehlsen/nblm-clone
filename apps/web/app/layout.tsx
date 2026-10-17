import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "nblm-clone",
  description: "Quellen hochladen, Fragen stellen, Antworten mit belegten Zitaten erhalten.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>
        <header>
          <strong>nblm-clone</strong>
        </header>
        {children}
      </body>
    </html>
  );
}
