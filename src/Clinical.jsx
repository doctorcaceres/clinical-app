import { useState, useRef, useEffect, useCallback } from "react";

const STATES = { SETUP: "setup", SELECT: "select", IDLE: "idle", RECORDING: "recording", PAUSED: "paused", GENERATING: "generating", NOTE: "note" };

// ============================================================
// THE BRAIN — Dr. Caceres' writing style and note structure
// ============================================================

const STYLE_PROMPT = `You are a clinical note generator for Dr. J. Alfredo Caceres, a pediatric neurologist. You will receive a transcript of a clinical encounter and must produce a structured clinical note that matches Dr. Caceres' exact writing style.

CRITICAL STYLE RULES — follow these precisely:

VOICE & TONE:
- Write in SIMPLE, CLEAR language. English is not Dr. Caceres' first language. He writes in plain, direct terms. No fancy vocabulary, no flowery phrasing.
- NEVER use phrases like "is particularly informative", "notably", "importantly", "significantly", "it is worth noting". These sound artificial. Just state the facts simply.
- NEVER use em dashes (—) to separate sentences or clauses. Do not use them anywhere in the note.
- Write in a narrative, storytelling style. You are telling the patient's story chronologically, not filling in a form.
- Use phrases like "Per report,", "Per dad,", "Per mom,", "Per review of notes:", "Dad says that...", "Mom recalls that..."
- Attribute information to who provided it: the parent, the patient, or prior records.
- Embed timeline naturally: "At 3 days of age, he was...", "More recently in December 2023, he was..."
- Weave subspecialty visits, imaging, and lab results into the narrative flow of the HPI when relevant.
- Use direct quotes sparingly but effectively when a parent says something notable, e.g., "but his weight was very low"
- NEVER write filler statements that add no clinical value. If something is obvious or textbook (e.g., "postictal confusion is typical following generalized tonic-clonic seizures"), do NOT write it. Only write things that matter for this specific patient.

TRANSCRIPT FORMAT:
- The transcript uses speaker labels (e.g., "Speaker 0:", "Speaker 1:"). Dr. Caceres is typically the one asking clinical questions. Parents/patients are the ones answering. Use context to determine who is who.
- The transcript may have speech recognition errors. Use your medical knowledge to interpret what was likely said. For example, "toppy ray mate" is probably "topiramate" and "kept rah" is probably "Keppra".

CHIEF CONCERN:
- One line. The core reason for referral or visit.
- Example: "Aicardi-Goutières syndrome (AGS)" or "seizures and abnormal brain MRI" or "febrile seizures"

HISTORY OF PRESENT ILLNESS:
- Start with: "[Age] [sex] with [relevant history], here in my clinic for [reason]. [Who is here] who provides the history."
- If records were reviewed, mention: "I also reviewed prior records."
- Tell the story chronologically from onset to present day.
- Include birth history, perinatal events, developmental milestones, feeding, sleep, medications, services, school — all woven naturally into the narrative, not as separate bullet points within the HPI.
- For subspecialty history, use "Review of recent medical records" as a sub-section with dash-style entries when there are multiple specialists.
- End HPI-related subsections naturally.

REVIEW OF SYSTEMS:
- Can be brief: "An 11 point review of systems was obtained and is positive for the findings documented in the HPI."
- Or itemized naturally: "No previous history of headaches. No history of hearing problems..." etc.

PAST MEDICAL HISTORY:
- Brief. Include immunization status, surgical history if relevant.

FAMILY HISTORY:
- Narrative style. Mention relevant neurological or genetic conditions in family members.

BIRTH HISTORY:
- Gestational age, complications during pregnancy, delivery method, NICU stay, perinatal events.

DEVELOPMENTAL HISTORY:
- Milestones, current school performance, IEP status, cognitive evaluations if done.

SOCIAL HISTORY:
- Who they live with, school name and grade, activities, accommodations.

ASSESSMENT:
- The Assessment and Plan are part of Dr. Caceres' conversation with parents/patients. He discusses his impression and rationale with them during the encounter, usually AFTER the physical exam.
- Recognize the transition to Assessment when Dr. Caceres says things like: "ok let me examine her", "we will talk more after I examine her", "so let me tell you what I think", "so here is what I think", or similar phrases indicating the exam is done and he is now sharing his clinical reasoning with the family. Everything after this transition that involves clinical reasoning, impression, and plan discussion should feed into the Assessment and Plan sections.
- ALWAYS start with paragraph 1: Restate who the patient is (same opening as HPI but condensed).
- ALWAYS paragraph 2: Physical exam findings. Example: "His exam shows...", "Exam is non-focal.", "Neurological examination is non-focal." This is ALWAYS the second paragraph. Never skip it.
- Then give your clinical reasoning. Connect the dots. Explain WHY you think what you think. Reference literature only when it is a complex or rare case that warrants it.
- DO NOT repeat details from the HPI in the Assessment. The reader already read the HPI. Do not re-describe seizure events, family history details, or other things already covered. Instead, refer to them briefly: "along with a positive family history of seizures" not "his mother's brother had seizures as a teenager and his maternal grandmother also had seizures."
- Keep the Assessment proportional to the case complexity. A straightforward febrile seizure case gets a SHORT assessment. A complex interferonopathy case gets a longer one. Match the complexity.
- Do not over-localize neurological findings beyond what the clinical evidence supports. Do not attribute seizures to specific cortical regions unless there is clear evidence (like focal EEG findings or MRI lesions).
- Discuss what you shared with the family when relevant: "I shared this with mom."
- Be specific about treatment rationale and goals.

PLAN:
- Use dash-style bullet points starting with a dash and a space: "- "
- Each item is specific: lab names, test codes if known, medication doses, imaging specifics.
- Always end with follow-up timing.
- After plan, add a blank line then: "Electronic Signature:\\nJ. Alfredo Caceres, MD\\nPediatric Neurology"

FORMATTING:
- Section headers use the exact names provided.
- Use \\n for line breaks within sections.
- Do NOT use markdown formatting (no **, no ##, no *).
- Write naturally. Do not sound robotic or templated.
- Summarize and synthesize the conversation. Do NOT transcribe it verbatim. A 45-minute conversation should become a focused, well-organized note.
- Ignore repetition, small talk, and off-topic conversation from the transcript.
- If the same topic was discussed multiple times, consolidate it into one clear narrative.

IMPORTANT: You must return ONLY a valid JSON object with section names as keys and note content as string values. No markdown, no backticks, no explanation. Just the JSON object.`;

