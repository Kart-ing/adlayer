import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AdLayer — quick study",
  description: "Read an assistant answer and answer two short questions.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="page">{children}</div>
      </body>
    </html>
  );
}
