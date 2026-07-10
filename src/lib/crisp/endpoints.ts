/**
 * Crisp REST API v1 endpoint map — deliberately isolated in one file.
 *
 * If a Crisp endpoint path differs from the official docs (or changes in the
 * future), adjust it HERE and nothing else in the codebase needs to move.
 * Docs: https://docs.crisp.chat/references/rest-api/v1/
 */

export const CRISP_API_BASE_URL = "https://api.crisp.chat/v1";

export const crispEndpoints = {
  /**
   * List conversations for a website, paginated (page starts at 1).
   * Sorted by most recent activity first.
   * GET /website/{website_id}/conversations/{page}
   */
  listConversations: (websiteId: string, page: number) =>
    `/website/${websiteId}/conversations/${page}`,

  /**
   * Get one conversation (includes meta, state, assigned operator...).
   * GET /website/{website_id}/conversation/{session_id}
   */
  getConversation: (websiteId: string, sessionId: string) =>
    `/website/${websiteId}/conversation/${sessionId}`,

  /**
   * Get messages in a conversation. Returns the most recent batch; pass
   * `timestamp_before` (ms epoch) to page backwards through history.
   * GET /website/{website_id}/conversation/{session_id}/messages
   */
  getMessages: (websiteId: string, sessionId: string) =>
    `/website/${websiteId}/conversation/${sessionId}/messages`,

  /**
   * Get conversation metas (visitor nickname, email, device, segments...).
   * GET /website/{website_id}/conversation/{session_id}/metas
   */
  getConversationMetas: (websiteId: string, sessionId: string) =>
    `/website/${websiteId}/conversation/${sessionId}/metas`,

  /**
   * List website operators. May be unavailable depending on plugin scopes —
   * the sync treats a failure here as non-fatal.
   * GET /website/{website_id}/operators/list
   */
  listOperators: (websiteId: string) => `/website/${websiteId}/operators/list`,
} as const;
