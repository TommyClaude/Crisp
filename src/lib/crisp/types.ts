/**
 * Loosely-typed shapes for Crisp REST API v1 payloads.
 *
 * These are intentionally permissive (all optional) because Crisp payloads
 * vary by plan, channel and age of the conversation. The sync always persists
 * the full raw JSON alongside the extracted columns, so nothing is lost if
 * these types miss a field.
 */

export interface CrispApiEnvelope<T> {
  error: boolean;
  reason: string;
  data: T;
}

export interface CrispGeolocation {
  country?: string;
  region?: string;
  city?: string;
  coordinates?: { latitude?: number; longitude?: number };
}

export interface CrispConversationMeta {
  nickname?: string;
  email?: string;
  phone?: string;
  address?: string;
  ip?: string;
  avatar?: string;
  device?: {
    geolocation?: CrispGeolocation;
    system?: Record<string, unknown>;
    timezone?: number;
    locales?: string[];
  };
  segments?: string[];
  subject?: string;
  data?: Record<string, unknown>;
}

export interface CrispConversation {
  session_id?: string;
  website_id?: string;
  inbox_id?: string | null;
  people_id?: string;
  state?: string;
  status?: number;
  is_verified?: boolean;
  is_blocked?: boolean;
  availability?: string;
  active?: { now?: boolean; last?: number };
  last_message?: string;
  participants?: unknown[];
  mentions?: string[];
  created_at?: number; // ms epoch
  updated_at?: number; // ms epoch
  unread?: { operator?: number; visitor?: number };
  assigned?: { user_id?: string } | null;
  meta?: CrispConversationMeta;
  topic?: string;
  [key: string]: unknown;
}

export interface CrispMessageUser {
  type?: string;
  user_id?: string;
  nickname?: string;
  avatar?: string | null;
  [key: string]: unknown;
}

/** Content of `type: "file"` / `"audio"` / `"animation"` messages. */
export interface CrispFileContent {
  name?: string;
  url?: string;
  type?: string; // MIME type
  size?: number;
  duration?: number;
  [key: string]: unknown;
}

export interface CrispMessage {
  session_id?: string;
  website_id?: string;
  type?: string; // text | file | animation | audio | picker | field | carousel | note | event
  from?: string; // user | operator
  origin?: string; // chat | email | urn:*
  content?: string | CrispFileContent | Record<string, unknown>;
  preview?: unknown[];
  mentions?: string[];
  read?: string;
  delivered?: string;
  edited?: boolean;
  translated?: boolean;
  fingerprint?: number;
  timestamp?: number; // ms epoch
  user?: CrispMessageUser;
  references?: unknown[];
  original?: unknown;
  stamped?: boolean;
  [key: string]: unknown;
}

export interface CrispOperator {
  user_id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  avatar?: string | null;
  role?: string;
  title?: string;
  availability?: string;
  [key: string]: unknown;
}

/** Shape returned by /operators/list — entries may nest under `details`. */
export interface CrispOperatorListEntry extends CrispOperator {
  type?: string;
  details?: CrispOperator;
}
