import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FilinControl",
  description: "VPS Management Panel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