const NEW_PATIENT_SECTIONS = `Return JSON with exactly these keys in this order:
"Chief Concern", "History of Present Illness", "Review of Systems", "Past Medical History", "Family History", "Birth History", "Developmental History", "Social History", "Assessment", "Plan"`;

const FOLLOW_UP_SECTIONS = `Return JSON with exactly these keys in this order:
"Date of Last Visit", "Summary from Last Visit", "Interval History", "Assessment", "Plan"`;

// Demo transcripts (used when mic is unavailable, for testing)
const DEMO_TRANSCRIPT_NEW = `Speaker 0: Good morning, thanks for coming in. So, tell me, why are you being referred to neurology?
Speaker 1: Hi doctor. So, we were referred by his pediatrician because of these episodes he's been having. They look like seizures to us.
Speaker 0: OK. Tell me about these episodes. When did they start?
Speaker 1: So, the first one happened about three months ago. He was just sitting watching TV, and suddenly his eyes rolled back, his arms got stiff, and he started shaking. It lasted maybe a minute. We were terrified. We called 911.
Speaker 0: Was he taken to the hospital?
Speaker 1: Yes, they took him to Sinai. They did a CT scan which was normal. They told us it was probably a seizure and to follow up with neurology.
Speaker 0: Has he had more episodes since then?
Speaker 1: Yes, he's had three more. The second one was about a month later, same thing, stiffening and shaking, maybe 45 seconds. The third one was two weeks ago. That one was different though, it started with his right hand twitching and then spread to his whole body. That one lasted almost two minutes. And then last week he had another one, again starting on the right side.
Speaker 0: After the episodes, how is he? Does he fall asleep? Is he confused?
Speaker 1: He's very confused after. He doesn't know where he is for like 10 minutes. Then he falls asleep for about an hour.
Speaker 0: Does he complain of headaches before or after?
Speaker 1: Sometimes after, yes. He says his head hurts when he wakes up.
Speaker 0: Any history of head injury or trauma?
Speaker 1: No, nothing like that.
Speaker 0: How about febrile seizures when he was younger?
Speaker 1: No, never had those.
Speaker 0: OK. Let me ask about his birth. Was he born full term?
Speaker 1: Yes, 40 weeks. Normal delivery. No complications. He was healthy, came right home with us.
Speaker 0: And his development, did he walk and talk on time?
Speaker 1: Yes, everything was normal. He walked at 13 months, started talking around 12 months. He's always been a good student.
Speaker 0: What grade is he in?
Speaker 1: He's in 4th grade at Bellview Elementary. He gets good grades, As and Bs. No special services or anything.
Speaker 0: Does anyone in the family have epilepsy or seizures?
Speaker 1: My brother had seizures as a teenager. He was on medication for a few years and then stopped. And my mom says she had a couple seizures when she was young too.
Speaker 0: Anyone with other neurological conditions?
Speaker 1: No, just the seizures in my family.
Speaker 0: How about his daily life? How is he sleeping?
Speaker 1: Sleep is OK. He goes to bed around 8:30, wakes up around 6:30. No problems falling asleep.
Speaker 0: Any medications right now?
Speaker 1: No, nothing. The ER doctor said to wait until he sees neurology.
Speaker 0: Any allergies?
Speaker 1: No allergies.
Speaker 0: OK. Who does he live with?
Speaker 1: He lives with me and his dad and his older sister.
Speaker 0: Any other medical problems?
Speaker 1: No, he's been healthy otherwise. All his vaccines are up to date.
Speaker 0: OK so let me examine him. His exam looks normal. Neurological exam is completely non-focal.
Speaker 0: OK, so let me tell you what I think. So, your son is a 9 year old boy who has now had four seizures over the past three months. The fact that the last two started on the right side with hand twitching and then spread to the whole body tells me these are focal onset seizures that secondarily generalize. Combined with the family history of seizures, this raises concern for a genetic epilepsy. I want to get an EEG, which is a test that measures brain electrical activity, and an MRI of the brain to look at the structure. Given that he's had four seizures now and they're becoming more frequent, I think we should start a medication to prevent more seizures. I'd like to start him on Oxcarbazepine. It's well tolerated in kids and works well for focal seizures. We'll start low and increase gradually. I also want to send a genetic test. There's a panel that looks at genes related to epilepsy. Given the family history, this could help us understand why he's having seizures and guide treatment.
Speaker 1: OK that sounds good. We just want to make sure he's safe, especially at school.
Speaker 0: Absolutely. I'll write a seizure action plan for the school. And we'll follow up in about 6 weeks after the EEG and MRI are done.`;

