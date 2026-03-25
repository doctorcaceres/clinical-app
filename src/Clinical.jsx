import { useState, useRef, useEffect, useCallback } from "react";

// ============================================================
// Supabase
// ============================================================
const SUPABASE_URL = "https://rtrzaketgvdggdfhedsn.supabase.co";
const SUPABASE_KEY = "sb_publishable_zPQZ7Zl03zjS_uqvsNb-ug_JzgohYw2";

async function supabaseRequest(path, method = "GET", body = null) {
  const options = { method, headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" } };
  if (method === "POST") options.headers["Prefer"] = "return=representation";
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, options);
  if (!res.ok) throw new Error(`Supabase error: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
async function saveEncounter(encounter) { const rows = await supabaseRequest("/encounters", "POST", encounter); return rows?.[0] || null; }
async function updateEncounter(id, updates) { await supabaseRequest(`/encounters?id=eq.${id}`, "PATCH", updates); }
async function getRecentEncounters() { return await supabaseRequest("/encounters?order=created_at.desc&limit=20"); }
async function deleteEncounter(id) { await supabaseRequest(`/encounters?id=eq.${id}`, "DELETE"); }
async function getLearningData() { const e = await supabaseRequest("/encounters?final_note=not.is.null&order=created_at.desc&limit=10"); return e || []; }

const STATES = { SETUP: "setup", SELECT: "select", IDLE: "idle", RECORDING: "recording", PAUSED: "paused", INSTRUCTIONS: "instructions", PROCESSING: "processing", NOTE: "note", NOTES: "notes" };

// ============================================================
// Deepgram — client-side transcription
// ============================================================
async function transcribeAudio(audioBlob, apiKey) {
  const response = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&punctuate=true&utterances=true&detect_language=true", {
    method: "POST", headers: { "Authorization": `Token ${apiKey}`, "Content-Type": audioBlob.type || "audio/webm" }, body: audioBlob,
  });
  if (!response.ok) { const t = await response.text().catch(() => ""); throw new Error(`Deepgram error ${response.status}: ${t.substring(0, 100)}`); }
  const data = await response.json();
  if (data.results?.utterances?.length > 0) return data.results.utterances.map(u => `Speaker ${u.speaker}: ${u.transcript}`).join("\n");
  if (data.results?.channels?.[0]?.alternatives?.[0]?.transcript) return data.results.channels[0].alternatives[0].transcript;
  throw new Error("No transcript returned");
}

// ============================================================
// Claude note generation (used for Retry from Recent Notes)
// ============================================================
const STYLE_PROMPT = `You are a clinical note generator for Dr. J. Alfredo Caceres, a pediatric neurologist. You will receive a transcript of a clinical encounter and must produce a structured clinical note that matches Dr. Caceres' exact writing style.

CRITICAL STYLE RULES:
- Write in SIMPLE, CLEAR language. English is not Dr. Caceres' first language. No fancy vocabulary.
- NEVER use em dashes. NEVER use filler statements that add no clinical value.
- NEVER use the word 'classic' or phrases like 'classic presentation', 'classic case', 'this is a classic'. Avoid this word entirely.
- Write in a narrative, storytelling style. Use "Per report,", "Per dad,", "Per mom,", "Dad says that..."
- Attribute information to who provided it. Tell the story chronologically.
- The transcript uses speaker labels. Dr. Caceres asks clinical questions. Fix speech recognition errors using medical knowledge.

CHIEF CONCERN: One line.
HPI: Start with "[Age] [sex] with [history], here in my clinic for [reason]. [Who is here] who provides the history." Tell story chronologically. Weave in birth, developmental, social history naturally. School information (grade, school name, academic performance, IEP, special services, cognitive testing) should always be included as a paragraph within the HPI. Never put school information under Developmental History or Social History. It belongs in the HPI narrative. The HPI must have clear paragraph structure. The first sentence is always the one-liner introduction of the patient. Then start a NEW paragraph for the rest of the history. Use multiple paragraphs to organize the HPI naturally — for example, one paragraph for the presenting complaint and timeline, another for birth and developmental history, another for school, another for medications and prior workup. Never write the entire HPI as one large block of text. Use proper punctuation, commas, and sentence flow. Each paragraph should read smoothly and transition naturally to the next.
ROS: Brief or itemized.
PMH: Brief. Include immunization status.
FAMILY HISTORY: Narrative style.
BIRTH HISTORY: Gestational age, complications, delivery, NICU.
DEVELOPMENTAL HISTORY: Milestones, school, IEP.
SOCIAL HISTORY: Who they live with, school, activities.

VIDEO EVALUATION:
- When the doctor says something like 'on this video I see' or 'let me look at this video' or describes what they see in a video, this is clinically important. Include it in the HPI as: 'I evaluated a video on mom's phone which showed [description of what the doctor described seeing].' Never ignore or skip video descriptions.

ASSESSMENT:
- Recognize transition phrases like "let me examine", "let me tell you what I think".
- Paragraph 1: Restate who patient is (condensed).
- Paragraph 2: ALWAYS physical exam findings. Never skip.
- Then clinical reasoning. DO NOT repeat HPI details. Keep proportional to case complexity.
- The Assessment should primarily be captured from the doctor's own clinical reasoning shared out loud with the family during the encounter. The doctor discusses differentials, explains their thinking, and shares their impression with parents as part of the conversation. Listen for this reasoning and use it as the foundation of the Assessment. Do not generate generic assessments — capture what the doctor actually said.
- Discuss what was shared with family when relevant.

PLAN: Dash-style "- " bullets. Specific labs, meds, imaging. End with follow-up timing.
After plan: "Electronic Signature:\\nJ. Alfredo Caceres, MD\\nPediatric Neurology"

DOCTOR'S ADDITIONAL INSTRUCTIONS: When provided, these are directives from the doctor recorded AFTER the encounter. They describe things that should appear in the note but were not necessarily said out loud during the visit. Follow these instructions carefully and weave the requested content naturally into the appropriate sections of the note.

FORMATTING: Use perfect grammar throughout the entire note. Pay close attention to verb tenses — use past tense for events that already happened and present tense for current status. Ensure subject-verb agreement, proper use of articles, and correct punctuation. Proofread the entire note before returning it. Grammatical errors are unacceptable in a medical document.

Return ONLY a valid JSON object. No markdown, no backticks, no explanation.`;

const NEW_SECTIONS = `Return JSON with keys: "Chief Concern", "History of Present Illness", "Review of Systems", "Past Medical History", "Family History", "Birth History", "Developmental History", "Social History", "Assessment", "Plan"`;
const FU_SECTIONS = `Return JSON with keys: "Date of Last Visit", "Summary from Last Visit", "Interval History", "Assessment", "Plan"`;

async function generateNoteLocally(encounterType, transcript, anthropicKey) {
  const sections = encounterType === "new" ? NEW_SECTIONS : FU_SECTIONS;
  let learningContext = "";
  try {
    const past = await getLearningData();
    const corrections = past.filter(e => e.original_note && e.final_note && JSON.stringify(e.original_note) !== JSON.stringify(e.final_note)).slice(0, 3).map(e => {
      const d = []; for (const k of Object.keys(e.original_note)) { if (e.final_note[k] && e.original_note[k] !== e.final_note[k]) d.push(`"${k}": changed from "${e.original_note[k].substring(0,150)}..." to "${e.final_note[k].substring(0,150)}..."`); } return d.join("\n");
    }).filter(d => d.length > 0);
    if (corrections.length > 0) learningContext = `\n\nLEARN FROM PAST CORRECTIONS:\n${corrections.join("\n---\n")}`;
  } catch (e) {}

  let t = transcript; if (t.length > 50000) t = t.substring(0, 50000) + "\n\n[Truncated]";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 8000, system: STYLE_PROMPT + learningContext, messages: [{ role: "user", content: `Transcript of a ${encounterType === "new" ? "new patient" : "follow-up"} encounter:\n\n${t}\n\n${sections}\n\nReturn ONLY the JSON object.` }] }),
  });
  if (!res.ok) { const e = await res.text().catch(() => ""); throw new Error(`Claude error ${res.status}: ${e.substring(0, 100)}`); }
  const data = await res.json();
  const text = data.content.filter(i => i.type === "text").map(i => i.text).join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// Demo transcripts
const DEMO_NEW = `Speaker 0: Good morning. Why are you being referred to neurology?\nSpeaker 1: His pediatrician referred us because of episodes that look like seizures.\nSpeaker 0: Tell me about them.\nSpeaker 1: First one three months ago, watching TV, eyes rolled back, arms stiff, shaking for a minute. We called 911. Took him to Sinai, CT normal.\nSpeaker 0: More episodes since?\nSpeaker 1: Three more. Last two started with right hand twitching then spread to whole body.\nSpeaker 0: After episodes how is he?\nSpeaker 1: Confused for 10 minutes then sleeps for an hour.\nSpeaker 0: Born full term?\nSpeaker 1: Yes, 40 weeks, normal delivery.\nSpeaker 0: Development on time?\nSpeaker 1: Yes. Walked at 13 months, talking at 12. Good student, 4th grade, As and Bs at Bellview Elementary.\nSpeaker 0: Family history of seizures?\nSpeaker 1: My brother had seizures as a teenager. My mom had some when young.\nSpeaker 0: Medications?\nSpeaker 1: None.\nSpeaker 0: Who does he live with?\nSpeaker 1: Me, dad, and older sister.\nSpeaker 0: Let me examine him. Exam is normal, neurological exam non-focal.\nSpeaker 0: So let me tell you what I think. Four seizures in three months, last two starting on the right side. With family history, this raises concern for genetic epilepsy. I want an EEG, MRI, start Oxcarbazepine, and send genetic testing. Follow up in 6 weeks.`;
const DEMO_FU = `Speaker 0: How has he been since the medication?\nSpeaker 1: Much better. One seizure in first two weeks, none since reaching full dose.\nSpeaker 0: Side effects?\nSpeaker 1: Tired first week, went away.\nSpeaker 0: EEG showed focal discharges on right. MRI normal. Genetics pending. Continue same medication. Follow up 3 months.`;

// ============================================================
// UI Components
// ============================================================
function formatTime(s) { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; return h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}` : `${m}:${String(sec).padStart(2,"0")}`; }

function Waveform({ analyser, isActive }) {
  const canvasRef = useRef(null); const animRef = useRef(null); const barsRef = useRef(new Array(48).fill(0));
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); const dpr = window.devicePixelRatio || 1;
    const resize = () => { const r = canvas.getBoundingClientRect(); canvas.width = r.width*dpr; canvas.height = r.height*dpr; ctx.scale(dpr,dpr); }; resize();
    const bl = analyser ? analyser.frequencyBinCount : 128; const da = new Uint8Array(bl); const bars = barsRef.current; const bc = bars.length;
    const draw = () => { animRef.current = requestAnimationFrame(draw); const r = canvas.getBoundingClientRect(); const w = r.width, h = r.height; ctx.clearRect(0,0,w,h);
      if (analyser && isActive) { analyser.getByteFrequencyData(da); const step = Math.floor(bl/bc); for (let i=0;i<bc;i++) { let sum=0; for (let j=0;j<step;j++) sum += da[i*step+j]||0; bars[i] += ((sum/step)/255 - bars[i])*0.3; } } else { for (let i=0;i<bc;i++) bars[i] += (0-bars[i])*0.1; }
      const gap=3, bw=(w-(bc-1)*gap)/bc, cy=h/2, mbh=h*0.8;
      for (let i=0;i<bc;i++) { const x=i*(bw+gap), bh=Math.max(2,bars[i]*mbh), rad=Math.min(bw/2,bh/2,2); ctx.fillStyle=`rgba(0,207,160,${0.25+bars[i]*0.75})`; ctx.beginPath(); ctx.roundRect(x,cy-bh/2,bw,bh,rad); ctx.fill(); }
    }; draw(); return () => cancelAnimationFrame(animRef.current);
  }, [analyser, isActive]);
  return <canvas ref={canvasRef} style={{ width: "100%", height: "80px", display: "block" }} />;
}

