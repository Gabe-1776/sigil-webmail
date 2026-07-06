/**
 * Redaction helpers for OAuth token/error responses before they reach logs
 * or HTTP responses. Never log or return a raw token JSON body or a raw
 * upstream error body verbatim — both can carry live bearer credentials
 * (refresh_token, id_token) or, for non-standard IdP error pages, echoed
 * request parameters.
 */

/** Safe metadata about a token response that failed the access_token check. */
export function redactTokenResponseForLogging(tokens: Record<string, unknown>) {
  return {
    // Presence checks, not truthiness — an IdP returning `refresh_token: ""`
    // is a "present but empty" anomaly worth distinguishing from "absent" in
    // an incident log, not the same thing.
    hasRefreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0,
    hasIdToken: typeof tokens.id_token === 'string' && tokens.id_token.length > 0,
    tokenType: typeof tokens.token_type === 'string' ? tokens.token_type : null,
    expiresIn: typeof tokens.expires_in === 'number' ? tokens.expires_in : null,
    topLevelKeys: Object.keys(tokens),
  };
}

/**
 * OAuth error responses are typically `{error, error_description, error_uri}`
 * per RFC 6749 §5.2 — standardized fields meant to be shown to developers.
 * Extract only those; never log the raw body, since some IdPs echo request
 * params (or worse) into non-standard error bodies.
 */
export function redactOAuthErrorBodyForLogging(errorText: string, status: number) {
  try {
    const parsed = JSON.parse(errorText);
    if (parsed && typeof parsed === 'object') {
      return {
        status,
        error: typeof parsed.error === 'string' ? parsed.error : null,
        errorDescription: typeof parsed.error_description === 'string'
          ? parsed.error_description.slice(0, 200)
          : null,
        topLevelKeys: Object.keys(parsed),
      };
    }
  } catch {
    // not JSON — fall through to the length-only summary below.
  }
  return { status, bodyLength: errorText.length, parseable: false };
}
