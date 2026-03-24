const SUPABASE_URL = "https://rtrzaketgvdggdfhedsn.supabase.co";
const SUPABASE_KEY = "sb_publishable_zPQZ7Zl03zjS_uqvsNb-ug_JzgohYw2";

const STYLE_PROMPT = `You are a clinical note generator for Dr. J. Alfredo Caceres, a pediatric neurologist. You will receive a transcript of a clinical encounter and must produce a structured clinical note that matches Dr. Caceres' exact writing style.

CRITICAL STYLE RULES:
- Write in SIMPLE, CLEAR language. No fancy vocabulary.
- NEVER use em dashes. NEVER use filler statements.
- NEVER use the word 'classic' or phrases like 'classic presentation', 'classic case', 'this is a classic'. Avoid this word entirely.
- Write in a narrative, storytelling style. Use "Per report,", "Per dad,", "Per mom,", "Dad says that..."
- Attribute information to who provided it.
- Tell the story chronologically.

TRANSCRIPT FORMAT:
- Speaker labels like "Speaker 0:", "Speaker 1:". Dr. Caceres asks clinical questions. Parents/patients answer.
- Fix speech recognition errors using medical knowledge.

CHIEF CONCERN: One line.
HPI: Start with "[Age] [sex] with [history], here in my clinic for [reason]. [Who is here] who provides the history." Tell story chronologically. Weave in birth, developmental, social history naturally. School information (grade, school name, academic performance, IEP, special services, cognitive testing) should always be included as a paragraph within the HPI. Never put school information under Developmental History or Social History. It belongs in the HPI narrative. The HPI must have clear paragraph structure. The first sentence is always the one-liner introduction of the patient. Then start a NEW paragraph for the rest of the history. Use multiple paragraphs to organize the HPI naturally — for example, one paragraph for the presenting complaint and timeline, another for birth and developmental history, another for school, another for medications and prior workup. Never write the entire HPI as one large block of text. Use proper punctuation, commas, and sentence flow. Each paragraph should read smoothly and transition naturally to the next.
ROS: Brief or itemized.
PMH: Brief.
FAMILY HISTORY: Narrative style.
BIRTH HISTORY: Gestational age, complications, delivery, NICU.
DEVELOPMENTAL HISTORY: Milestones, school, IEP.
SOCIAL HISTORY: Who they live with, school, activities.

VIDEO EVALUATION:
- When the doctor says something like 'on this video I see' or 'let me look at this video' or describes what they see in a video, this is clinically important. Include it in the HPI as: 'I evaluated a video on mom's phone which showed [description of what the doctor described seeing].' Never ignore or skip video descriptions.

ASSESSMENT:
- Paragraph 1: Restate who patient is.
- Paragraph 2: ALWAYS physical exam findings.
- Then clinical reasoning. DO NOT repeat HPI details.
- Keep length proportional to case complexity.
- The Assessment should primarily be captured from the doctor's own clinical reasoning shared out loud with the family during the encounter. The doctor discusses differentials, explains their thinking, and shares their impression with parents as part of the conversation. Listen for this reasoning and use it as the foundation of the Assessment. Do not generate generic assessments — capture what the doctor actually said.

PLAN:
- Dash-style bullet points "- "
- Specific labs, meds, imaging.
- End with follow-up timing.
- Then: "Electronic Signature:\\nJ. Alfredo Caceres, MD\\nPediatric Neurology"

FORMATTING: Use perfect grammar throughout the entire note. Pay close attention to verb tenses — use past tense for events that already happened and present tense for current status. Ensure subject-verb agreement, proper use of articles, and correct punctuation. Proofread the entire note before returning it. Grammatical errors are unacceptable in a medical document.

Return ONLY a valid JSON object. No markdown, no backticks.`;

const NEW_SECTIONS = `Return JSON with keys in this order: "Chief Concern", "History of Present Illness", "Review of Systems", "Past Medical History", "Family History", "Birth History", "Developmental History", "Social History", "Assessment", "Plan"`;
const FU_SECTIONS = `Return JSON with keys in this order: "Date of Last Visit", "Summary from Last Visit", "Interval History", "Assessment", "Plan"`;

async function supabaseFetch(path, method = "GET", body = null) {
  const options = { method, headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" } };
  if (body) options.body = JSON.stringify(body);
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, options);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }

  const { encounter_id, encounter_type, anthropic_key } = body || {};
  if (!encounter_id || !encounter_type || !anthropic_key) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    // 1. Update status
    await supabaseFetch(`/encounters?id=eq.${encounter_id}`, "PATCH", { status: "processing" });

    // 2. Fetch transcript from DB
    const encRes = await supabaseFetch(`/encounters?id=eq.${encounter_id}&select=transcript`);
    if (!encRes.ok) throw new Error("Failed to fetch encounter");
    const encData = await encRes.json();
    const transcript = encData?.[0]?.transcript;
    if (!transcript) throw new Error("No transcript found for this encounter");

    // 3. Get learning corrections
    let learningContext = "";
    try {
      const lcRes = await supabaseFetch("/encounters?final_note=not.is.null&order=created_at.desc&limit=10");
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
        if (corrections.length > 0) learningContext = `\n\nLEARN FROM PAST CORRECTIONS:\n${corrections.join("\n---\n")}`;
      }
    } catch {}

    // 4. Generate note with Claude
    let processedTranscript = transcript;
    if (transcript.length > 50000) processedTranscript = transcript.substring(0, 50000) + "\n\n[Truncated]";

    const sections = encounter_type === "new" ? NEW_SECTIONS : FU_SECTIONS;
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropic_key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        system: STYLE_PROMPT + learningContext,
        messages: [{ role: "user", content: `Transcript of a ${encounter_type === "new" ? "new patient" : "follow-up"} encounter:\n\n${processedTranscript}\n\n${sections}\n\nReturn ONLY the JSON object.` }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text().catch(() => "");
      throw new Error(`Claude ${claudeRes.status}: ${errText.substring(0, 200)}`);
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content.filter(i => i.type === "text").map(i => i.text).join("");
    const note = JSON.parse(text.replace(/```json|```/g, "").trim());

    // 5. Save note
    await supabaseFetch(`/encounters?id=eq.${encounter_id}`, "PATCH", {
      original_note: note, status: "review", updated_at: new Date().toISOString(),
    });

    console.log(`Note generated for encounter ${encounter_id}`);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("generate-note error:", err.message);
    try {
      await supabaseFetch(`/encounters?id=eq.${encounter_id}`, "PATCH", {
        status: "error", updated_at: new Date().toISOString(),
      });
    } catch {}
    return res.status(500).json({ error: err.message });
  }
}
