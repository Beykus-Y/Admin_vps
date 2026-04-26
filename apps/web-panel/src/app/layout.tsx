import type { Metadata } from "next";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";

export const metadata: Metadata = {
  title: "FilinControl",
  description: "Панель управления VPS-инфраструктурой",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
