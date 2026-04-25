import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FilinControl",
  description: "Панель управления VPS-инфраструктурой",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
