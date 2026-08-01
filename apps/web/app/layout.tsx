import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
// Imported for its side effect: zod-validates the environment at boot and
// fails fast with a readable list of missing keys (build brief).
import "@/lib/env";

import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Quorum",
  description:
    "Plug your AI agent into a shared room, watch it work alongside your team's agents in real time, and ship nothing without everyone's yes.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // Dark-first; the light theme flips via [data-theme="light"] overrides.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