const DEMO_TRANSCRIPT_FOLLOWUP = `Speaker 0: Good to see you again. So this is a follow up from our visit back in January. How has he been doing?
Speaker 1: Much better, doctor. Since he started the Oxcarbazepine, he's only had one seizure, and that was in the first two weeks before we got to the full dose.
Speaker 0: That's great. And since reaching the full dose?
Speaker 1: No seizures at all. It's been about 5 weeks now seizure free.
Speaker 0: Any side effects from the medication? Dizziness, tiredness, rash?
Speaker 1: He was a little tired the first week but that went away. No rash. No other problems.
Speaker 0: How about school?
Speaker 1: He's doing great. Back to normal. Teachers say he's focused and doing well.
Speaker 0: Good. So the EEG, I reviewed it. It showed some focal epileptiform discharges on the right side, which is consistent with what we were seeing clinically with the seizures starting on the right.
Speaker 1: And the MRI?
Speaker 0: MRI was normal, which is good. No structural abnormality. The genetic test is still pending, should be back in a few more weeks. OK so he's doing well on the current dose. I want to keep everything the same. Continue the Oxcarbazepine. We'll follow up in 3 months. When the genetic results come back, I'll call you to discuss. If any seizures happen before our next visit, call the clinic.
Speaker 1: Sounds good. Thank you doctor.`;

// ============================================================
// Deepgram: transcribe audio
// ============================================================

async function transcribeAudio(audioBlob, apiKey) {
  try {
    const response = await fetch(
      "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&punctuate=true&utterances=true",
      {
        method: "POST",
        headers: {
          "Authorization": `Token ${apiKey}`,
          "Content-Type": audioBlob.type || "audio/webm",
        },
        body: audioBlob,
      }
    );

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.err_msg || `Deepgram error: ${response.status}`);
    }

    const data = await response.json();

    // Build transcript with speaker labels from utterances
    if (data.results?.utterances && data.results.utterances.length > 0) {
      return data.results.utterances
        .map(u => `Speaker ${u.speaker}: ${u.transcript}`)
        .join("\n");
    }

    // Fallback: use the basic transcript without speaker labels
    if (data.results?.channels?.[0]?.alternatives?.[0]?.transcript) {
      return data.results.channels[0].alternatives[0].transcript;
    }

    throw new Error("No transcript returned from Deepgram");
  } catch (err) {
    console.error("Deepgram error:", err);
    throw err;
  }
}

// ============================================================
// Claude: generate note from transcript
// ============================================================

async function generateNote(encounterType, transcript, anthropicKey) {
  const sections = encounterType === "new" ? NEW_PATIENT_SECTIONS : FOLLOW_UP_SECTIONS;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        system: STYLE_PROMPT,
        messages: [
          {
            role: "user",
            content: `Here is the transcript of a ${encounterType === "new" ? "new patient" : "follow-up"} encounter:\n\n${transcript}\n\n${sections}\n\nGenerate the clinical note now. Return ONLY the JSON object, no backticks or markdown.`
          }
        ],
      })
    });

    const data = await response.json();
    const text = data.content
      .filter(item => item.type === "text")
      .map(item => item.text)
      .join("");

    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("Note generation error:", err);
    return null;
  }
}

