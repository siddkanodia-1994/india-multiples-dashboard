import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Excel export is a Vercel Python function (api/export.py). In local dev,
  // `python3 api/export.py` serves it on port 3010 and this forwards to it.
  async rewrites() {
    return process.env.NODE_ENV === "development" ? [{ source: "/api/export", destination: "http://127.0.0.1:3010/api/export" }] : [];
  },
};

export default nextConfig;
