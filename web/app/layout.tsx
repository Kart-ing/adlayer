import type { Metadata } from "next";
import "./globals.css";
import { loadState } from "../lib/state";

export const metadata: Metadata = {
  title: "AdLayer — the ad network for the answer layer",
  description:
    "Disclosed sponsored placements in llms.txt, and measurement of whether the label survives the model.",
};

const NAV = [
  { href: "/", label: "advertise" },
  { href: "/checkout", label: "checkout" },
  { href: "/dashboard", label: "dashboard" },
  { href: "/disclosure", label: "disclosure" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const state = await loadState().catch(() => null);
  return (
    <html lang="en">
      <body>
        {state?._fixture ? (
          <div className="fixture-banner" role="status">
            FIXTURE DATA — this deployment renders committed sample state. Not live results.
          </div>
        ) : null}
        <header className="topbar">
          <div className="topbar-inner">
            <span className="brand">
              AdLayer<span className="sub">the ad network for the answer layer</span>
            </span>
            <nav className="main" aria-label="Primary">
              {NAV.map((n) => (
                <a key={n.href} href={n.href}>
                  {n.label}
                </a>
              ))}
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
