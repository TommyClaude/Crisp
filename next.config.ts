import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Avatars and attachments intentionally render via plain <img>, not
  // next/image: Crisp file URLs are signed, short-lived and can point at
  // arbitrary hosts, which the image optimizer would reject.
  async redirects() {
    return [
      // The Crisp section lives under /crisp since the YayAssist reframing.
      { source: "/crisp", destination: "/crisp/dashboard", permanent: false },
      {
        source: "/conversations",
        destination: "/crisp/conversations",
        permanent: false,
      },
      {
        source: "/conversations/:sessionId",
        destination: "/crisp/conversations/:sessionId",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
