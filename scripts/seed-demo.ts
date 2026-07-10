/**
 * Seed the database with realistic FAKE Crisp payloads for local development
 * and UI testing — runs them through the real sync pipeline (normalization,
 * upserts, file extraction, chunk building) without touching the Crisp API.
 *
 *   npm run seed:demo
 */
import "dotenv/config";
import { createHash } from "crypto";
import { prisma } from "../src/lib/db";
import { invalidateProductDefinitions } from "../src/lib/rag/product-defs";
import { syncConversationPayload } from "../src/lib/sync/sync-service";
import { rebuildChunksForConversation } from "../src/lib/rag/rebuild";
import type { CrispConversation, CrispMessage } from "../src/lib/crisp/types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** Demo brands — one per (fake) Crisp website, mirroring a real multi-brand setup. */
const DEMO_BRANDS = [
  {
    slug: "demo-yaycommerce",
    name: "YayCommerce",
    domain: "yaycommerce.com",
    crispWebsiteId: "demo-website-yaycommerce",
    plugins: [
      { name: "YayMail", slug: "demo-yaymail", keywords: ["yay mail"], wpOrgSlug: "yaymail" },
      { name: "YayCurrency", slug: "demo-yaycurrency", keywords: ["yay currency"], wpOrgSlug: "yaycurrency" },
      { name: "YaySMTP", slug: "demo-yaysmtp", keywords: ["yay smtp"], wpOrgSlug: "yaysmtp" },
    ],
  },
  {
    slug: "demo-ninjateam",
    name: "Ninja Team",
    domain: "ninjateam.org",
    crispWebsiteId: "demo-website-ninjateam",
    plugins: [
      { name: "FileBird", slug: "demo-filebird", keywords: ["file bird", "njt-filebird"], wpOrgSlug: "filebird" },
    ],
  },
] as const;

/** Fake docs pages so RAG search demonstrates mixed chat+docs retrieval. */
const DEMO_DOCS: Array<{
  plugin: string;
  url: string;
  title: string;
  content: string;
}> = [
  {
    plugin: "FileBird",
    url: "https://docs.example.com/filebird/clear-cache/",
    title: "FileBird — Clearing caches and restoring folders",
    content:
      "If your media folders disappear after an update, go to FileBird > Settings > Tools and click 'Clear all caches'. Folders are stored in the database and are never deleted by an update.\n\nIf folders still do not appear, deactivate other media library plugins to rule out conflicts, then reload wp-admin.",
  },
  {
    plugin: "YayMail",
    url: "https://docs.example.com/yaymail/outlook-images/",
    title: "YayMail — Fixing stretched images in Outlook",
    content:
      "Outlook desktop ignores max-width on images. Set an explicit pixel width (for example 180px) on the logo element instead of a percentage.\n\nThis renders correctly across Outlook, Gmail and Apple Mail.",
  },
];

const OPERATORS = [
  { user_id: "op_anna", nickname: "Anna Nguyen", avatar: null },
  { user_id: "op_marc", nickname: "Marc Delacroix", avatar: null },
];

interface DemoSpec {
  sessionId: string;
  /** Which demo brand's Crisp website this conversation belongs to. */
  brandSlug: (typeof DEMO_BRANDS)[number]["slug"];
  state: string;
  nickname: string;
  email: string;
  phone?: string;
  country?: string;
  city?: string;
  segments: string[];
  assigned?: string;
  daysAgo: number;
  exchanges: Array<{
    from: "user" | "operator";
    type?: string;
    text?: string;
    file?: { name: string; url: string; type: string; size?: number };
    operator?: (typeof OPERATORS)[number];
  }>;
}

