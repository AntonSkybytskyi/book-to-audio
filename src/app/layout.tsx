import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PoolBanner } from "@/ui/features/pool/PoolBanner";
import { SiteHeader } from "./SiteHeader";
// oxlint-disable-next-line import/no-unassigned-import -- global stylesheet
import "./globals.css";

export const metadata: Metadata = {
  title: "book-to-audio",
  description: "Convert e-books to audiobooks",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        <PoolBanner />
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
