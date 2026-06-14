import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output is what the Dockerfile's runtime stage copies (a
  // self-contained server.js + pruned node_modules). Gated behind an env flag
  // set by the Docker build so the Vercel deploy path keeps Next's default
  // output untouched.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  images: {
    // next/image resizes every source down to each slot's `sizes` and serves
    // AVIF first (smallest), then WebP, so large source photos never ship at
    // full resolution. This is what keeps a richly-populated carousel fast —
    // do NOT hand-convert /public images to WebP, it bypasses this resizer.
    formats: ["image/avif", "image/webp"],
  },
  experimental: {
    serverActions: {
      // Phone photos routinely exceed Next's 1 MB Server Action body default, which
      // would reject the core upload flow before it runs. The `photos` Storage bucket
      // allows up to 50 MiB, so lift the request-body cap to match.
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
