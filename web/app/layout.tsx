import type { Metadata } from "next";
import "./globals.css";
import { loadState } from "../lib/state";

export const metadata: Metadata = {
  title: "AdLayer — advertise in the answer layer",
  description:
    "Sell clearly-labeled sponsored placements in llms.txt, enforce disclosure in code, and measure whether the label survives the model.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const state = await loadState().catch(() => null);
  return (
    <html lang="en">
      <body>
        {state?._fixture ? (
          <div className="fixture-banner" role="status">
            Demo environment · sample data. Live results replace this on a real run.
          </div>
        ) : null}
        <header className="nav">
          <div className="nav-inner">
            <a className="logo" href="/">
              <span className="mark" />
              AdLayer
            </a>
            <nav className="nav-links" aria-label="Primary">
              <a className="hide-sm" href="/dashboard">
                Live data
              </a>
              <a className="hide-sm" href="/disclosure">
                Disclosure
              </a>
              <a className="btn btn-primary btn-sm" href="/sponsor">
                Sponsor a placement
              </a>
            </nav>
          </div>
        </header>
        {children}
        <footer>
          <div className="footer-inner">
            <span className="logo" style={{ fontSize: 14 }}>
              <span className="mark" style={{ width: 16, height: 16 }} />
              AdLayer
            </span>
            <span>The ad network for the answer layer.</span>
            <span style={{ marginLeft: "auto" }}>
              <a href="/disclosure">Disclosure policy</a> · disclosed by design
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