const DEMO_CONVERSATIONS: DemoSpec[] = [
  {
    sessionId: "session_demo_filebird_folders",
    brandSlug: "demo-ninjateam",
    state: "resolved",
    nickname: "Sarah Mitchell",
    email: "sarah.mitchell@example-store.com",
    phone: "+1 415 555 0132",
    country: "US",
    city: "San Francisco",
    segments: ["filebird", "bug"],
    assigned: "op_anna",
    daysAgo: 42,
    exchanges: [
      {
        from: "user",
        text: "Hi! After updating FileBird Pro to the latest version, my media folders disappeared from the library sidebar. Did I lose everything?",
      },
      {
        from: "operator",
        operator: OPERATORS[0],
        text: "Hi Sarah! Don't worry — your folders are still in the database. This usually happens when another media plugin conflicts with FileBird. Could you go to FileBird > Settings > Tools and click 'Clear all caches', then reload wp-admin?",
      },
      {
        from: "user",
        text: "That fixed it, all folders are back. Thank you so much!",
      },
      {
        from: "operator",
        operator: OPERATORS[0],
        text: "Wonderful! I'm marking this as resolved — reach out anytime.",
      },
    ],
  },
  {
    sessionId: "session_demo_yaymail_template",
    brandSlug: "demo-yaycommerce",
    state: "resolved",
    nickname: "Tomás Herrera",
    email: "tomas@herrera-imports.mx",
    country: "MX",
    city: "Guadalajara",
    segments: ["yaymail", "customization"],
    assigned: "op_marc",
    daysAgo: 30,
    exchanges: [
      {
        from: "user",
        text: "Hello, I'm using YayMail to customize the WooCommerce order confirmation email, but my logo shows up stretched in Outlook. My license key is 3F2A-9K8B-11CD-77EF if you need it.",
      },
      {
        from: "user",
        type: "file",
        file: {
          name: "outlook-screenshot.png",
          url: "https://storage.crisp.chat/demo/outlook-screenshot.png",
          type: "image/png",
          size: 234567,
        },
      },
      {
        from: "operator",
        operator: OPERATORS[1],
        text: "Hi Tomás, thanks for the screenshot! Outlook ignores max-width on images. In the YayMail logo element, set an explicit width of 180px instead of a percentage — that renders correctly in Outlook desktop.",
      },
      { from: "user", text: "Perfect, setting a fixed width solved it. Gracias!" },
    ],
  },
  {
    sessionId: "session_demo_yaycurrency_checkout",
    brandSlug: "demo-yaycommerce",
    state: "resolved",
    nickname: "Lena Fischer",
    email: "lena.fischer@alpenshop.de",
    country: "DE",
    city: "Munich",
    segments: ["yaycurrency", "woocommerce"],
    assigned: "op_anna",
    daysAgo: 18,
    exchanges: [
      {
        from: "user",
        text: "We installed YayCurrency and prices switch to EUR correctly, but at checkout WooCommerce charges in USD again. Is that expected?",
      },
      {
        from: "operator",
        operator: OPERATORS[0],
        text: "Hi Lena! By default YayCurrency displays prices in the visitor's currency but keeps checkout in your store currency. Enable 'Pay in customer's selected currency' in YayCurrency > Checkout settings to charge in EUR directly.",
      },
      {
        from: "user",
        text: "Enabled it and test orders now charge EUR. Danke schön!",
      },
    ],
  },
  {
    sessionId: "session_demo_yaysmtp_gmail",
    brandSlug: "demo-yaycommerce",
    state: "unresolved",
    nickname: "Priya Sharma",
    email: "priya@sharma-consulting.in",
    country: "IN",
    city: "Bengaluru",
    segments: ["yaysmtp"],
    assigned: "op_marc",
    daysAgo: 3,
    exchanges: [
      {
        from: "user",
        text: "YaySMTP stopped sending via Gmail this morning. The log says 'invalid_grant'. Password is Hunter2!23 in case you need to log in.",
      },
      {
        from: "operator",
        operator: OPERATORS[1],
        text: "Hi Priya — please never share passwords in chat! 'invalid_grant' means the Google OAuth token expired. Re-authorize in YaySMTP > Settings > Gmail (click 'Re-connect'). Also, we recommend rotating the password you just posted.",
      },
      { from: "user", text: "Oops, sorry. Re-connecting now, will report back." },
    ],
  },
  {
    sessionId: "session_demo_wordpress_migration",
    brandSlug: "demo-ninjateam",
    state: "pending",
    nickname: "Jack O'Neill",
    email: "jack@oneill-media.co.uk",
    country: "GB",
    city: "Leeds",
    segments: ["pre-sales", "wordpress"],
    daysAgo: 1,
    exchanges: [
      {
        from: "user",
        text: "Pre-sales question: does FileBird keep folder structure when migrating a WordPress site with WP Migrate? Card on file is 4242 4242 4242 4242 by the way, charge whatever's needed.",
      },
      {
        from: "operator",
        operator: OPERATORS[0],
        text: "Hi Jack! Yes — FileBird folders live in database tables that standard migration plugins copy, so the structure survives. (Also: we removed your card number from this transcript; please never post card details in chat.)",
      },
    ],
  },
];

