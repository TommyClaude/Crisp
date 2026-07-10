import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Crisp-hosted avatars and file attachments are served from these hosts.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "image.crisp.chat" },
      { protocol: "https", hostname: "storage.crisp.chat" },
      { protocol: "https", hostname: "client.crisp.chat" },
    ],
  },
};

export default nextConfig;
