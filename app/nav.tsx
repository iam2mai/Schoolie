"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "./lib/client.ts";

const TABS = [
  { href: "/", label: "Ask" },
  { href: "/dates", label: "Dates" },
  { href: "/letters", label: "Letters" },
];

export default function Nav() {
  const pathname = usePathname();
  // No nav or logout on the login page.
  if (pathname === "/login") return null;

  async function logout() {
    await api("/api/logout", { method: "POST", body: {} }).catch(() => {});
    window.location.assign("/login");
  }

  return (
    <nav>
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} aria-current={pathname === t.href ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
      <button type="button" className="link" onClick={logout}>
        Log out
      </button>
    </nav>
  );
}
