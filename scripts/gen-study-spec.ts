/**
 * Emit the study spec (framing, questions, variant stimuli) as JSON for the judge
 * app to embed. Single source of truth stays src/prove/study-design.ts; the judge
 * app reads the generated artifact so it never has to resolve project TS across
 * its app boundary. Run: `npm run gen:study-spec`.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { studySpec } from "../src/prove/study-design.ts";

const out = path.join(process.cwd(), "judge", "data", "study-spec.json");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(studySpec(), null, 2) + "\n", "utf8");
console.log("wrote", out);
