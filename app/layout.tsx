import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "School letters",
  description: "Ask questions about your child's school letters.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <h1>School letters</h1>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
