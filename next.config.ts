import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Avatars and attachments intentionally render via plain <img>, not
  // next/image: Crisp file URLs are signed, short-lived and can point at
  // arbitrary hosts, which the image optimizer would reject.
};

export default nextConfig;