function InstructionsScreen({ onSubmit, onSkip, deepgramKey }) {
  const [recording, setRecording] = useState(false);
  const [done, setDone] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [instructionText, setInstructionText] = useState("");
  const mrRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);

  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mrRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(1000);
      setRecording(true);
    } catch (e) { alert("Microphone error: " + e.message); }
  };

  const stopRec = async () => {
    const mr = mrRef.current;
    if (mr && mr.state !== "inactive") {
      await new Promise(resolve => { mr.onstop = resolve; try { mr.stop(); } catch { resolve(); } });
    }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    setRecording(false);
    setTranscribing(true);
    try {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const text = await transcribeAudio(blob, deepgramKey);
      setInstructionText(text);
      setDone(true);
    } catch (e) {
      alert("Could not transcribe instructions: " + e.message);
      setDone(true);
      setInstructionText("");
    }
    setTranscribing(false);
  };

  const bs = { padding: "16px 32px", borderRadius: 12, border: "none", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", width: "100%", maxWidth: 300 };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24, animation: "fadeIn 0.5s ease", padding: "0 24px" }}>
      <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: "0.12em", textTransform: "uppercase", color: "#00CFA0" }}>Recording Complete</div>
      <div style={{ fontSize: 18, fontWeight: 500, color: "#FAFAFA", textAlign: "center", lineHeight: 1.5 }}>
        Add instructions for the note?
      </div>
      <div style={{ fontSize: 13, color: "#666", textAlign: "center", maxWidth: 300, lineHeight: 1.5 }}>
        Dictate anything the note should include that wasn't said during the visit.
      </div>

      {!recording && !done && !transcribing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 300 }}>
          <button onClick={startRec} style={{ ...bs, backgroundColor: "#00CFA0", color: "#0A0A0A" }}>
            🎙 Add Instructions
          </button>
          <button onClick={onSkip} style={{ ...bs, backgroundColor: "transparent", border: "2px solid #333", color: "#888" }}>
            Skip
          </button>
        </div>
      )}

      {recording && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <div style={{ width: 16, height: 16, borderRadius: "50%", backgroundColor: "#FF4757", animation: "breathe 1.5s ease-in-out infinite" }} />
          <div style={{ fontSize: 14, color: "#FF4757", letterSpacing: "0.05em" }}>Recording instructions...</div>
          <button onClick={stopRec} style={{ ...bs, backgroundColor: "#FF4757", color: "#FAFAFA", maxWidth: 200 }}>
            Done
          </button>
        </div>
      )}

      {transcribing && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", border: "3px solid #1a1a1a", borderTopColor: "#00CFA0", animation: "spin 1s linear infinite" }} />
          <div style={{ fontSize: 14, color: "#888" }}>Transcribing your instructions...</div>
        </div>
      )}

      {done && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 300 }}>
          {instructionText && (
            <div style={{ backgroundColor: "#111", border: "1px solid #333", borderRadius: 12, padding: 16, maxHeight: 150, overflowY: "auto" }}>
              <div style={{ fontSize: 11, color: "#00CFA0", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>Your instructions</div>
              <div style={{ fontSize: 14, color: "#ccc", lineHeight: 1.5 }}>{instructionText}</div>
            </div>
          )}
          <button onClick={() => onSubmit(instructionText)} style={{ ...bs, backgroundColor: "#00CFA0", color: "#0A0A0A" }}>
            Send to Note Generation
          </button>
          <button onClick={() => { setDone(false); setInstructionText(""); }} style={{ ...bs, backgroundColor: "transparent", border: "2px solid #333", color: "#888" }}>
            Re-record
          </button>
        </div>
      )}
    </div>
  );
}

