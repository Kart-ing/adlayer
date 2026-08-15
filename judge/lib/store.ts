import { appendFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Variant } from "./spec";

/**
 * One recorded judging response. This shape is exactly what
 * src/prove/terac.ts `aggregateSubmissions` consumes, so the export closes the
 * loop: judge → JSONL → Terac before/after.
 */
export interface StoredSubmission {
  submissionId: string;
  taskId: string | null;
  variant: Variant;
  trust: "Yes" | "No" | "Unsure";
  ad_recognition: "Yes" | "No" | "Unsure";
  verbatim?: string;
  recorded_at: string;
}

const DATA_DIR = path.join(process.cwd(), "data");
const JSONL_PATH = path.join(DATA_DIR, "submissions.jsonl");

export async function appendSubmission(sub: StoredSubmission): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(JSONL_PATH, JSON.stringify(sub) + "\n", "utf8");
}

export async function readSubmissionsJsonl(): Promise<string> {
  try {
    return await readFile(JSONL_PATH, "utf8");
  } catch {
    return "";
  }
}

export async function readSubmissions(): Promise<StoredSubmission[]> {
  const raw = await readSubmissionsJsonl();
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredSubmission);
}
