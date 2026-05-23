import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vietnamese Pronunciation Assessment",
  description: "Pronunciation assessment with Azure Speech SDK",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