function PulseRing({ active }) { return <div style={{ position:"absolute", inset:-12, borderRadius:"50%", border:"2px solid rgba(0,207,160,0.4)", animation: active ? "pulseRing 2s ease-out infinite" : "none", opacity: active?1:0, transition:"opacity 0.5s ease", pointerEvents:"none" }} />; }

function ProcessingScreen({ stage, onDone }) {
  const [dots, setDots] = useState("");
  useEffect(() => { const i = setInterval(() => setDots(d => d.length >= 3 ? "" : d + "."), 500); return () => clearInterval(i); }, []);
  const msgs = { transcribing: "Transcribing your conversation", generating: "Writing your note", done: "Done! Check Recent Notes." };
  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:24, animation:"fadeIn 0.5s ease" }}>
      {stage !== "done" ? (
        <div style={{ width:48, height:48, borderRadius:"50%", border:"3px solid #1a1a1a", borderTopColor:"#00CFA0", animation:"spin 1s linear infinite" }} />
      ) : (
        <div style={{ width:48, height:48, borderRadius:"50%", backgroundColor:"rgba(0,207,160,0.1)", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#00CFA0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </div>
      )}
      <div style={{ fontSize:16, color:"#888", letterSpacing:"0.05em", textAlign:"center", maxWidth:280 }}>
        {msgs[stage]}{stage !== "done" ? dots : ""}
      </div>
      {stage === "done" && (
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8, animation:"fadeIn 0.5s ease" }}>
          <div style={{ fontSize:13, color:"#555", textAlign:"center" }}>Your note is being written by the server. Check Recent Notes in a minute.</div>
          <button onClick={onDone} style={{ marginTop:12, padding:"14px 40px", borderRadius:12, border:"none", backgroundColor:"#00CFA0", color:"#0A0A0A", fontSize:15, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>
            Home
          </button>
        </div>
      )}
    </div>
  );
}

