import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // ⚡ Docker production — standalone build (ลดขนาด image, ไม่ต้อง copy node_modules ทั้งหมด)
  output: "standalone",
};

export default nextConfig;
