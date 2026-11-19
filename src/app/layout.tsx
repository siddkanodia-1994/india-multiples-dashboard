import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "India Multiples",
  description: "Valuation-multiple bands (PE, P/BV, Mcap/Sales, EV/EBITDA) for Indian listed companies.",
  // Anyone with the link can edit everything (no logins), so keep it out of search engines.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
