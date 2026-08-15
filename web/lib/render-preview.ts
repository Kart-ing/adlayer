import { DISCLOSURE_TAG, DISCLOSURE_NOTICE } from "./contract";

/**
 * Preview of the llms.txt block an advertiser's copy WOULD produce. This is a
 * display-only preview — the authoritative renderer + assertDisclosed() live on
 * the serving side (Person A, src/serve). Every preview carries the disclosure;
 * there is no code path here that omits it.
 */
export function previewBlock(title: string, body: string, url: string): string {
  const t = title.trim() || "Your title";
  const b = body.trim() || "Your one-line description.";
  const u = url.trim() || "https://example.com";
  return `${DISCLOSURE_TAG}\n${DISCLOSURE_NOTICE}\n- [${t}](${u}): ${b}`;
}
