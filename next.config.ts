import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["formidable"],
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
