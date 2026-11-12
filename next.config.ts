import type { NextConfig } from "next";

// @libsql/client حزمة خارجية (لا تُجمَّع) لتجنّب مشاكل الربط الأصلي في بيئة السيرفرلس
const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client"],
};

export default nextConfig;