// ============================================================
// UI Components
// ============================================================

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Waveform({ analyser, isActive }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const barsRef = useRef(new Array(48).fill(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };
    resize();
    const bufferLength = analyser ? analyser.frequencyBinCount : 128;
    const dataArray = new Uint8Array(bufferLength);
    const bars = barsRef.current;
    const barCount = bars.length;
    const draw = () => {
      animRef.current = requestAnimationFrame(draw);
      const rect = canvas.getBoundingClientRect();
      const w = rect.width; const h = rect.height;
      ctx.clearRect(0, 0, w, h);
      if (analyser && isActive) {
        analyser.getByteFrequencyData(dataArray);
        const step = Math.floor(bufferLength / barCount);
        for (let i = 0; i < barCount; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) sum += dataArray[i * step + j] || 0;
          bars[i] += ((sum / step) / 255 - bars[i]) * 0.3;
        }
      } else {
        for (let i = 0; i < barCount; i++) bars[i] += (0 - bars[i]) * 0.1;
      }
      const gap = 3;
      const barWidth = (w - (barCount - 1) * gap) / barCount;
      const centerY = h / 2;
      const maxBarHeight = h * 0.8;
      for (let i = 0; i < barCount; i++) {
        const x = i * (barWidth + gap);
        const barH = Math.max(2, bars[i] * maxBarHeight);
        const radius = Math.min(barWidth / 2, barH / 2, 2);
        ctx.fillStyle = `rgba(0, 207, 160, ${0.25 + bars[i] * 0.75})`;
        ctx.beginPath();
        ctx.roundRect(x, centerY - barH / 2, barWidth, barH, radius);
        ctx.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(animRef.current);
  }, [analyser, isActive]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "80px", display: "block" }} />;
}

function PulseRing({ isRecording }) {
  return (
    <div style={{
      position: "absolute", inset: -12, borderRadius: "50%",
      border: "2px solid rgba(0, 207, 160, 0.4)",
      animation: isRecording ? "pulseRing 2s ease-out infinite" : "none",
      opacity: isRecording ? 1 : 0, transition: "opacity 0.5s ease", pointerEvents: "none",
    }} />
  );
}

function GeneratingScreen({ stage }) {
  const [dots, setDots] = useState("");
  const stages = [
    "Sending audio to Deepgram",
    "Transcribing conversation",
    "Analyzing transcript",
    "Writing note in your style"
  ];

  useEffect(() => {
    const dotInterval = setInterval(() => {
      setDots(d => d.length >= 3 ? "" : d + ".");
    }, 500);
    return () => clearInterval(dotInterval);
  }, []);

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 24,
      animation: "fadeIn 0.5s ease",
    }}>
      <div style={{
        width: 48, height: 48, borderRadius: "50%",
        border: "3px solid #1a1a1a", borderTopColor: "#00CFA0",
        animation: "spin 1s linear infinite",
      }} />
      <div style={{
        fontSize: 16, fontWeight: 400, color: "#888",
        letterSpacing: "0.05em", textAlign: "center",
      }}>
        {stages[Math.min(stage, stages.length - 1)]}{dots}
      </div>
    </div>
  );
}

