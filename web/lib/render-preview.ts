import { DISCLOSURE_TAG, DISCLOSURE_NOTICE } from "./contract";

/**
 * Preview of the llms.txt block an advertiser's copy WOULD produce — matching the
 * shape the serving layer (src/serve/render.ts) actually renders: the tag inside
 * the anchor, before the body, and before the notice. Display-only; the
 * authoritative renderer + assertDisclosed() live on the serving side. Every
 * preview carries the disclosure — there is no code path here that omits it.
 */
export function previewBlock(title: string, body: string, url: string): string {
  const t = title.trim() || "Your title";
  const b = body.trim() || "Your one-line description.";
  const u = url.trim() || "https://example.com";
  return (
    `- [${DISCLOSURE_TAG} ${t}](${u}): ${DISCLOSURE_TAG} ${b}\n` +
    `  ${DISCLOSURE_TAG} ${DISCLOSURE_NOTICE}`
  );
}
