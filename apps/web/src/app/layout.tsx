import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Anton, Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Anton({ weight: "400", subsets: ["latin"], variable: "--font-display", display: "swap" });
const sans = Archivo({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "NecroLegacy · Digital autopsy workbench",
  description: "Digital autopsy workbench for legacy data and documents.",
};

export const viewport: Viewport = { themeColor: "#14120F", colorScheme: "dark" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
