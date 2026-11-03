import type { Metadata } from "next";
import { Gloock, IBM_Plex_Mono, Source_Serif_4 } from "next/font/google";
import "./globals.css";

const display = Gloock({ variable: "--font-display", subsets: ["latin"], weight: "400" });
const text = Source_Serif_4({ variable: "--font-text", subsets: ["latin"], weight: ["400", "600"], style: ["normal", "italic"] });
const mono = IBM_Plex_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Autopsy: why the money went wrong",
  description:
    "A reconciliation agent for Airwallex. It lays the books against the bank, proves why each break happened, and fixes it without paying twice.",
  icons: { icon: "/mark.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${text.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