function websiteIdFor(spec: DemoSpec): string {
  return DEMO_BRANDS.find((b) => b.slug === spec.brandSlug)!.crispWebsiteId;
}

function buildConversation(spec: DemoSpec): CrispConversation {
  const updatedAt = NOW - spec.daysAgo * DAY + spec.exchanges.length * 600_000;
  return {
    session_id: spec.sessionId,
    website_id: websiteIdFor(spec),
    state: spec.state,
    created_at: NOW - spec.daysAgo * DAY,
    updated_at: updatedAt,
    active: { now: false, last: updatedAt },
    last_message: spec.exchanges.filter((e) => e.text).at(-1)?.text?.slice(0, 100),
    assigned: spec.assigned ? { user_id: spec.assigned } : null,
    meta: {
      nickname: spec.nickname,
      email: spec.email,
      phone: spec.phone,
      ip: "203.0.113.42",
      segments: spec.segments,
      device: {
        geolocation: { country: spec.country, city: spec.city },
        locales: ["en"],
      },
    },
  };
}

/** Deterministic per-session hash so re-running the seed updates in place. */
function sessionHash(sessionId: string): number {
  let hash = 5381;
  for (let i = 0; i < sessionId.length; i++) {
    hash = ((hash << 5) + hash + sessionId.charCodeAt(i)) >>> 0;
  }
  return hash % 1_000_000;
}

function buildMessages(spec: DemoSpec): CrispMessage[] {
  const start = NOW - spec.daysAgo * DAY;
  return spec.exchanges.map((exchange, index) => {
    const timestamp = start + index * 600_000;
    const base: CrispMessage = {
      session_id: spec.sessionId,
      website_id: websiteIdFor(spec),
      from: exchange.from,
      origin: "chat",
      fingerprint: sessionHash(spec.sessionId) * 100 + index,
      timestamp,
      type: exchange.type ?? "text",
      user:
        exchange.from === "operator"
          ? { type: "website", ...exchange.operator }
          : { type: "participant", nickname: spec.nickname },
    };
    if (exchange.type === "file" && exchange.file) {
      base.content = exchange.file;
    } else {
      base.content = exchange.text ?? "";
    }
    return base;
  });
}

