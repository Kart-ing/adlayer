// Person B — Action (PRD-B §3.5): IndexNow ping, explicit post-deploy step.
// Gate before submitting: INDEXNOW_KEY set AND {origin}/{key}.txt publicly
// serves exactly the key. Gate fails → log why, return null. Never throws.

export async function pingIndexNow(siteUrl: string, urls: string[]): Promise<string | null> {
  try {
    const key = process.env.INDEXNOW_KEY;
    if (!key) {
      console.error("[indexnow] skipped: INDEXNOW_KEY not set");
      return null;
    }

    let origin: string;
    let hostname: string;
    try {
      const parsed = new URL(siteUrl);
      origin = parsed.origin;
      hostname = parsed.hostname;
    } catch {
      console.error(`[indexnow] skipped: invalid site URL "${siteUrl}"`);
      return null;
    }

    // Gate: the key file must be publicly served with body === key (§3.5).
    const keyLocation = `${origin}/${key}.txt`;
    try {
      const verify = await fetch(keyLocation, { signal: AbortSignal.timeout(10_000) });
      if (verify.status !== 200) {
        console.error(`[indexnow] skipped: ${keyLocation} returned HTTP ${verify.status} (key file not deployed?)`);
        return null;
      }
      const body = await verify.text();
      if (body.trim() !== key) {
        console.error(`[indexnow] skipped: ${keyLocation} body does not match INDEXNOW_KEY`);
        return null;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[indexnow] skipped: could not verify ${keyLocation}: ${reason}`);
      return null;
    }

    const submit = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: hostname, key, keyLocation, urlList: urls }),
      signal: AbortSignal.timeout(10_000),
    });
    if (submit.status === 200 || submit.status === 202) {
      const submittedAt = new Date().toISOString();
      console.error(`[indexnow] submitted ${urls.length} URL(s) at ${submittedAt}`);
      return submittedAt;
    }
    console.error(`[indexnow] submit failed: HTTP ${submit.status}`);
    return null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[indexnow] error: ${reason}`);
    return null;
  }
}
