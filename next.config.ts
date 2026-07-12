import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-hosting kit (docker/): the production image runs the standalone
  // server (.next/standalone/server.js), which needs `output: "standalone"`.
  // Gated behind an env flag so plain local `npm run dev` / `npm run build`
  // (no Docker) keep producing the regular build — see Dockerfile.
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" } : {}),
  // imapflow (the wp.org email-push listener's IMAP client) is a Node-only
  // package that pulls in core modules like `stream`/`net`/`tls`. Keep it out
  // of the webpack bundle so those never need polyfilling — it's required at
  // runtime on the Node.js server, where the listener is started from
  // instrumentation.ts.
  serverExternalPackages: ["imapflow"],
  webpack: (config, { nextRuntime }) => {
    // instrumentation.ts is also compiled for the Edge runtime, whose graph
    // must never pull in imapflow (it's loaded behind a NEXT_RUNTIME==="nodejs"
    // guard and only used on the Node server). Mark it external everywhere but
    // Node so the Edge/neutral build doesn't try to resolve its Node built-ins.
    if (nextRuntime !== "nodejs") {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        "imapflow",
      ];
    }
    return config;
  },
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
