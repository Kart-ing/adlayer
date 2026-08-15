/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The AdLayer contract (src/contract.ts) lives above this app's root; allow
  // Next's build tracing to reach it so `web/lib/contract.ts` can re-export it.
  experimental: {
    outputFileTracingRoot: process.cwd() + "/..",
  },
};

export default nextConfig;