async function main() {
  console.log("Seeding demo data through the real sync pipeline...");
  // Idempotency: drop previous demo rows (cascades messages/files/chunks,
  // plugins, docs sources and docs pages).
  await prisma.conversation.deleteMany({
    where: { sessionId: { startsWith: "session_demo_" } },
  });
  await prisma.brand.deleteMany({ where: { slug: { startsWith: "demo-" } } });

  // Brands + plugins (drives multi-website sync and product detection).
  const brandIdBySlug = new Map<string, string>();
  const pluginIdByName = new Map<string, string>();
  for (const spec of DEMO_BRANDS) {
    const brand = await prisma.brand.create({
      data: {
        name: spec.name,
        slug: spec.slug,
        domain: spec.domain,
        crispWebsiteId: spec.crispWebsiteId,
      },
    });
    brandIdBySlug.set(spec.slug, brand.id);
    for (const pluginSpec of spec.plugins) {
      const plugin = await prisma.plugin.create({
        data: {
          brandId: brand.id,
          name: pluginSpec.name,
          slug: pluginSpec.slug,
          wpOrgSlug: pluginSpec.wpOrgSlug,
          detectionKeywords: [...pluginSpec.keywords],
        },
      });
      pluginIdByName.set(pluginSpec.name, plugin.id);
    }
    console.log(`  ✓ brand ${spec.name} (${spec.plugins.length} plugins)`);
  }
  invalidateProductDefinitions();

  for (const spec of DEMO_CONVERSATIONS) {
    const conversation = buildConversation(spec);
    const messages = buildMessages(spec);
    const result = await syncConversationPayload(conversation, messages, {
      brandId: brandIdBySlug.get(spec.brandSlug) ?? null,
      websiteId: websiteIdFor(spec),
    });
    await rebuildChunksForConversation(result.conversationId);
    console.log(`  ✓ ${spec.sessionId} (${messages.length} messages)`);
  }

  // Fake docs pages + chunks (bypasses the crawler — the URLs are not real).
  for (const doc of DEMO_DOCS) {
    const pluginId = pluginIdByName.get(doc.plugin);
    if (!pluginId) continue;
    const source = await prisma.docsSource.create({
      data: {
        pluginId,
        url: doc.url,
        type: "url",
        status: "completed",
        lastCrawledAt: new Date(),
        pageCount: 1,
        chunkCount: 1,
      },
    });
    const page = await prisma.docsPage.create({
      data: {
        docsSourceId: source.id,
        url: doc.url,
        title: doc.title,
        contentText: doc.content,
        contentHash: createHash("sha256").update(doc.content).digest("hex"),
      },
    });
    await prisma.embeddingChunk.create({
      data: {
        source: "plugin_docs",
        pluginId,
        docsPageId: page.id,
        chunkIndex: 0,
        chunkText: `[Docs: ${doc.plugin} | ${doc.title} | ${doc.url}]\n${doc.content}`,
        product: doc.plugin,
        topic: doc.title,
        rawJson: { url: doc.url },
      },
    });
    console.log(`  ✓ docs page for ${doc.plugin}`);
  }
  await prisma.syncLog.create({
    data: {
      kind: "full",
      status: "completed",
      finishedAt: new Date(),
      pageFrom: 1,
      pageTo: 1,
      conversationsSynced: DEMO_CONVERSATIONS.length,
      messagesSynced: DEMO_CONVERSATIONS.reduce(
        (sum, spec) => sum + spec.exchanges.length,
        0
      ),
    },
  });
  // Demo wp.org forum threads for the /suggestions page.
  const demoThreads = [
    {
      plugin: "FileBird",
      guid: "https://wordpress.org/support/topic/demo-folders-gone-after-update/",
      title: "Folders gone after updating to latest version",
      author: "wpuser2024",
      excerpt:
        "Hi, I updated FileBird this morning and all my media folders are gone from the sidebar. I have thousands of files organized. Please help, is my folder structure lost?",
      daysAgo: 0,
    },
    {
      plugin: "YayMail",
      guid: "https://wordpress.org/support/topic/demo-logo-stretched-outlook/",
      title: "Email logo looks stretched in Outlook desktop",
      author: "shopowner_lena",
      excerpt:
        "The logo in my WooCommerce order emails customized with YayMail displays fine in Gmail but appears stretched in Outlook desktop. Any idea how to fix the image sizing?",
      daysAgo: 1,
    },
  ];
  for (const spec of demoThreads) {
    const pluginId = pluginIdByName.get(spec.plugin);
    if (!pluginId) continue;
    await prisma.supportThread.create({
      data: {
        pluginId,
        guid: spec.guid,
        url: spec.guid,
        title: spec.title,
        author: spec.author,
        excerpt: spec.excerpt,
        publishedAt: new Date(NOW - spec.daysAgo * DAY),
      },
    });
    console.log(`  \u2713 forum thread for ${spec.plugin}`);
  }

  console.log("Demo seed complete.");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("Seed failed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
