// attribution.ts — Web UTM / referrer attribution capture.
// Captured ONCE at first install and attached to the install event properties.
// First-party only; no cross-app tracking; no IDFA.
// the telemetry spec §12: web SDK captures UTM parameters from the landing URL.

import type { Props } from "./types.js";

const UTM_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

/**
 * Capture UTM parameters from the current URL and the document referrer.
 * Returns a flat Props object with the available values, or undefined if nothing
 * was found. Safe to call in SSR — returns undefined when window is absent.
 */
export function captureAttribution(): Props | undefined {
  if (typeof window === "undefined") return undefined;

  const props: Props = {};
  let found = false;

  // UTM params from the landing URL
  try {
    const url = new URL(window.location.href);
    for (const param of UTM_PARAMS) {
      const val = url.searchParams.get(param);
      if (val) {
        props[param] = val;
        found = true;
      }
    }

    // Also capture the gclid (Google Click ID) if present
    const gclid = url.searchParams.get("gclid");
    if (gclid) {
      props["gclid"] = gclid;
      found = true;
    }

    // fbclid (Meta Click ID)
    const fbclid = url.searchParams.get("fbclid");
    if (fbclid) {
      props["fbclid"] = fbclid;
      found = true;
    }
  } catch {
    // URL parse failed — skip
  }

  // Referrer
  try {
    if (document.referrer && document.referrer.length > 0) {
      // Store the referrer domain only (not full URL — avoids capturing paths
      // that may contain PII like auth tokens in query strings).
      const referrerUrl = new URL(document.referrer);
      props["referrer_host"] = referrerUrl.hostname;
      found = true;
    }
  } catch {
    // Invalid referrer — skip
  }

  return found ? props : undefined;
}