function NoteSection({ title, content, onEdit }) {
  const [editing, setEditing] = useState(false); const [text, setText] = useState(content); const ref = useRef(null);
  useEffect(() => { if (editing && ref.current) { ref.current.focus(); ref.current.style.height = "auto"; ref.current.style.height = ref.current.scrollHeight + "px"; } }, [editing]);
  return (
    <div style={{ borderBottom:"1px solid #1a1a1a", padding:"16px 0" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <div style={{ fontSize:12, fontWeight:600, letterSpacing:"0.1em", textTransform:"uppercase", color:"#00CFA0" }}>{title}</div>
        <button onClick={() => { if (editing) { onEdit(title, text); } setEditing(!editing); }} style={{ fontSize:12, color:editing?"#00CFA0":"#555", background:"none", border:"none", cursor:"pointer", fontFamily:"inherit", padding:"4px 8px" }}>{editing ? "Save" : "Edit"}</button>
      </div>
      {editing ? <textarea ref={ref} value={text} onChange={(e) => { setText(e.target.value); e.target.style.height="auto"; e.target.style.height=e.target.scrollHeight+"px"; }} style={{ width:"100%", background:"#111", border:"1px solid #333", borderRadius:8, color:"#FAFAFA", fontSize:14, lineHeight:1.6, padding:12, fontFamily:"inherit", resize:"none", outline:"none", boxSizing:"border-box" }} />
        : <div style={{ fontSize:14, lineHeight:1.6, color:"#ccc", whiteSpace:"pre-wrap" }}>{text}</div>}
    </div>
  );
}

// ============================================================
// Setup
// ============================================================
function SetupScreen({ onComplete, existingDgKey, existingAnKey }) {
  const [dg, setDg] = useState(existingDgKey||""); const [an, setAn] = useState(existingAnKey||""); const [saving, setSaving] = useState(false);
  const ok = dg.trim() && an.trim();
  const save = () => { if (!ok) return; setSaving(true); try { localStorage.setItem("deepgram_api_key", dg.trim()); localStorage.setItem("anthropic_api_key", an.trim()); } catch(e){} setSaving(false); onComplete(dg.trim(), an.trim()); };
  const is = { width:"100%", maxWidth:320, padding:"14px 16px", backgroundColor:"#111", border:"2px solid #333", borderRadius:12, color:"#FAFAFA", fontSize:15, fontFamily:"inherit", outline:"none", boxSizing:"border-box" };
  return (
    <div style={{ minHeight:"100vh", backgroundColor:"#0A0A0A", color:"#FAFAFA", fontFamily:"'SF Pro Display',-apple-system,BlinkMacSystemFont,sans-serif", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"0 32px" }}>
      <h1 style={{ fontSize:28, fontWeight:600, letterSpacing:"0.15em", textTransform:"uppercase", margin:0, marginBottom:12 }}>Clinical</h1>
      <div style={{ width:24, height:2, backgroundColor:"#00CFA0", margin:"0 auto 40px", borderRadius:1 }} />
      <div style={{ fontSize:13, color:"#888", marginBottom:6, textAlign:"left", width:"100%", maxWidth:320 }}>Deepgram key (listening)</div>
      <input type="password" value={dg} onChange={e=>setDg(e.target.value)} placeholder="Paste Deepgram API key" style={is} onFocus={e=>e.target.style.borderColor="#00CFA0"} onBlur={e=>e.target.style.borderColor="#333"} />
      <div style={{ fontSize:13, color:"#888", marginBottom:6, marginTop:20, textAlign:"left", width:"100%", maxWidth:320 }}>Anthropic key (note writing)</div>
      <input type="password" value={an} onChange={e=>setAn(e.target.value)} placeholder="Paste Anthropic API key" style={is} onFocus={e=>e.target.style.borderColor="#00CFA0"} onBlur={e=>e.target.style.borderColor="#333"} />
      <div style={{ fontSize:12, color:"#444", marginTop:12, textAlign:"center", lineHeight:1.5, maxWidth:320 }}>One-time setup. These stay on your device.</div>
      <button onClick={save} disabled={!ok||saving} style={{ marginTop:20, padding:"14px 48px", borderRadius:12, border:"none", backgroundColor:ok?"#00CFA0":"#333", color:ok?"#0A0A0A":"#666", fontSize:16, fontWeight:600, cursor:ok?"pointer":"default", fontFamily:"inherit", transition:"all 0.2s ease" }}>{saving?"Saving...":"Get Started"}</button>
    </div>
  );
}

// ============================================================
// Note Review
// ============================================================
function NoteReview({ encounterType, elapsed, noteData, encounterId, onNewEncounter }) {
  const [note, setNote] = useState(noteData); const [saved, setSaved] = useState(false);
  const handleEdit = (section, newText) => setNote(prev => ({ ...prev, [section]: newText }));
  const handleSend = () => { const full = Object.entries(note).map(([s,c]) => `${s.toUpperCase()}\n${c}`).join("\n\n"); const subj = encodeURIComponent(`Clinical Note - ${encounterType === "new" ? "New Patient" : "Follow Up"}`); window.open(`mailto:?subject=${subj}&body=${encodeURIComponent(full)}`, "_self"); };
  const handleSave = async () => { setSaved(true); try { if (encounterId) await updateEncounter(encounterId, { final_note: note, status: "finalized", updated_at: new Date().toISOString() }); } catch(e){} setTimeout(() => setSaved(false), 3000); };

  return (
    <div style={{ minHeight:"100vh", backgroundColor:"#0A0A0A", color:"#FAFAFA", fontFamily:"'SF Pro Display',-apple-system,BlinkMacSystemFont,sans-serif", animation:"fadeIn 0.5s ease" }}>
      <div style={{ position:"sticky", top:0, zIndex:10, backgroundColor:"#0A0A0A", borderBottom:"1px solid #1a1a1a", padding:"16px 20px", paddingTop:"calc(env(safe-area-inset-top,16px) + 16px)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <h1 style={{ fontSize:20, fontWeight:600, letterSpacing:"0.1em", textTransform:"uppercase", margin:0 }}>Clinical</h1>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <div style={{ fontSize:11, fontWeight:500, letterSpacing:"0.1em", textTransform:"uppercase", color:"#00CFA0", backgroundColor:"rgba(0,207,160,0.08)", padding:"4px 10px", borderRadius:12 }}>{encounterType === "new" ? "New Patient" : "Follow Up"}</div>
            <div style={{ fontSize:11, color:"#555" }}>{formatTime(elapsed)}</div>
          </div>
        </div>
      </div>
      <div style={{ padding:"8px 20px 140px" }}>
        {(encounterType === "new" ? ["Chief Concern","History of Present Illness","Review of Systems","Past Medical History","Family History","Birth History","Developmental History","Social History","Assessment","Plan"] : ["Date of Last Visit","Summary from Last Visit","Interval History","Assessment","Plan"]).filter(s => note[s]).map(s => <NoteSection key={s} title={s} content={note[s]} onEdit={handleEdit} />)}
      </div>
      <div style={{ position:"fixed", bottom:0, left:0, right:0, backgroundColor:"#0A0A0A", borderTop:"1px solid #1a1a1a", padding:"12px 20px", paddingBottom:"calc(env(safe-area-inset-bottom,12px) + 12px)", display:"flex", flexDirection:"column", gap:10 }}>
        {saved && <div style={{ textAlign:"center", fontSize:13, color:"#00CFA0", padding:"6px 0", animation:"fadeIn 0.3s ease" }}>Final note saved. Clinical is learning from your edits.</div>}
        <div style={{ display:"flex", gap:10 }}>
          <button onClick={onNewEncounter} style={{ padding:"14px 12px", borderRadius:12, border:"2px solid #333", backgroundColor:"transparent", color:"#FAFAFA", fontSize:14, fontWeight:500, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>New</button>
          <button onClick={handleSave} style={{ flex:1, padding:"14px", borderRadius:12, border:"2px solid #00CFA0", backgroundColor:"transparent", color:"#00CFA0", fontSize:14, fontWeight:500, cursor:"pointer", fontFamily:"inherit" }}>Save Final</button>
          <button onClick={handleSend} style={{ flex:1, padding:"14px", borderRadius:12, border:"none", backgroundColor:"#00CFA0", color:"#0A0A0A", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>Send to Epic</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Recent Notes
// ============================================================
function RecentNotes({ onBack, onOpenNote, anthropicKey }) {
  const [encounters, setEncounters] = useState([]); const [loading, setLoading] = useState(true); const [generating, setGenerating] = useState(null); const [deleting, setDeleting] = useState(null);
  const load = async () => { try { const d = await getRecentEncounters(); setEncounters(d||[]); } catch(e){} setLoading(false); };
  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, []);

  const handleGen = async (enc) => {
    if (!anthropicKey) { alert("Anthropic API key not found."); return; }
    if (!enc.transcript) { alert("No transcript available for this encounter."); return; }
    setGenerating(enc.id);
    try {
      const res = await fetch("/api/generate-note", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ encounter_id: enc.id, encounter_type: enc.encounter_type, anthropic_key: anthropicKey }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `Server error ${res.status}`); }
    } catch(e) {
      alert("Retry failed: " + e.message);
      try { await updateEncounter(enc.id, { status: "error" }); } catch {}
    }
    setGenerating(null); load();
  };

  const handleDelete = async (enc) => {
    if (!window.confirm("Delete this encounter? This cannot be undone.")) return;
    setDeleting(enc.id);
    try { await deleteEncounter(enc.id); } catch(e) {}
    setDeleting(null); load();
  };

  const fmt = (d) => new Date(d).toLocaleDateString("en-US", { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });

  return (
    <div style={{ minHeight:"100vh", backgroundColor:"#0A0A0A", color:"#FAFAFA", fontFamily:"'SF Pro Display',-apple-system,BlinkMacSystemFont,sans-serif" }}>
      <div style={{ position:"sticky", top:0, zIndex:10, backgroundColor:"#0A0A0A", borderBottom:"1px solid #1a1a1a", padding:"16px 20px", paddingTop:"calc(env(safe-area-inset-top,16px) + 16px)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <h1 style={{ fontSize:20, fontWeight:600, letterSpacing:"0.1em", textTransform:"uppercase", margin:0 }}>Recent Notes</h1>
        <button onClick={onBack} style={{ fontSize:14, color:"#00CFA0", background:"none", border:"none", cursor:"pointer", fontFamily:"inherit" }}>Back</button>
      </div>
      <div style={{ padding:"12px 20px" }}>
        {loading && <div style={{ textAlign:"center", color:"#555", padding:40, fontSize:15 }}>Loading...</div>}
        {!loading && encounters.length === 0 && <div style={{ textAlign:"center", color:"#555", padding:40, fontSize:15 }}>No encounters yet.</div>}
        {encounters.map(enc => {
          const proc = enc.status === "processing"; const err = enc.status === "error"; const hasNote = !!enc.original_note; const isGen = generating === enc.id;
          return (
            <div key={enc.id} style={{ padding:"16px", marginBottom:8, backgroundColor:"#111", border:`1px solid ${err?"#FF4757":"#1a1a1a"}`, borderRadius:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:11, fontWeight:500, letterSpacing:"0.1em", textTransform:"uppercase", color: proc||isGen ? "#FF9F43" : err ? "#FF4757" : enc.status==="finalized" ? "#555" : "#00CFA0", marginBottom:4 }}>
                    {enc.encounter_type === "new" ? "New Patient" : "Follow Up"}{(proc||isGen) && " • Processing..."}{err && " • Error"}{enc.status==="finalized" && " • Finalized"}
                  </div>
                  <div style={{ fontSize:14, color:"#ccc" }}>{hasNote ? (enc.original_note?.["Chief Concern"] || enc.original_note?.["Interval History"]?.substring(0,60)+"..." || "Note") : proc||isGen ? "Transcribing and writing note..." : err && enc.transcript ? "Has transcript — tap Retry" : err ? "Processing failed" : enc.transcript ? "Transcript saved" : "Waiting..."}</div>
                </div>
                <div style={{ fontSize:12, color:"#555", whiteSpace:"nowrap", marginLeft:12 }}>{fmt(enc.created_at)}</div>
              </div>
              <div style={{ display:"flex", gap:8, marginTop:10 }}>
                {hasNote && <button onClick={() => onOpenNote(enc)} style={{ padding:"8px 16px", borderRadius:8, border:"1px solid #333", backgroundColor:"transparent", color:"#FAFAFA", fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>Open</button>}
                {(err && enc.transcript) && <button onClick={() => handleGen(enc)} style={{ padding:"8px 16px", borderRadius:8, border:"1px solid #FF9F43", backgroundColor:"transparent", color:"#FF9F43", fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>Retry</button>}
                {(proc||isGen) && <div style={{ padding:"8px 16px", fontSize:13, color:"#FF9F43", display:"flex", alignItems:"center", gap:6 }}><div style={{ width:8, height:8, borderRadius:"50%", backgroundColor:"#FF9F43", animation:"breathe 2s ease-in-out infinite" }} />Processing</div>}
                <button onClick={() => handleDelete(enc)} disabled={deleting===enc.id} style={{ marginLeft:"auto", padding:"8px 16px", borderRadius:8, border:"1px solid #FF4757", backgroundColor:"transparent", color:"#FF4757", fontSize:13, cursor: deleting===enc.id ? "default" : "pointer", fontFamily:"inherit", opacity: deleting===enc.id ? 0.5 : 1 }}>{deleting===enc.id ? "Deleting..." : "Delete"}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Main App — Simple and reliable
// ============================================================
export default function Clinical() {
  const [state, setState] = useState(STATES.SETUP);
  const [encounterType, setEncounterType] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);
  const [noteData, setNoteData] = useState(null);
  const [encounterId, setEncounterId] = useState(null);
  const [trainingDone, setTrainingDone] = useState(false);
  const [deepgramKey, setDeepgramKey] = useState(null);
  const [anthropicKey, setAnthropicKey] = useState(null);
  const [processStage, setProcessStage] = useState("transcribing");
  const [noteSent, setNoteSent] = useState(false);
  const [audioBlobForProcessing, setAudioBlobForProcessing] = useState(null);

  const mediaRecorderRef = useRef(null); const streamRef = useRef(null); const analyserRef = useRef(null);
  const audioCtxRef = useRef(null); const chunksRef = useRef([]); const timerRef = useRef(null);
  const startTimeRef = useRef(0); const pausedTimeRef = useRef(0); const wakeLockRef = useRef(null);
  const isRecordingRef = useRef(false);

  useEffect(() => { try { const dg = localStorage.getItem("deepgram_api_key"); const an = localStorage.getItem("anthropic_api_key"); if (dg && an) { setDeepgramKey(dg); setAnthropicKey(an); setState(STATES.SELECT); } } catch(e){} }, []);

  const startTimer = useCallback(() => { startTimeRef.current = Date.now() - pausedTimeRef.current*1000; timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now()-startTimeRef.current)/1000)), 200); }, []);
  const stopTimer = useCallback(() => clearInterval(timerRef.current), []);
  const selectType = (type) => { setEncounterType(type); setTrainingDone(false); setNoteSent(false); setState(STATES.IDLE); };

  // Wake lock — keeps screen on during recording
  const acquireWakeLock = useCallback(async () => {
    try { if ('wakeLock' in navigator) wakeLockRef.current = await navigator.wakeLock.request('screen'); } catch {}
  }, []);

  // Re-acquire wake lock when app comes back to foreground
  useEffect(() => {
    const handler = () => {
      if (isRecordingRef.current && document.visibilityState === "visible") acquireWakeLock();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [acquireWakeLock]);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true, sampleRate:44100 } });
      streamRef.current = stream;
      const actx = new (window.AudioContext||window.webkitAudioContext)(); audioCtxRef.current = actx;
      const src = actx.createMediaStreamSource(stream); const ana = actx.createAnalyser(); ana.fftSize=256; ana.smoothingTimeConstant=0.7; src.connect(ana); analyserRef.current = ana;
      const mr = new MediaRecorder(stream, { mimeType:"audio/webm" }); mediaRecorderRef.current = mr; chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(1000); pausedTimeRef.current = 0; isRecordingRef.current = true;
      setState(STATES.RECORDING); startTimer();
      await acquireWakeLock();
    } catch(err) { setError("Could not access microphone: " + err.message); }
  }, [startTimer, acquireWakeLock]);

  const pauseRecording = useCallback(() => { if (mediaRecorderRef.current?.state==="recording") { mediaRecorderRef.current.pause(); pausedTimeRef.current=elapsed; stopTimer(); setState(STATES.PAUSED); } }, [elapsed, stopTimer]);
  const resumeRecording = useCallback(() => { if (mediaRecorderRef.current?.state==="paused") { mediaRecorderRef.current.resume(); startTimer(); setState(STATES.RECORDING); } }, [startTimer]);

  const stopRecording = useCallback(async () => {
    // 1. Stop timer and intervals
    stopTimer(); isRecordingRef.current = false;
    try { if (wakeLockRef.current) { await wakeLockRef.current.release(); wakeLockRef.current=null; } } catch {}

    // 2. Stop MediaRecorder — wait for final data
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      await new Promise(resolve => { mr.onstop = resolve; try { mr.stop(); } catch { resolve(); } });
    }

    // 3. Kill microphone (yellow light off)
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (audioCtxRef.current) try { audioCtxRef.current.close(); } catch {}

    // 4. Training mode — just reset
    if (encounterType === "training") {
      setState(STATES.PROCESSING); setTimeout(() => { setTrainingDone(true); setElapsed(0); setEncounterType(null); setState(STATES.SELECT); }, 1500); return;
    }

    // 5. Build audio blob
    if (chunksRef.current.length === 0) { setError("No audio recorded."); setState(STATES.IDLE); return; }
    const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" });
    setAudioBlobForProcessing(audioBlob);

    // 6. Go to instructions screen
    setState(STATES.INSTRUCTIONS);
  }, [stopTimer, encounterType]);

  const processEncounter = useCallback(async (doctorInstructions = "") => {
    setState(STATES.PROCESSING); setProcessStage("transcribing");
    try {
      const transcript = await transcribeAudio(audioBlobForProcessing, deepgramKey);

      setProcessStage("generating");
      const savedEnc = await saveEncounter({
        encounter_type: encounterType, transcript, elapsed, status: "processing",
        doctor_instructions: doctorInstructions || null,
      });

      if (savedEnc) {
        setEncounterId(savedEnc.id);
        fetch("/api/generate-note", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ encounter_id: savedEnc.id, encounter_type: encounterType, anthropic_key: anthropicKey }),
          keepalive: true,
        }).catch(() => {});
      }

      setNoteSent(true);
      setProcessStage("done");
    } catch (err) {
      setError("Transcription failed: " + err.message);
      setState(STATES.IDLE);
    }
  }, [audioBlobForProcessing, deepgramKey, encounterType, anthropicKey, elapsed]);

  const reset = useCallback(() => {
    setElapsed(0); pausedTimeRef.current=0; chunksRef.current=[]; analyserRef.current=null;
    setEncounterType(null); setNoteData(null); setEncounterId(null); setError(null); setProcessStage("transcribing"); setNoteSent(false);
    setState(STATES.SELECT);
  }, []);

  if (state === STATES.SETUP) return <SetupScreen existingDgKey={deepgramKey} existingAnKey={anthropicKey} onComplete={(d,a) => { setDeepgramKey(d); setAnthropicKey(a); setState(STATES.SELECT); }} />;
  if (state === STATES.NOTE && noteData) return <NoteReview encounterType={encounterType} elapsed={elapsed} noteData={noteData} encounterId={encounterId} onNewEncounter={reset} />;
  if (state === STATES.NOTES) return <RecentNotes onBack={() => setState(STATES.SELECT)} anthropicKey={anthropicKey} onOpenNote={(enc) => { setEncounterType(enc.encounter_type); setElapsed(enc.elapsed||0); setNoteData(enc.final_note||enc.original_note); setEncounterId(enc.id); setState(STATES.NOTE); }} />;

  const isRec = state === STATES.RECORDING, isPau = state === STATES.PAUSED, isIdl = state === STATES.IDLE, isSel = state === STATES.SELECT, isProc = state === STATES.PROCESSING, isInstr = state === STATES.INSTRUCTIONS;

  return (
    <div style={{ minHeight:"100vh", backgroundColor:"#0A0A0A", color:"#FAFAFA", fontFamily:"'SF Pro Display',-apple-system,BlinkMacSystemFont,sans-serif", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"space-between", padding:"0 24px", userSelect:"none", WebkitUserSelect:"none", WebkitTapHighlightColor:"transparent", overflow:"hidden", position:"relative" }}>
      <style>{`@keyframes pulseRing{0%{transform:scale(1);opacity:.6}100%{transform:scale(1.5);opacity:0}}@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}@keyframes breathe{0%,100%{opacity:.5}50%{opacity:1}}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ position:"fixed", top:"-50%", left:"-50%", width:"200%", height:"200%", background: isRec ? "radial-gradient(circle at 50% 50%, rgba(0,207,160,0.04) 0%, transparent 50%)" : "none", transition:"background 1s ease", pointerEvents:"none" }} />

      <div style={{ paddingTop:"env(safe-area-inset-top,48px)", marginTop:48, textAlign:"center", animation:"fadeIn 0.8s ease" }}>
        <h1 style={{ fontSize:28, fontWeight:600, letterSpacing:"0.15em", textTransform:"uppercase", margin:0, color:"#FAFAFA" }}>Clinical</h1>
        <div style={{ width:24, height:2, backgroundColor:"#00CFA0", margin:"12px auto 0", borderRadius:1 }} />
      </div>

      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", width:"100%", maxWidth:400, gap:32 }}>
        {isSel && (
          <div style={{ display:"flex", flexDirection:"column", gap:16, width:"100%", maxWidth:300, animation:"fadeIn 0.6s ease" }}>
            {trainingDone && <div style={{ textAlign:"center", padding:"12px 16px", backgroundColor:"rgba(255,159,67,0.08)", borderRadius:12, marginBottom:4, fontSize:14, color:"#FF9F43", animation:"fadeIn 0.5s ease" }}>Training session saved</div>}
            {noteSent && <div style={{ textAlign:"center", padding:"12px 16px", backgroundColor:"rgba(0,207,160,0.08)", borderRadius:12, marginBottom:4, fontSize:14, color:"#00CFA0", animation:"fadeIn 0.5s ease" }}>Note is being written. Check Recent Notes.</div>}
            {["new","followup"].map(type => (
              <button key={type} onClick={() => selectType(type)} style={{ padding:"24px 32px", backgroundColor:"transparent", border:"2px solid #333", borderRadius:16, color:"#FAFAFA", fontSize:18, fontWeight:500, letterSpacing:"0.05em", cursor:"pointer", transition:"all 0.2s ease", fontFamily:"inherit" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor="#00CFA0"; e.currentTarget.style.backgroundColor="rgba(0,207,160,0.05)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor="#333"; e.currentTarget.style.backgroundColor="transparent"; }}>
                {type === "new" ? "New Patient" : "Follow Up"}
              </button>
            ))}
            <div style={{ display:"flex", alignItems:"center", gap:12, margin:"8px 0" }}><div style={{ flex:1, height:1, backgroundColor:"#222" }} /><div style={{ fontSize:11, color:"#444", letterSpacing:"0.1em", textTransform:"uppercase" }}>or</div><div style={{ flex:1, height:1, backgroundColor:"#222" }} /></div>
            <button onClick={() => selectType("training")} style={{ padding:"20px 32px", backgroundColor:"transparent", border:"2px solid #222", borderRadius:16, color:"#888", fontSize:15, fontWeight:500, cursor:"pointer", transition:"all 0.2s ease", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}
              onMouseEnter={e => { e.currentTarget.style.borderColor="#FF9F43"; e.currentTarget.style.color="#FF9F43"; e.currentTarget.style.backgroundColor="rgba(255,159,67,0.05)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor="#222"; e.currentTarget.style.color="#888"; e.currentTarget.style.backgroundColor="transparent"; }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/><path d="M8 4.5V8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><circle cx="8" cy="11" r="0.75" fill="currentColor"/></svg>
              Training Mode
            </button>
            <button onClick={() => setState(STATES.NOTES)} style={{ padding:"20px 32px", backgroundColor:"transparent", border:"2px solid #222", borderRadius:16, color:"#888", fontSize:15, fontWeight:500, cursor:"pointer", transition:"all 0.2s ease", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}
              onMouseEnter={e => { e.currentTarget.style.borderColor="#00CFA0"; e.currentTarget.style.color="#00CFA0"; e.currentTarget.style.backgroundColor="rgba(0,207,160,0.05)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor="#222"; e.currentTarget.style.color="#888"; e.currentTarget.style.backgroundColor="transparent"; }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/><line x1="5" y1="5.5" x2="11" y2="5.5" stroke="currentColor" strokeWidth="1.2"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.2"/><line x1="5" y1="10.5" x2="9" y2="10.5" stroke="currentColor" strokeWidth="1.2"/></svg>
              Recent Notes
            </button>
          </div>
        )}

        {isInstr && <InstructionsScreen deepgramKey={deepgramKey} onSubmit={(text) => processEncounter(text)} onSkip={() => processEncounter("")} />}
        {isProc && <ProcessingScreen stage={processStage} onDone={reset} />}

        {!isSel && !isProc && !isInstr && (
          <>
            <div style={{ fontSize:13, fontWeight:500, letterSpacing:"0.12em", textTransform:"uppercase", color: encounterType==="training" ? "#FF9F43" : "#00CFA0", backgroundColor: encounterType==="training" ? "rgba(255,159,67,0.08)" : "rgba(0,207,160,0.08)", padding:"6px 16px", borderRadius:20, animation:"fadeIn 0.5s ease" }}>
              {encounterType === "new" ? "New Patient" : encounterType === "followup" ? "Follow Up" : "Training Mode"}
            </div>
            <div style={{ animation:"fadeIn 0.8s ease 0.2s both" }}>
              <div style={{ fontSize:(isRec||isPau)?64:48, fontWeight:200, fontVariantNumeric:"tabular-nums", letterSpacing:"0.05em", color: isRec ? (encounterType==="training"?"#FF9F43":"#00CFA0") : isPau ? "#FAFAFA" : "#555", transition:"all 0.5s ease", textAlign:"center", animation: isPau ? "breathe 2s ease-in-out infinite" : "none" }}>{formatTime(elapsed)}</div>
              <div style={{ textAlign:"center", marginTop:8, fontSize:13, fontWeight:500, letterSpacing:"0.12em", textTransform:"uppercase", color: isRec ? (encounterType==="training"?"#FF9F43":"#00CFA0") : isPau ? "#FF9F43" : "#333", transition:"color 0.3s ease", minHeight:20 }}>
                {isRec ? (encounterType==="training" ? "Training" : "Listening") : isPau ? "Paused" : ""}
              </div>
            </div>
            <div style={{ width:"100%", opacity:(isRec||isPau)?1:0, transition:"opacity 0.5s ease" }}><Waveform analyser={analyserRef.current} isActive={isRec} /></div>
          </>
        )}
      </div>

      <div style={{ paddingBottom:"calc(env(safe-area-inset-bottom,32px) + 32px)", display:"flex", flexDirection:"column", alignItems:"center", gap:20, animation:"fadeIn 0.8s ease 0.4s both" }}>
        {isIdl && <button onClick={startRecording} style={{ width:88, height:88, borderRadius:"50%", border:"3px solid #00CFA0", backgroundColor:"transparent", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}><div style={{ width:56, height:56, borderRadius:"50%", backgroundColor:"#00CFA0" }} /></button>}
        {(isRec||isPau) && (
          <div style={{ display:"flex", alignItems:"center", gap:32 }}>
            <button onClick={isPau ? resumeRecording : pauseRecording} style={{ width:56, height:56, borderRadius:"50%", border:"2px solid #444", backgroundColor:"transparent", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
              {isPau ? <svg width="20" height="22" viewBox="0 0 20 22" fill="none"><path d="M3 1L19 11L3 21V1Z" fill="#FAFAFA"/></svg>
                : <svg width="16" height="20" viewBox="0 0 16 20" fill="none"><rect x="0" y="0" width="5" height="20" rx="1.5" fill="#FAFAFA"/><rect x="11" y="0" width="5" height="20" rx="1.5" fill="#FAFAFA"/></svg>}
            </button>
            <button onClick={stopRecording} style={{ width:88, height:88, borderRadius:"50%", border:"3px solid #FF4757", backgroundColor:"transparent", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", position:"relative" }}>
              <PulseRing active={isRec} /><div style={{ width:32, height:32, borderRadius:6, backgroundColor:"#FF4757" }} />
            </button>
            <div style={{ width:56, height:56 }} />
          </div>
        )}
        {error && <div style={{ fontSize:13, color:"#FF4757", textAlign:"center", maxWidth:280, lineHeight:1.5 }}>{error}</div>}
      </div>
    </div>
  );
}
