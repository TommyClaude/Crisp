/**
 * Seed the database with realistic FAKE Crisp payloads for local development
 * and UI testing — runs them through the real sync pipeline (normalization,
 * upserts, file extraction, chunk building) without touching the Crisp API.
 *
 *   npm run seed:demo
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { syncConversationPayload } from "../src/lib/sync/sync-service";
import { rebuildChunksForConversation } from "../src/lib/rag/rebuild";
import type { CrispConversation, CrispMessage } from "../src/lib/crisp/types";

const WEBSITE_ID = process.env.CRISP_WEBSITE_ID ?? "demo-website";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const OPERATORS = [
  { user_id: "op_anna", nickname: "Anna Nguyen", avatar: null },
  { user_id: "op_marc", nickname: "Marc Delacroix", avatar: null },
];

interface DemoSpec {
  sessionId: string;
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

function buildConversation(spec: DemoSpec): CrispConversation {
  const updatedAt = NOW - spec.daysAgo * DAY + spec.exchanges.length * 600_000;
  return {
    session_id: spec.sessionId,
    website_id: WEBSITE_ID,
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
      website_id: WEBSITE_ID,
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
  // Idempotency: drop previous demo rows (cascades messages/files/chunks).
  await prisma.conversation.deleteMany({
    where: { sessionId: { startsWith: "session_demo_" } },
  });
  for (const spec of DEMO_CONVERSATIONS) {
    const conversation = buildConversation(spec);
    const messages = buildMessages(spec);
    const result = await syncConversationPayload(conversation, messages);
    await rebuildChunksForConversation(result.conversationId);
    console.log(`  ✓ ${spec.sessionId} (${messages.length} messages)`);
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
  console.log("Demo seed complete.");
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("Seed failed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
