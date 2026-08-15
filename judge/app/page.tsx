import { STUDY, assignVariant, stimulusFor } from "../lib/spec";
import { fromQuery } from "../lib/attribution";
import VoteForm from "./vote-form";

export const dynamic = "force-dynamic";

export default function Task({
  searchParams,
}: {
  searchParams: { submissionId?: string | string[]; taskId?: string | string[] };
}) {
  const { submissionId, taskId } = fromQuery(searchParams);
  // Blind, stable arm assignment from the participant id (or a neutral preview seed).
  const seed = submissionId ?? taskId ?? "preview";
  const variant = assignVariant(seed);

  return (
    <>
      <p className="masthead">A quick study · about 1 minute</p>
      <h1>Assistant answer</h1>
      <p className="framing">{STUDY.framing}</p>

      <div className="stimulus" aria-label="Assistant answer">
        {stimulusFor(variant)}
      </div>

      <VoteForm
        questions={STUDY.questions}
        submissionId={submissionId}
        taskId={taskId}
        variant={variant}
      />

      <p className="attn">
        Your response is recorded for research. No account or personal details are collected here.
      </p>
    </>
  );
}