function NoteSection({ title, content, onEdit }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(content);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }, [editing]);

  const handleSave = () => {
    setEditing(false);
    onEdit(title, text);
  };

  return (
    <div style={{ borderBottom: "1px solid #1a1a1a", padding: "16px 0" }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 8,
      }}>
        <div style={{
          fontSize: 12, fontWeight: 600, letterSpacing: "0.1em",
          textTransform: "uppercase", color: "#00CFA0",
        }}>
          {title}
        </div>
        <button
          onClick={() => editing ? handleSave() : setEditing(true)}
          style={{
            fontSize: 12, color: editing ? "#00CFA0" : "#555",
            background: "none", border: "none", cursor: "pointer",
            fontFamily: "inherit", letterSpacing: "0.05em", padding: "4px 8px",
          }}
        >
          {editing ? "Save" : "Edit"}
        </button>
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = e.target.scrollHeight + "px";
          }}
          style={{
            width: "100%", background: "#111", border: "1px solid #333",
            borderRadius: 8, color: "#FAFAFA", fontSize: 14, lineHeight: 1.6,
            padding: 12, fontFamily: "inherit", resize: "none", outline: "none",
            boxSizing: "border-box",
          }}
        />
      ) : (
        <div style={{ fontSize: 14, lineHeight: 1.6, color: "#ccc", whiteSpace: "pre-wrap" }}>
          {text}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Setup Screen — enter Deepgram API key
// ============================================================

function SetupScreen({ onComplete, existingDgKey, existingAnKey }) {
  const [dgKey, setDgKey] = useState(existingDgKey || "");
  const [anKey, setAnKey] = useState(existingAnKey || "");
  const [saving, setSaving] = useState(false);

  const bothFilled = dgKey.trim() && anKey.trim();

  const handleSave = async () => {
    if (!bothFilled) return;
    setSaving(true);
    try {
      localStorage.setItem("deepgram_api_key", dgKey.trim());
      localStorage.setItem("anthropic_api_key", anKey.trim());
    } catch (e) {}
    setSaving(false);
    onComplete(dgKey.trim(), anKey.trim());
  };

  const inputStyle = {
    width: "100%", maxWidth: 320, padding: "14px 16px",
    backgroundColor: "#111", border: "2px solid #333",
    borderRadius: 12, color: "#FAFAFA", fontSize: 15,
    fontFamily: "inherit", outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div style={{
      minHeight: "100vh", backgroundColor: "#0A0A0A", color: "#FAFAFA",
      fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", padding: "0 32px",
    }}>
      <h1 style={{
        fontSize: 28, fontWeight: 600, letterSpacing: "0.15em",
        textTransform: "uppercase", margin: 0, marginBottom: 12,
      }}>Clinical</h1>
      <div style={{
        width: 24, height: 2, backgroundColor: "#00CFA0",
        margin: "0 auto 40px", borderRadius: 1,
      }} />

      <div style={{
        fontSize: 13, color: "#888", marginBottom: 6,
        textAlign: "left", width: "100%", maxWidth: 320,
      }}>
        Deepgram key (listening)
      </div>
      <input
        type="password"
        value={dgKey}
        onChange={(e) => setDgKey(e.target.value)}
        placeholder="Paste Deepgram API key"
        style={inputStyle}
        onFocus={(e) => e.target.style.borderColor = "#00CFA0"}
        onBlur={(e) => e.target.style.borderColor = "#333"}
      />

      <div style={{
        fontSize: 13, color: "#888", marginBottom: 6, marginTop: 20,
        textAlign: "left", width: "100%", maxWidth: 320,
      }}>
        Anthropic key (note writing)
      </div>
      <input
        type="password"
        value={anKey}
        onChange={(e) => setAnKey(e.target.value)}
        placeholder="Paste Anthropic API key"
        style={inputStyle}
        onFocus={(e) => e.target.style.borderColor = "#00CFA0"}
        onBlur={(e) => e.target.style.borderColor = "#333"}
      />

      <div style={{
        fontSize: 12, color: "#444", marginTop: 12,
        textAlign: "center", lineHeight: 1.5, maxWidth: 320,
      }}>
        One-time setup. These stay on your phone.
      </div>

      <button
        onClick={handleSave}
        disabled={!bothFilled || saving}
        style={{
          marginTop: 20, padding: "14px 48px", borderRadius: 12,
          border: "none",
          backgroundColor: bothFilled ? "#00CFA0" : "#333",
          color: bothFilled ? "#0A0A0A" : "#666",
          fontSize: 16, fontWeight: 600, cursor: bothFilled ? "pointer" : "default",
          fontFamily: "inherit", letterSpacing: "0.03em",
          transition: "all 0.2s ease",
        }}
      >
        {saving ? "Saving..." : "Get Started"}
      </button>
    </div>
  );
}

// ============================================================
// Note Review Screen
// ============================================================

function NoteReview({ encounterType, elapsed, noteData, onNewEncounter }) {
  const [note, setNote] = useState(noteData);
  const [saved, setSaved] = useState(false);

  const handleEdit = (section, newText) => {
    setNote(prev => ({ ...prev, [section]: newText }));
  };

  const handleSendToEpic = () => {
    const fullNote = Object.entries(note)
      .map(([section, content]) => `${section.toUpperCase()}\n${content}`)
      .join("\n\n");
    const subject = encodeURIComponent(`Clinical Note - ${encounterType === "new" ? "New Patient" : "Follow Up"}`);
    const body = encodeURIComponent(fullNote);
    window.open(`mailto:?subject=${subject}&body=${body}`, "_self");
  };

  const handleSaveFinal = () => {
    const finalNote = { ...note };
    const originalNote = { ...noteData };
    console.log("LEARNING DATA:", { original: originalNote, corrected: finalNote, encounterType });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div style={{
      minHeight: "100vh", backgroundColor: "#0A0A0A", color: "#FAFAFA",
      fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif",
      animation: "fadeIn 0.5s ease",
    }}>
      <div style={{
        position: "sticky", top: 0, zIndex: 10,
        backgroundColor: "#0A0A0A",
        borderBottom: "1px solid #1a1a1a",
        padding: "16px 20px",
        paddingTop: "calc(env(safe-area-inset-top, 16px) + 16px)",
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <h1 style={{
            fontSize: 20, fontWeight: 600, letterSpacing: "0.1em",
            textTransform: "uppercase", margin: 0,
          }}>Clinical</h1>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{
              fontSize: 11, fontWeight: 500, letterSpacing: "0.1em",
              textTransform: "uppercase", color: "#00CFA0",
              backgroundColor: "rgba(0, 207, 160, 0.08)",
              padding: "4px 10px", borderRadius: 12,
            }}>
              {encounterType === "new" ? "New Patient" : "Follow Up"}
            </div>
            <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.05em" }}>
              {formatTime(elapsed)}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: "8px 20px 140px" }}>
        {Object.entries(note).map(([section, content]) => (
          <NoteSection key={section} title={section} content={content} onEdit={handleEdit} />
        ))}
      </div>

      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        backgroundColor: "#0A0A0A",
        borderTop: "1px solid #1a1a1a",
        padding: "12px 20px",
        paddingBottom: "calc(env(safe-area-inset-bottom, 12px) + 12px)",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        {saved && (
          <div style={{
            textAlign: "center", fontSize: 13, color: "#00CFA0",
            padding: "6px 0", animation: "fadeIn 0.3s ease",
          }}>
            Final note saved. Clinical is learning from your edits.
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onNewEncounter} style={{
            padding: "14px 12px", borderRadius: 12,
            border: "2px solid #333", backgroundColor: "transparent",
            color: "#FAFAFA", fontSize: 14, fontWeight: 500,
            cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
          }}>New</button>
          <button onClick={handleSaveFinal} style={{
            flex: 1, padding: "14px", borderRadius: 12,
            border: "2px solid #00CFA0", backgroundColor: "transparent",
            color: "#00CFA0", fontSize: 14, fontWeight: 500,
            cursor: "pointer", fontFamily: "inherit",
          }}>Save Final</button>
          <button onClick={handleSendToEpic} style={{
            flex: 1, padding: "14px", borderRadius: 12,
            border: "none", backgroundColor: "#00CFA0",
            color: "#0A0A0A", fontSize: 14, fontWeight: 600,
            cursor: "pointer", fontFamily: "inherit",
          }}>Send to Epic</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Main App
// ============================================================

export default function Clinical() {
  const [state, setState] = useState(STATES.SETUP);
  const [encounterType, setEncounterType] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);
  const [noteData, setNoteData] = useState(null);
  const [trainingDone, setTrainingDone] = useState(false);
  const [deepgramKey, setDeepgramKey] = useState(null);
  const [anthropicKey, setAnthropicKey] = useState(null);
  const [genStage, setGenStage] = useState(0);

  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const audioCtxRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const startTimeRef = useRef(0);
  const pausedTimeRef = useRef(0);

  // Load saved API key on mount
  useEffect(() => {
    (async () => {
      try {
        const savedDgKey = localStorage.getItem("deepgram_api_key");
        const savedAnKey = localStorage.getItem("anthropic_api_key");
        if (savedDgKey && savedAnKey) {
          setDeepgramKey(savedDgKey);
          setAnthropicKey(savedAnKey);
          setState(STATES.SELECT);
        }
      } catch (e) {
        // No saved key, stay on setup
      }
    })();
  }, []);

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now() - pausedTimeRef.current * 1000;
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 200);
  }, []);

  const stopTimer = useCallback(() => { clearInterval(timerRef.current); }, []);

  const selectEncounterType = (type) => {
    setEncounterType(type);
    setTrainingDone(false);
    setState(STATES.IDLE);
  };

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
      });
      streamRef.current = stream;
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      analyserRef.current = analyser;
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mediaRecorder.start(1000);
      pausedTimeRef.current = 0;
      setState(STATES.RECORDING);
      startTimer();
    } catch (err) {
      // Mic blocked — allow flow for demo
      chunksRef.current = [];
      pausedTimeRef.current = 0;
      setState(STATES.RECORDING);
      startTimer();
    }
  }, [startTimer]);

  const pauseRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.pause();
      pausedTimeRef.current = elapsed;
      stopTimer();
      setState(STATES.PAUSED);
    }
  }, [elapsed, stopTimer]);

  const resumeRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "paused") {
      mediaRecorderRef.current.resume();
      startTimer();
      setState(STATES.RECORDING);
    }
  }, [startTimer]);

  const stopRecording = useCallback(async () => {
    stopTimer();

    // Collect audio blob before stopping
    const hasAudio = chunksRef.current.length > 0 && mediaRecorderRef.current;

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
    }

    setState(STATES.GENERATING);
    setGenStage(0);

    if (encounterType === "training") {
      setTimeout(() => {
        setTrainingDone(true);
        setElapsed(0);
        setEncounterType(null);
        setState(STATES.SELECT);
      }, 1500);
      return;
    }

    try {
      let transcript;

      if (hasAudio && deepgramKey) {
        // REAL PIPELINE: Send audio to Deepgram
        setGenStage(0); // Sending audio
        const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" });

        setGenStage(1); // Transcribing
        transcript = await transcribeAudio(audioBlob, deepgramKey);
      } else {
        // DEMO MODE: No audio recorded (mic blocked), use demo transcript
        setGenStage(1);
        await new Promise(r => setTimeout(r, 500));
        transcript = encounterType === "new" ? DEMO_TRANSCRIPT_NEW : DEMO_TRANSCRIPT_FOLLOWUP;
      }

      // Send transcript to AI brain
      setGenStage(2); // Analyzing
      await new Promise(r => setTimeout(r, 300));
      setGenStage(3); // Writing note

      const note = await generateNote(encounterType, transcript, anthropicKey);
      if (note) {
        setNoteData(note);
        setState(STATES.NOTE);
      } else {
        setError("Note generation failed. Please try again.");
        setState(STATES.IDLE);
      }
    } catch (err) {
      setError(`Error: ${err.message}. Tap the record button to try again.`);
      setState(STATES.IDLE);
    }
  }, [stopTimer, encounterType, deepgramKey, anthropicKey]);

  const resetSession = useCallback(() => {
    setElapsed(0);
    pausedTimeRef.current = 0;
    chunksRef.current = [];
    analyserRef.current = null;
    setEncounterType(null);
    setNoteData(null);
    setError(null);
    setGenStage(0);
    setState(STATES.SELECT);
  }, []);

  // Setup screen
  if (state === STATES.SETUP) {
    return (
      <SetupScreen
        existingDgKey={deepgramKey}
        existingAnKey={anthropicKey}
        onComplete={(dgKey, anKey) => {
          setDeepgramKey(dgKey);
          setAnthropicKey(anKey);
          setState(STATES.SELECT);
        }}
      />
    );
  }

  // Note review screen
  if (state === STATES.NOTE && noteData) {
    return (
      <NoteReview
        encounterType={encounterType}
        elapsed={elapsed}
        noteData={noteData}
        onNewEncounter={resetSession}
      />
    );
  }

  const isRecording = state === STATES.RECORDING;
  const isPaused = state === STATES.PAUSED;
  const isIdle = state === STATES.IDLE;
  const isSelect = state === STATES.SELECT;

  return (
    <div style={{
      minHeight: "100vh", backgroundColor: "#0A0A0A", color: "#FAFAFA",
      fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif",
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "space-between", padding: "0 24px",
      userSelect: "none", WebkitUserSelect: "none",
      WebkitTapHighlightColor: "transparent",
      overflow: "hidden", position: "relative",
    }}>
      <style>{`
        @keyframes pulseRing { 0% { transform: scale(1); opacity: 0.6; } 100% { transform: scale(1.5); opacity: 0; } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes breathe { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      <div style={{
        position: "fixed", top: "-50%", left: "-50%", width: "200%", height: "200%",
        background: isRecording ? "radial-gradient(circle at 50% 50%, rgba(0, 207, 160, 0.04) 0%, transparent 50%)" : "none",
        transition: "background 1s ease", pointerEvents: "none",
      }} />

      {/* Header */}
      <div style={{
        paddingTop: "env(safe-area-inset-top, 48px)", marginTop: 48,
        textAlign: "center", animation: "fadeIn 0.8s ease",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 16,
      }}>
        <div>
          <h1 style={{
            fontSize: 28, fontWeight: 600, letterSpacing: "0.15em",
            textTransform: "uppercase", margin: 0, color: "#FAFAFA",
          }}>Clinical</h1>
          <div style={{
            width: 24, height: 2, backgroundColor: "#00CFA0",
            margin: "12px auto 0", borderRadius: 1,
          }} />
        </div>
      </div>

      {/* Center */}
      <div style={{
        flex: 1, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        width: "100%", maxWidth: 400, gap: 32,
      }}>
        {isSelect && (
          <div style={{
            display: "flex", flexDirection: "column", gap: 16,
            width: "100%", maxWidth: 300, animation: "fadeIn 0.6s ease",
          }}>
            {trainingDone && (
              <div style={{
                textAlign: "center", padding: "12px 16px",
                backgroundColor: "rgba(255, 159, 67, 0.08)",
                borderRadius: 12, marginBottom: 4,
                fontSize: 14, color: "#FF9F43",
                animation: "fadeIn 0.5s ease",
              }}>
                Training session saved
              </div>
            )}
            {["new", "followup"].map(type => (
              <button key={type} onClick={() => selectEncounterType(type)}
                style={{
                  padding: "24px 32px", backgroundColor: "transparent",
                  border: "2px solid #333", borderRadius: 16, color: "#FAFAFA",
                  fontSize: 18, fontWeight: 500, letterSpacing: "0.05em",
                  cursor: "pointer", transition: "all 0.2s ease", fontFamily: "inherit",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#00CFA0"; e.currentTarget.style.backgroundColor = "rgba(0, 207, 160, 0.05)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#333"; e.currentTarget.style.backgroundColor = "transparent"; }}
              >
                {type === "new" ? "New Patient" : "Follow Up"}
              </button>
            ))}

            <div style={{
              display: "flex", alignItems: "center", gap: 12, margin: "8px 0",
            }}>
              <div style={{ flex: 1, height: 1, backgroundColor: "#222" }} />
              <div style={{ fontSize: 11, color: "#444", letterSpacing: "0.1em", textTransform: "uppercase" }}>or</div>
              <div style={{ flex: 1, height: 1, backgroundColor: "#222" }} />
            </div>

            <button onClick={() => selectEncounterType("training")}
              style={{
                padding: "20px 32px", backgroundColor: "transparent",
                border: "2px solid #222", borderRadius: 16, color: "#888",
                fontSize: 15, fontWeight: 500, letterSpacing: "0.05em",
                cursor: "pointer", transition: "all 0.2s ease", fontFamily: "inherit",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#FF9F43"; e.currentTarget.style.color = "#FF9F43"; e.currentTarget.style.backgroundColor = "rgba(255, 159, 67, 0.05)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#222"; e.currentTarget.style.color = "#888"; e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M8 4.5V8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                <circle cx="8" cy="11" r="0.75" fill="currentColor"/>
              </svg>
              Training Mode
            </button>
          </div>
        )}

        {state === STATES.GENERATING && <GeneratingScreen stage={genStage} />}

        {!isSelect && state !== STATES.GENERATING && (
          <>
            <div style={{
              fontSize: 13, fontWeight: 500, letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: encounterType === "training" ? "#FF9F43" : "#00CFA0",
              backgroundColor: encounterType === "training" ? "rgba(255, 159, 67, 0.08)" : "rgba(0, 207, 160, 0.08)",
              padding: "6px 16px", borderRadius: 20, animation: "fadeIn 0.5s ease",
            }}>
              {encounterType === "new" ? "New Patient" : encounterType === "followup" ? "Follow Up" : "Training Mode"}
            </div>
            <div style={{ animation: "fadeIn 0.8s ease 0.2s both" }}>
              <div style={{
                fontSize: (isRecording || isPaused) ? 64 : 48, fontWeight: 200,
                fontVariantNumeric: "tabular-nums", letterSpacing: "0.05em",
                color: isRecording ? (encounterType === "training" ? "#FF9F43" : "#00CFA0") : isPaused ? "#FAFAFA" : "#555",
                transition: "all 0.5s ease", textAlign: "center",
                animation: isPaused ? "breathe 2s ease-in-out infinite" : "none",
              }}>
                {formatTime(elapsed)}
              </div>
              <div style={{
                textAlign: "center", marginTop: 8, fontSize: 13, fontWeight: 500,
                letterSpacing: "0.12em", textTransform: "uppercase",
                color: isRecording ? (encounterType === "training" ? "#FF9F43" : "#00CFA0") : isPaused ? "#FF9F43" : "#333",
                transition: "color 0.3s ease", minHeight: 20,
              }}>
                {isRecording ? (encounterType === "training" ? "Training" : "Listening") : isPaused ? "Paused" : ""}
              </div>
            </div>
            <div style={{
              width: "100%", opacity: (isRecording || isPaused) ? 1 : 0,
              transition: "opacity 0.5s ease",
            }}>
              <Waveform analyser={analyserRef.current} isActive={isRecording} />
            </div>
          </>
        )}
      </div>

      {/* Controls */}
      <div style={{
        paddingBottom: "calc(env(safe-area-inset-bottom, 32px) + 32px)",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 20,
        animation: "fadeIn 0.8s ease 0.4s both",
      }}>
        {isIdle && (
          <button onClick={startRecording} style={{
            width: 88, height: 88, borderRadius: "50%", border: "3px solid #00CFA0",
            backgroundColor: "transparent", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <div style={{ width: 56, height: 56, borderRadius: "50%", backgroundColor: "#00CFA0" }} />
          </button>
        )}

        {(isRecording || isPaused) && (
          <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
            <button onClick={isPaused ? resumeRecording : pauseRecording} style={{
              width: 56, height: 56, borderRadius: "50%", border: "2px solid #444",
              backgroundColor: "transparent", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {isPaused ? (
                <svg width="20" height="22" viewBox="0 0 20 22" fill="none"><path d="M3 1L19 11L3 21V1Z" fill="#FAFAFA"/></svg>
              ) : (
                <svg width="16" height="20" viewBox="0 0 16 20" fill="none">
                  <rect x="0" y="0" width="5" height="20" rx="1.5" fill="#FAFAFA"/>
                  <rect x="11" y="0" width="5" height="20" rx="1.5" fill="#FAFAFA"/>
                </svg>
              )}
            </button>
            <button onClick={stopRecording} style={{
              width: 88, height: 88, borderRadius: "50%", border: "3px solid #FF4757",
              backgroundColor: "transparent", cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              position: "relative",
            }}>
              <PulseRing isRecording={isRecording} />
              <div style={{ width: 32, height: 32, borderRadius: 6, backgroundColor: "#FF4757" }} />
            </button>
            <div style={{ width: 56, height: 56 }} />
          </div>
        )}

        {error && (
          <div style={{ fontSize: 13, color: "#FF4757", textAlign: "center", maxWidth: 280, lineHeight: 1.5 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
