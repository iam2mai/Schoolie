import type { ReactNode } from "react";
import Nav from "./nav.tsx";
import "./globals.css";

export const metadata = {
  title: "School Letters",
  description: "Ask questions about your child's school letters and track their dates.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <h1>School Letters</h1>
          <Nav />
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
