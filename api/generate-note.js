const SUPABASE_URL = "https://rtrzaketgvdggdfhedsn.supabase.co";
const SUPABASE_KEY = "sb_publishable_zPQZ7Zl03zjS_uqvsNb-ug_JzgohYw2";

const STYLE_PROMPT = `You are a clinical note generator for Dr. J. Alfredo Caceres, a pediatric neurologist. You will receive a transcript of a clinical encounter and must produce a structured clinical note that matches Dr. Caceres' exact writing style.

CRITICAL STYLE RULES:
- Write in SIMPLE, CLEAR language. No fancy vocabulary.
- NEVER use em dashes. NEVER use filler statements.
- Write in a narrative, storytelling style. Use "Per report,", "Per dad,", "Per mom,", "Dad says that..."
- Attribute information to who provided it.
- Tell the story chronologically.

TRANSCRIPT FORMAT:
- Speaker labels like "Speaker 0:", "Speaker 1:". Dr. Caceres asks clinical questions. Parents/patients answer.
- Fix speech recognition errors using medical knowledge.

CHIEF CONCERN: One line.
HPI: Start with "[Age] [sex] with [history], here in my clinic for [reason]. [Who is here] who provides the history." Tell story chronologically.
ROS: Brief or itemized.
PMH: Brief.
FAMILY HISTORY: Narrative style.
BIRTH HISTORY: Gestational age, complications, delivery, NICU.
DEVELOPMENTAL HISTORY: Milestones, school, IEP.
SOCIAL HISTORY: Who they live with, school, activities.

ASSESSMENT:
- Paragraph 1: Restate who patient is.
- Paragraph 2: ALWAYS physical exam findings.
- Then clinical reasoning. DO NOT repeat HPI details.
- Keep length proportional to case complexity.

PLAN:
- Dash-style bullet points "- "
- Specific labs, meds, imaging.
- End with follow-up timing.
- Then: "Electronic Signature:\\nJ. Alfredo Caceres, MD\\nPediatric Neurology"

Return ONLY a valid JSON object. No markdown, no backticks.`;

const NEW_SECTIONS = `Return JSON with keys in this order: "Chief Concern", "History of Present Illness", "Review of Systems", "Past Medical History", "Family History", "Birth History", "Developmental History", "Social History", "Assessment", "Plan"`;
const FU_SECTIONS = `Return JSON with keys in this order: "Date of Last Visit", "Summary from Last Visit", "Interval History", "Assessment", "Plan"`;

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  let body = req.body;
  // Parse body if it's a string
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: "Invalid JSON" }); }
  }

  const { encounter_id, transcript, encounter_type, anthropic_key } = body || {};

  if (!encounter_id || !transcript || !encounter_type || !anthropic_key) {
    return res.status(400).json({ error: "Missing fields", received: { encounter_id: !!encounter_id, transcript: !!transcript, encounter_type: !!encounter_type, anthropic_key: !!anthropic_key } });
  }

  try {
    // Update status to processing
    await fetch(`${SUPABASE_URL}/rest/v1/encounters?id=eq.${encounter_id}`, {
      method: "PATCH",
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "processing" }),
    });

    // Get learning corrections
    let learningContext = "";
    try {
      const lcRes = await fetch(`${SUPABASE_URL}/rest/v1/encounters?final_note=not.is.null&order=created_at.desc&limit=10`, {
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` },
      });
      if (lcRes.ok) {
        const pastEnc = await lcRes.json();
        const corrections = pastEnc
          .filter(e => e.original_note && e.final_note && JSON.stringify(e.original_note) !== JSON.stringify(e.final_note))
          .slice(0, 3)
          .map(e => {
            const diffs = [];
            for (const key of Object.keys(e.original_note)) {
              if (e.final_note[key] && e.original_note[key] !== e.final_note[key]) {
                diffs.push(`"${key}": AI wrote "${e.original_note[key].substring(0, 150)}..." → Doctor changed to "${e.final_note[key].substring(0, 150)}..."`);
              }
            }
            return diffs.join("\n");
          })
          .filter(d => d.length > 0);
        if (corrections.length > 0) {
          learningContext = `\n\nLEARN FROM PAST CORRECTIONS:\n${corrections.join("\n---\n")}`;
        }
      }
    } catch (e) {}

    // Truncate long transcripts
    let processedTranscript = transcript;
    if (transcript.length > 50000) {
      processedTranscript = transcript.substring(0, 50000) + "\n\n[Truncated]";
    }

    const sections = encounter_type === "new" ? NEW_SECTIONS : FU_SECTIONS;

    // Call Claude
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropic_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        system: STYLE_PROMPT + learningContext,
        messages: [{ role: "user", content: `Transcript of a ${encounter_type === "new" ? "new patient" : "follow-up"} encounter:\n\n${processedTranscript}\n\n${sections}\n\nReturn ONLY the JSON object.` }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text().catch(() => "unknown");
      throw new Error(`Claude ${claudeRes.status}: ${errText.substring(0, 200)}`);
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content.filter(i => i.type === "text").map(i => i.text).join("");
    const cleaned = text.replace(/```json|```/g, "").trim();
    const note = JSON.parse(cleaned);

    // Save to Supabase
    const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/encounters?id=eq.${encounter_id}`, {
      method: "PATCH",
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ original_note: note, status: "review", updated_at: new Date().toISOString() }),
    });

    if (!saveRes.ok) throw new Error("Failed to save note to database");

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("generate-note error:", err.message);
    // Mark as error
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/encounters?id=eq.${encounter_id}`, {
        method: "PATCH",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "error", updated_at: new Date().toISOString() }),
      });
    } catch (e) {}
    return res.status(500).json({ error: err.message });
  }
}
