/**
 * PII / secret redaction for RAG chunk text.
 *
 * Chunks are what gets embedded and later pasted into LLM prompts, so they
 * must not carry customer emails, phone numbers, license keys, API keys,
 * passwords or card numbers. The ORIGINAL data stays intact in the database
 * (Conversation/Message rawJson) — redaction only applies to chunkText.
 *
 * Heuristics err on the side of redacting: a false positive costs a little
 * context, a false negative leaks PII into the vector store.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// International-ish phone numbers: optional +country, then 7+ digits allowing
// common separators. Requires either a leading + or a separator-grouped shape
// so plain small integers ("error 404", "3 items") are untouched.
const PHONE_RE =
  /(?:(?<![\w.])\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]){2,}\d{2,4}(?![\w])|(?<![\w.])\+\d{8,15}(?![\w])/g;

// 13–19 digit runs with optional space/dash grouping — validated with Luhn
// before redacting so order numbers and timestamps mostly survive.
const CARD_CANDIDATE_RE = /(?<![\d-])(?:\d[ -]?){13,19}(?![\d-])/g;

// Common API key/token shapes: known prefixes, or long high-entropy tokens.
const API_KEY_RES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, // GitHub
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b[A-Fa-f0-9]{32,64}\b/g, // long hex (md5/sha/API secrets)
];

// License keys: 3+ groups of 4-6 alphanumerics separated by dashes, at least
// one digit AND one letter overall (avoids matching plain words like
// "state-of-the-art" or UUID-less phrases).
const LICENSE_RE =
  /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){2,}\b/gi;

// UUIDs frequently ARE license keys in the WordPress plugin world.
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// "password: hunter2", "pwd = s3cret!" — masks the value, keeps the label.
const PASSWORD_LINE_RE =
  /\b(password|passwd|pwd|passphrase)\b(\s*[:=]\s*|\s+is\s+)(\S+)/gi;

/** True for date-shaped strings: 2026-05-29, 29.05.2026, 5/29/26 etc. */
function looksLikeDate(value: string): boolean {
  const ymd = value.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (ymd) {
    const [, year, month, day] = ymd.map(Number);
    return year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }
  const dmy = value.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})$/);
  if (dmy) {
    const [, a, b] = dmy.map(Number);
    // Either of the first two groups must be a plausible month.
    return a >= 1 && a <= 31 && b >= 1 && b <= 31 && (a <= 12 || b <= 12);
  }
  return false;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Redact PII and secrets from free text destined for embedding chunks. */
export function redactText(input: string): string {
  let text = input;

  text = text.replace(EMAIL_RE, "[EMAIL]");

  text = text.replace(PASSWORD_LINE_RE, (_m, label, sep) => {
    return `${label}${sep}[PASSWORD]`;
  });

  text = text.replace(CARD_CANDIDATE_RE, (match) => {
    const digits = match.replace(/[^\d]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      return "[CARD_NUMBER]";
    }
    return match;
  });

  for (const re of API_KEY_RES) {
    text = text.replace(re, "[API_KEY]");
  }

  text = text.replace(UUID_RE, "[LICENSE_KEY]");
  text = text.replace(LICENSE_RE, "[LICENSE_KEY]");

  text = text.replace(PHONE_RE, (match) => {
    const trimmed = match.trim();
    // Calendar dates (2026-05-29, 29.05.2026, 5/29/2026...) are not phones.
    if (looksLikeDate(trimmed)) return match;
    // Require a minimum of 7 digits to reduce false positives.
    const digitCount = trimmed.replace(/[^\d]/g, "").length;
    return digitCount >= 7 ? "[PHONE]" : match;
  });

  return text;
}

/** Mask an email for on-screen display: "jo***@ex***.com". */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const maskedLocal = local.slice(0, 2) + "***";
  const dot = domain.lastIndexOf(".");
  const maskedDomain =
    dot > 0 ? domain.slice(0, 2) + "***" + domain.slice(dot) : "***";
  return `${maskedLocal}@${maskedDomain}`;
}

/** Mask all but the last 2 digits of a phone number for display. */
export function maskPhone(phone: string): string {
  return phone.replace(/\d(?=[\s\S]*\d\d)/g, "•");
}

/** Mask an IP address for display: "203.0.•.•". */
export function maskIp(ip: string): string {
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.•.•`;
  // IPv6 — keep the first two hextets.
  const v6 = ip.split(":");
  return v6.length > 2 ? `${v6[0]}:${v6[1]}:••` : "•••";
}
