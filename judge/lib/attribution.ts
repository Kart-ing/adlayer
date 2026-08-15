/**
 * Participant attribution. Terac appends `?submissionId=…&taskId=…` to the task
 * URL it sends people to; that is the only way a response ties back to a
 * participant. svg-arena captures it two ways and so do we:
 *   - client-side, from the page's own query string (searchParams)
 *   - server-side, from the Referer header on the vote request (a fallback for
 *     when the client did not echo the ids into the POST body)
 */

export interface Attribution {
  submissionId: string | null;
  taskId: string | null;
}

export function fromQuery(params: {
  submissionId?: string | string[];
  taskId?: string | string[];
}): Attribution {
  const one = (v?: string | string[]) => (Array.isArray(v) ? v[0] ?? null : v ?? null);
  return { submissionId: one(params.submissionId), taskId: one(params.taskId) };
}

/** Recover attribution from a Referer URL (server-side fallback). */
export function fromReferer(referer: string | null): Attribution {
  if (!referer) return { submissionId: null, taskId: null };
  try {
    const u = new URL(referer);
    return {
      submissionId: u.searchParams.get("submissionId"),
      taskId: u.searchParams.get("taskId"),
    };
  } catch {
    return { submissionId: null, taskId: null };
  }
}

/** Prefer explicit values; fall back to the Referer-derived ones. */
export function reconcile(primary: Attribution, fallback: Attribution): Attribution {
  return {
    submissionId: primary.submissionId ?? fallback.submissionId,
    taskId: primary.taskId ?? fallback.taskId,
  };
}
