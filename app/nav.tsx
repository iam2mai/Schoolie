"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Ask" },
  { href: "/dates", label: "Dates" },
  { href: "/letters", label: "Letters" },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav>
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} aria-current={pathname === t.href ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
