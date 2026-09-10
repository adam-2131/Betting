import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Without this, Next walks up and finds the lockfile in the home directory, then treats that as
  // the workspace root and traces far more of the filesystem than it needs to.
  outputFileTracingRoot: import.meta.dirname,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "polymarket-upload.s3.us-east-2.amazonaws.com" },
    ],
  },
};

export default nextConfig;
