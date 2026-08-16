# Voiceover — ElevenLabs script

**Runtime target: 1:54 (114s). ~285 words.** Paste the block under "SCRIPT" straight into ElevenLabs.

**Voice direction:** measured, dry, slightly clinical. This is a research finding, not a pitch. Let the numbers land — do not push energy into them. A voice like *Adam*, *Daniel* or *Brian* fits; keep Stability around 50, Similarity 75, Style low.

**Do not add emphasis tags or SSML** — the line breaks below already control the pacing.

---

## SCRIPT

Agents are becoming the traffic. And nobody has priced the inventory.

Websites publish a file called llms dot txt. It tells AI agents what's on the site and what's worth reading. Agents read it. So we sold ad space inside it.

This is a real placement, on a real site, right now. It carries the word SPONSORED, a disclosure notice, and a signed provenance record. That guarantee lives in code — the function that writes this block throws if the label is missing, and there is no flag that turns it off.

Here's a fresh agent. It has never seen this project. We asked it a normal question about ventilating a darkroom and pointed it at our site. We never mentioned advertising.

It finds the file on its own. That was the shakiest assumption we had this morning — that agents actually read this thing. They do. Then it reaches our ad, and it has to decide what to do with a paid placement.

Before we served anything, we ran the same test. The agent checked the sponsored section, found it empty, and named no brands at all. That's our control.

Then we served one line.

It refused to pass the placement off as advice. We didn't build that behaviour. We measured it.

Then we paid twenty-two real people to read an AI answer. Everyone shown the label spotted the ad — one hundred percent. Of the people shown identical copy with the label removed, seventeen percent noticed. And they trusted the assistant twice as much.

Hiding the ad makes it more effective, and better liked.

But the label doesn't always survive. Same ad, same model, four different outcomes. Refused. Disclosed. Stripped entirely. And the interesting one — the word sponsored present, and the product recommended anyway. A label that is technically there and functionally inert.

A disclosure that works most of the time is not a disclosure standard. That's why ours is enforced in the serving path, and not in a policy document.

And the case we filed as a failure — the model refusing the ad — is the actual product. A buyer's agent. It already exists. Nobody is selling to it yet.

---

## Timing map

| Film scene | In | Line it lands on |
|---|---|---|
| TITLE | 0:00 | "Agents are becoming the traffic…" |
| THE PREMISE | 0:06 | "Websites publish a file called llms dot txt…" |
| THE PLACEMENT | 0:16 | "This is a real placement…" |
| **LIVE CAPTURE** | **0:28** | **"Here's a fresh agent…"** |
| BEFORE | 0:52 | "Before we served anything…" |
| AFTER | 1:01 | "Then we served one line." |
| THE HUMAN DATA | 1:14 | "Then we paid twenty-two real people…" |
| THE FAILURE | 1:30 | "But the label doesn't always survive." |
| CLOSE | 1:42 | "A disclosure that works most of the time…" |

The live capture runs 24 seconds and carries the longest stretch of narration. If ElevenLabs runs short there, add a two-second pause after *"They do."* and let the terminal play.

## After you generate

1. Drop the MP3 into the timeline alongside `video/out/adlayer-demo.mp4`.
2. Align the first word to 0:00.
3. If drift creeps in, the scene table in `video/src/theme.ts` retimes everything from one place — change a `dur` and re-render, which takes about a minute.

## One thing worth saying that isn't in the script

Cold discovery does not work yet. Ask a general question with no site context and our placement does not appear — zero out of six, both engines. Agentic browsing works; replacing SEO does not, yet.

It is the first thing a sharp judge will probe. If you have eight spare seconds, say it out loud before they ask — it costs nothing and buys the hardest question in the room.
