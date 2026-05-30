import type { NextConfig } from "next";

// Kept minimal on purpose. The Netlify Next.js Runtime auto-discovers the
// app and handles SSR / image optimization / function bundling out of the
// box — we don't need `output: "standalone"` for Netlify deploys.
//
// Add `images.remotePatterns` here ONLY if a future change starts pulling
// images via next/image from a remote origin. The current app uses only
// /public assets and SVG-inlined icons.
const nextConfig: NextConfig = {
  // reactStrictMode defaults to `true` in App Router for Next.js 13+, so
  // we don't set it explicitly. If we ever add Pages Router routes we'll
  // need to add `reactStrictMode: true` to keep the strict checks on.
};

export default nextConfig;
