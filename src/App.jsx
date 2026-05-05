import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase } from "./supabase.js";

// ─── STORAGE ─────────────────────────────────────────────────────────────────
const SK_GLOBAL = { workspaces:"fin_workspaces", activeWs:"fin_active_ws", dismissedBanner:"fin_dismissed_banner" };
const load   = (k,fb) => { try { const r=localStorage.getItem(k); return r?JSON.parse(r):fb; } catch { return fb; } };
const save   = (k,v)  => { try { localStorage.setItem(k,JSON.stringify(v)); } catch {} };
const wsKey  = (id,f) => `fin_ws_${id}_${f}`;
const loadWs = (id,f,fb) => load(wsKey(id,f),fb);
const saveWs = (id,f,v)  => save(wsKey(id,f),v);

const DEFAULT_WORKSPACES = [{ id:"personal", name:"Personal", emoji:"👤", createdAt:new Date().toISOString() }];
const DEFAULT_FX = [
  { id:"f1", name:"Alquiler",    amount:0, dueDay:1,  autoRegister:false },
  { id:"f2", name:"Gimnasio",    amount:0, dueDay:5,  autoRegister:false },
  { id:"f3", name:"Personal",    amount:0, dueDay:10, autoRegister:false },
  { id:"f4", name:"Contador",    amount:0, dueDay:15, autoRegister:false },
  { id:"f5", name:"Monotributo", amount:0, dueDay:20, autoRegister:false },
];

// ─── BACKUP ──────────────────────────────────────────────────────────────────
function exportBackupJSON(wsId, wsName, transactions, fixedExpenses, budgets) {
  const now = new Date();
  const mn  = now.toLocaleDateString("es-AR",{month:"long",year:"numeric"}).replace(" de "," ").replace(" ","-");
  const payload = { version:3, exportedAt:now.toISOString(), workspace:wsId, workspaceName:wsName,
    month:`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`, transactions, fixedExpenses, budgets };
  const blob = new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `finanzas_${wsName.toLowerCase()}_${mn}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  return now.toISOString();
}
function importBackupJSON(file, onSuccess, onError) {
  const r = new FileReader();
  r.onload = e => { try { const d=JSON.parse(e.target.result); if(!Array.isArray(d.transactions)) throw 0; onSuccess(d); } catch { onError(); } };
  r.readAsText(file);
}
function exportCSV(txs, wsName) {
  const rows = txs.map(t=>`"${fmtDate(t.date)}","${t.type==="expense"?"Gasto":"Ingreso"}","${CATS[t.category]?.label??t.category}","${t.description}","${t.note||""}","${t.type==="expense"?"-":"+"}${t.amount}"`);
  const blob = new Blob([["Fecha,Tipo,Categoría,Descripción,Nota,Monto",...rows].join("\n")],{type:"text/csv;charset=utf-8;"});
  const a = document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=`finanzas_${wsName.toLowerCase()}_${new Date().toISOString().slice(0,10)}.csv`; a.click();
}

// ─── PARSER ──────────────────────────────────────────────────────────────────
const INCOME_KW = ["sueldo","salario","freelance","cobré","cobro","ingreso","honorarios","pago","transferencia","recibí","recibo","venta","factura","cobrado","entrada","ganancia"];
const CATS = {
  uber:            { label:"Uber",          icon:"🚗", color:"#6366f1" },
  res:             { label:"RES",           icon:"🥩", color:"#ef4444" },
  verduleria:      { label:"Verdulería",    icon:"🥬", color:"#22c55e" },
  super:           { label:"Super",         icon:"🛒", color:"#f59e0b" },
  alquiler:        { label:"Alquiler",      icon:"🏠", color:"#8b5cf6" },
  gimnasio:        { label:"Gimnasio",      icon:"💪", color:"#06b6d4" },
  luz:             { label:"Luz",           icon:"💡", color:"#eab308" },
  personal:        { label:"Personal",      icon:"📱", color:"#ec4899" },
  tarjeta:         { label:"Tarjeta",       icon:"💳", color:"#f97316" },
  contador:        { label:"Contador",      icon:"📊", color:"#14b8a6" },
  monotributo:     { label:"Monotributo",   icon:"📋", color:"#a855f7" },
  sueldo:          { label:"Sueldo",        icon:"💰", color:"#22c55e" },
  freelance:       { label:"Freelance",     icon:"💻", color:"#10b981" },
  transferencia:   { label:"Transferencia", icon:"🔄", color:"#06b6d4" },
  comida:          { label:"Comida",        icon:"🍽️", color:"#f59e0b" },
  transporte:      { label:"Transporte",    icon:"🚌", color:"#6366f1" },
  salud:           { label:"Salud",         icon:"🏥", color:"#ef4444" },
  entretenimiento: { label:"Entretenim.",   icon:"🎮", color:"#8b5cf6" },
  cafe:            { label:"Café",          icon:"☕", color:"#a16207" },
  ropa:            { label:"Ropa",          icon:"👕", color:"#db2777" },
  ingreso:         { label:"Ingreso",       icon:"💸", color:"#22c55e" },
  otro:            { label:"Otro",          icon:"📌", color:"#64748b" },
};

function detectCat(text, forceIncome=false) {
  if (forceIncome) return "ingreso";
  const t = text.toLowerCase();
  for (const k of Object.keys(CATS)) if (t.includes(k)) return k;
  if (t.includes("taxi")||t.includes("cabify")||t.includes("remis")) return "transporte";
  if (t.includes("resta")||t.includes("pizza")||t.includes("sushi")||t.includes("empan")) return "comida";
  if (t.includes("farma")||t.includes("doctor")||t.includes("medicam")) return "salud";
  if (t.includes("café")||t.includes("coffee")||t.includes("starbucks")) return "cafe";
  if (t.includes("netflix")||t.includes("spotify")||t.includes("cine")||t.includes("disney")) return "entretenimiento";
  if (t.includes("ropa")||t.includes("camis")||t.includes("zapatill")) return "ropa";
  return "otro";
}

function parseInput(raw, forceType=null) {
  const text = raw.trim();
  if (!text) return null;
  const nums = text.match(/\d[\d.,]*/g);
  if (!nums) return null;
  const raw = nums[nums.length-1];
  // Detect format: if last separator is "," treat as AR (1.500,50); if "." treat as decimal (1500.50)
  const lastComma = raw.lastIndexOf(","), lastDot = raw.lastIndexOf(".");
  const amount = parseFloat(
    lastComma > lastDot
      ? raw.replace(/\./g,"").replace(",",".")   // AR format: 1.500,50 → 1500.50
      : raw.replace(/,/g,"")                     // plain or decimal dot: 1500.50 → 1500.50
  );
  if (!amount||amount<=0) return null;
  const lc = text.toLowerCase();
  const isIncome = forceType==="income"||(forceType!=="expense"&&INCOME_KW.some(kw=>lc.includes(kw)));
  const category = detectCat(text, isIncome&&forceType==="income");
  const desc = text.replace(/\d[\d.,]*/g,"").trim().replace(/\s+/g," ")||CATS[category]?.label||"Movimiento";
  return { id:crypto.randomUUID(), date:new Date().toISOString(), amount, type:isIncome?"income":"expense", category, description:desc };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const fmt      = n => new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(n);
const fmtDate  = iso => new Date(iso).toLocaleDateString("es-AR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"});
const fmtShort = iso => new Date(iso).toLocaleDateString("es-AR",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
const isToday     = iso => new Date(iso).toDateString()===new Date().toDateString();
const isThisMonth = iso => { const d=new Date(iso),now=new Date(); return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear(); };
const isThisWeek  = iso => { const d=new Date(iso),now=new Date(),s=new Date(now); s.setDate(now.getDate()-now.getDay()); s.setHours(0,0,0,0); return d>=s; };
const byPeriod    = (txs,p) => {
  if (p==="today") return txs.filter(t=>isToday(t.date));
  if (p==="week")  { const now=new Date(),s=new Date(now); s.setDate(now.getDate()-now.getDay()); s.setHours(0,0,0,0); return txs.filter(t=>new Date(t.date)>=s); }
  if (p==="month") { const now=new Date(),mo=now.getMonth(),yr=now.getFullYear(); return txs.filter(t=>{const d=new Date(t.date);return d.getMonth()===mo&&d.getFullYear()===yr;}); }
  return txs;
};
const isLastDaysOfMonth = () => { const now=new Date(),last=new Date(now.getFullYear(),now.getMonth()+1,0).getDate(); return now.getDate()>=last-2; };
const getDismissKey     = () => { const now=new Date(); return `${now.getFullYear()}-${now.getMonth()}`; };

// ─── DESIGN TOKENS ───────────────────────────────────────────────────────────
const C = {
  bg:"#08080f", surface:"#0f0f1a", surface2:"#141420", border:"#1a1a2e",
  accent:"#7c3aed", aGlow:"#7c3aed44", text:"#e2e8f0", muted:"#4a5568",
  font:"'DM Sans',system-ui,sans-serif", mono:"'JetBrains Mono',monospace",
};
const CARD   = { background:C.surface,  border:`1px solid ${C.border}`, borderRadius:16, padding:"16px 18px" };
const ABTN   = { background:"none", border:"none", cursor:"pointer", fontSize:16, padding:"4px 6px", borderRadius:6 };
const IINPUT = { background:C.surface2, border:`1px solid ${C.border}`, borderRadius:10, padding:"10px 14px", color:C.text, fontSize:14, fontFamily:C.font, outline:"none", width:"100%", boxSizing:"border-box" };
const SBTN   = { background:C.accent, border:"none", borderRadius:10, padding:"10px 16px", color:"white", fontWeight:700, fontSize:14, cursor:"pointer", fontFamily:C.font, width:"100%" };

const PRIORITY = {
  needed:      { label:"Necesario",    emoji:"🔴", color:"#ef4444", bg:"#1f0d0d" },
  optional:    { label:"Opcional",     emoji:"🟡", color:"#eab308", bg:"#1c1a09" },
  dispensable: { label:"Prescindible", emoji:"⚪", color:"#94a3b8", bg:"#0f1420" },
};

const QUICK_BTNS = [
  { label:"🚗 Uber",    prefix:"uber ",       type:"expense" },
  { label:"🥩 RES",     prefix:"res ",         type:"expense" },
  { label:"🥬 Verdu",   prefix:"verduleria ",  type:"expense" },
  { label:"🛒 Super",   prefix:"super ",       type:"expense" },
  { label:"💰 Ingreso", prefix:"",             type:"income"  },
];

// ─── LOGIN SCREEN ────────────────────────────────────────────────────────────
function LoginScreen() {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [mode,     setMode]     = useState("signin"); // "signin" | "signup" | "magic"
  const [loading,  setLoading]  = useState(false);
  const [msg,      setMsg]      = useState(null);

  const handleSignIn = async () => {
    if (!email || !password) return;
    setLoading(true); setMsg(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setMsg({ text: error.message, type:"error" });
    setLoading(false);
  };

  const handleSignUp = async () => {
    if (!email || !password) return;
    setLoading(true); setMsg(null);
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) setMsg({ text: error.message, type:"error" });
    else setMsg({ text:"Revisá tu email para confirmar la cuenta.", type:"success" });
    setLoading(false);
  };

  const handleMagicLink = async () => {
    if (!email) return;
    setLoading(true); setMsg(null);
    const { error } = await supabase.auth.signInWithOtp({ email });
    if (error) setMsg({ text: error.message, type:"error" });
    else setMsg({ text:"Te enviamos un link al email. Revisá tu bandeja de entrada.", type:"success" });
    setLoading(false);
  };

  const submit = mode==="magic" ? handleMagicLink : mode==="signup" ? handleSignUp : handleSignIn;

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:C.font, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", paddingTop:"calc(24px + env(safe-area-inset-top))", paddingBottom:"calc(24px + env(safe-area-inset-bottom))", paddingLeft:"20px", paddingRight:"20px", maxWidth:480, margin:"0 auto" }}>
      <div style={{ fontSize:44, marginBottom:10 }}>💸</div>
      <div style={{ fontSize:24, fontWeight:900, letterSpacing:"-0.03em", marginBottom:4 }}>Finanzas</div>
      <div style={{ fontSize:13, color:C.muted, marginBottom:36 }}>Iniciá sesión para acceder a tus datos</div>

      <div style={{ width:"100%", display:"flex", flexDirection:"column", gap:12 }}>
        {/* Mode selector */}
        <div style={{ display:"flex", background:C.surface2, borderRadius:12, padding:4, gap:4, border:`1px solid ${C.border}` }}>
          {[["signin","Ingresar"],["signup","Registrarse"],["magic","Magic Link"]].map(([m,l])=>(
            <button key={m} onClick={()=>{setMode(m);setMsg(null);}}
              style={{ flex:1, padding:"8px 0", borderRadius:9, border:"none", background:mode===m?C.surface:"transparent", color:mode===m?C.text:C.muted, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:C.font, transition:"all 0.15s" }}>
              {l}
            </button>
          ))}
        </div>

        <input
          type="email" value={email} onChange={e=>setEmail(e.target.value)}
          placeholder="tu@email.com"
          style={IINPUT}
          onKeyDown={e=>e.key==="Enter"&&submit()}
          autoComplete="email"
        />

        {mode !== "magic" && (
          <input
            type="password" value={password} onChange={e=>setPassword(e.target.value)}
            placeholder="Contraseña"
            style={IINPUT}
            onKeyDown={e=>e.key==="Enter"&&submit()}
            autoComplete={mode==="signup"?"new-password":"current-password"}
          />
        )}

        <button onClick={submit} disabled={loading} style={{...SBTN, opacity:loading?0.6:1}}>
          {loading ? "Cargando..." : mode==="magic" ? "Enviar magic link" : mode==="signup" ? "Crear cuenta" : "Ingresar"}
        </button>

        {msg && (
          <div style={{ padding:"10px 14px", borderRadius:10, background:msg.type==="error"?"#1f0d0d":"#0d2818", border:`1px solid ${msg.type==="error"?"#7f1d1d":"#166534"}`, color:msg.type==="error"?"#fca5a5":"#86efac", fontSize:13, lineHeight:1.5 }}>
            {msg.text}
          </div>
        )}

        {mode==="signup" && (
          <div style={{ fontSize:11, color:C.muted, textAlign:"center", lineHeight:1.6 }}>
            Al registrarte, tus datos se guardan en la nube y podés acceder desde cualquier dispositivo.
          </div>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
      `}</style>
    </div>
  );
}

// ─── SWIPEABLE TX ITEM ───────────────────────────────────────────────────────
const TxItem = React.memo(function TxItem({ tx, onDelete, onEdit }) {
  const cat = CATS[tx.category]??CATS.otro;
  const [swipeX,    setSwipeX]    = useState(0);
  const [swiping,   setSwiping]   = useState(false);
  const [deleted,   setDeleted]   = useState(false);
  const [showNote,  setShowNote]  = useState(false);
  const startXRef = useRef(null);
  const THRESHOLD = 80;

  const onTouchStart = e => { startXRef.current = e.touches[0].clientX; setSwiping(false); };
  const onTouchMove  = e => {
    if (startXRef.current===null) return;
    const dx = e.touches[0].clientX - startXRef.current;
    if (Math.abs(dx)>8) { setSwiping(true); setSwipeX(Math.min(0,dx)); }
  };
  const onTouchEnd = () => {
    if (swipeX < -THRESHOLD) {
      setSwipeX(-120); setDeleted(true);
      setTimeout(()=>onDelete(tx.id), 300);
    } else { setSwipeX(0); setSwiping(false); }
    startXRef.current=null;
  };

  if (deleted) return null;

  const isExp = tx.type==="expense";
  return (
    <div style={{ position:"relative", overflow:"hidden" }}>
      <div style={{ position:"absolute", right:0, top:0, bottom:0, width:120, background:"#7f1d1d", display:"flex", alignItems:"center", justifyContent:"center" }}>
        <span style={{ fontSize:22 }}>🗑️</span>
      </div>
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={()=>{ if(!swiping) setShowNote(p=>!p); }}
        style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 0", borderBottom:`1px solid ${C.border}`, cursor:"pointer", position:"relative", background:C.bg, transform:`translateX(${swipeX}px)`, transition:swiping?"none":"transform 0.25s ease", willChange:"transform", touchAction:"pan-y" }}
      >
        <div style={{ width:38, height:38, borderRadius:10, background:cat.color+"22", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>{cat.icon}</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:14, fontWeight:500, color:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{tx.description}</div>
          <div style={{ fontSize:11, color:C.muted, marginTop:2, display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
            {fmtDate(tx.date)}
            <span style={{ fontSize:10, fontWeight:600, color:cat.color, background:cat.color+"22", border:`1px solid ${cat.color}44`, borderRadius:4, padding:"1px 5px", textTransform:"uppercase" }}>{cat.label}</span>
            {tx.priority && <span>{PRIORITY[tx.priority]?.emoji}</span>}
            {tx.note && <span style={{ color:"#a78bfa", fontSize:10 }}>📝</span>}
            {tx.createdBy && <span style={{ color:C.muted, fontSize:10 }}>👤 {tx.createdBy.split("@")[0]}</span>}
            {tx.editedBy && <span style={{ color:"#6b7280", fontSize:10 }}>✏️ {tx.editedBy.split("@")[0]}</span>}
          </div>
          {showNote && tx.note && (
            <div style={{ marginTop:6, fontSize:12, color:"#c4b5fd", background:"#1a0a2e", borderRadius:8, padding:"6px 10px", fontStyle:"italic" }}>
              {tx.note}
            </div>
          )}
        </div>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4, flexShrink:0 }}>
          <div style={{ fontSize:15, fontWeight:700, fontFamily:C.mono, color:isExp?"#fc8181":"#68d391", letterSpacing:"-0.02em" }}>
            {isExp?"-":"+"}{fmt(tx.amount)}
          </div>
          <div style={{ display:"flex", gap:4 }}>
            <button onPointerDown={e=>{e.stopPropagation();e.preventDefault();onEdit(tx);}} style={{...ABTN, fontSize:13, padding:"2px 5px"}}>✏️</button>
          </div>
        </div>
      </div>
    </div>
  );
});

// ─── EDIT MODAL ──────────────────────────────────────────────────────────────
function EditModal({ tx, onSave, onClose }) {
  const [form, setForm] = useState({...tx, note:tx.note||""});
  return (
    <div style={{ position:"fixed", inset:0, background:"#00000088", zIndex:300, display:"flex", alignItems:"flex-end", justifyContent:"center" }} onClick={onClose}>
      <div style={{ background:C.surface, borderRadius:"20px 20px 0 0", border:`1px solid ${C.border}`, padding:20, paddingBottom:"calc(20px + env(safe-area-inset-bottom))", width:"100%", maxWidth:480, maxHeight:"90vh", overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
        <div style={{ fontSize:14, fontWeight:700, color:C.text, marginBottom:16 }}>Editar movimiento</div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <input value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} placeholder="Descripción" style={IINPUT} />
          <input type="number" inputMode="numeric" value={form.amount} onChange={e=>setForm(p=>({...p,amount:parseFloat(e.target.value)||0}))} style={IINPUT} />
          <input value={form.note} onChange={e=>setForm(p=>({...p,note:e.target.value}))} placeholder="Nota (opcional) — 'cena con Lucas', 'anticipo cliente'" style={{...IINPUT, fontStyle:form.note?"normal":"italic"}} />
          <select value={form.type} onChange={e=>setForm(p=>({...p,type:e.target.value}))} style={{...IINPUT,appearance:"none"}}>
            <option value="expense">Gasto</option><option value="income">Ingreso</option>
          </select>
          <select value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))} style={{...IINPUT,appearance:"none"}}>
            {Object.entries(CATS).map(([k,v])=><option key={k} value={k}>{v.icon} {v.label}</option>)}
          </select>
          {form.type==="expense" && (
            <div>
              <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:8 }}>Prioridad</div>
              <div style={{ display:"flex", gap:8 }}>
                {[["none","Sin clasificar","⚫"],...Object.entries(PRIORITY).map(([k,p])=>[k,p.label,p.emoji])].map(([k,label,emoji])=>(
                  <button key={k} onPointerDown={e=>{e.preventDefault();setForm(p=>({...p,priority:k==="none"?null:k}));}}
                    style={{ flex:1, padding:"8px 4px", borderRadius:10, border:`1px solid ${(form.priority||"none")===k?C.accent:C.border}`, background:(form.priority||"none")===k?C.aGlow:"transparent", color:(form.priority||"none")===k?"#a78bfa":C.muted, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:C.font }}>
                    {emoji}<br/><span style={{fontSize:9}}>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={onClose} style={{ flex:1, background:C.surface2, border:`1px solid ${C.border}`, borderRadius:10, padding:"10px", color:C.muted, fontSize:14, cursor:"pointer", fontFamily:C.font }}>Cancelar</button>
            <button onClick={()=>onSave(form)} style={{ flex:1, ...SBTN, width:"auto" }}>Guardar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── NOTE INPUT ───────────────────────────────────────────────────────────────
function NoteInput({ value, onChange }) {
  return (
    <div style={{ padding:"0 16px 12px", display:"flex", alignItems:"center", gap:8 }}>
      <span style={{ fontSize:14, color:C.muted }}>📝</span>
      <input
        value={value}
        onChange={e=>onChange(e.target.value)}
        placeholder="Nota (opcional) — cena con Lucas, anticipo cliente..."
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        style={{ flex:1, background:"transparent", border:"none", outline:"none", fontSize:13, color:"#c4b5fd", fontFamily:C.font, fontStyle:"italic", caretColor:"#a78bfa" }}
      />
    </div>
  );
}

// ─── PRIORITY PICKER ─────────────────────────────────────────────────────────
function PriorityPicker({ value, onChange }) {
  return (
    <div style={{ padding:"10px 16px 14px", borderTop:`1px solid ${C.border}` }}>
      <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:8 }}>¿Qué tipo de gasto?</div>
      <div style={{ display:"flex", gap:8 }}>
        {Object.entries(PRIORITY).map(([k,p])=>(
          <button key={k} onPointerDown={e=>{ e.preventDefault(); onChange(value===k?null:k); }}
            style={{ flex:1, padding:"8px 0", borderRadius:10, border:`1px solid ${value===k?p.color:C.border}`, background:value===k?p.bg:"transparent", color:value===k?p.color:C.muted, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:C.font, transition:"all 0.15s" }}>
            {p.emoji}<br/><span style={{fontSize:10}}>{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── WORKSPACE MODAL ─────────────────────────────────────────────────────────
function WorkspaceModal({ workspaces, activeId, onSelect, onClose, onCreate, onDelete, onLeave, userId, sharedWsIds }) {
  const [creating,      setCreating]      = useState(false);
  const [newName,       setNewName]       = useState("");
  const [newEmoji,      setNewEmoji]      = useState("💼");
  const [shareWsId,     setShareWsId]     = useState(null);
  const [members,       setMembers]       = useState([]);
  const [inviteEmail,   setInviteEmail]   = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteMsg,     setInviteMsg]     = useState(null);

  const EMOJIS = ["💼","🎵","🎤","🎸","🎹","🎬","📽️","🏢","🏪","🚀","⚽","🎮","💡","🌟","🔥"];
  const counts = useMemo(()=>{
    const m={};
    workspaces.forEach(ws=>{ try{m[ws.id]=(JSON.parse(localStorage.getItem(wsKey(ws.id,"tx"))||"[]")).length;}catch{m[ws.id]=0;} });
    return m;
  },[workspaces]);

  useEffect(()=>{
    if (!shareWsId) { setMembers([]); setInviteMsg(null); return; }
    supabase.from("workspace_members").select("id, invited_email, member_user_id")
      .eq("workspace_id", shareWsId).then(({data})=>setMembers(data||[]));
  },[shareWsId]);

  const reloadMembers = async () => {
    const {data} = await supabase.from("workspace_members").select("id, invited_email, member_user_id").eq("workspace_id", shareWsId);
    setMembers(data||[]);
  };

  const handleInvite = async () => {
    const email = inviteEmail.trim().toLowerCase();
    if (!email) return;
    setInviteLoading(true); setInviteMsg(null);
    // Ensure workspace exists in Supabase before creating the invite
    const wsToShare = workspaces.find(w => w.id === shareWsId);
    if (wsToShare) {
      await supabase.from("workspaces").upsert(
        { id: wsToShare.id, user_id: userId, name: wsToShare.name, emoji: wsToShare.emoji, created_at: wsToShare.createdAt },
        { onConflict: "id,user_id" }
      );
    }
    const { error } = await supabase.from("workspace_members").upsert(
      { workspace_id: shareWsId, owner_user_id: userId, invited_email: email },
      { onConflict: "workspace_id,owner_user_id,invited_email" }
    );
    if (error) {
      setInviteMsg({ text:"Error al invitar. Intentá de nuevo.", type:"error" });
    } else {
      const ws = workspaces.find(w => w.id === shareWsId);
      const wsLabel = `${ws?.emoji ? ws.emoji + " " : ""}${ws?.name || ""}`;
      const appUrl = import.meta.env.VITE_APP_URL || "https://finanzas-mateoribak.vercel.app";
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${import.meta.env.VITE_RESEND_API_KEY}` },
          body: JSON.stringify({
            from: "Finanzas <hola@unocincoytres.com>",
            to: [email],
            subject: `Te compartieron el workspace "${wsLabel}"`,
            html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#08080f;color:#e2e8f0;border-radius:12px"><h2 style="margin-top:0;color:#a78bfa">Workspace compartido</h2><p>Te invitaron a colaborar en <strong style="color:#e2e8f0">${wsLabel}</strong>.</p><p>Ingresá con tu email <strong>${email}</strong> y el workspace va a aparecer automáticamente en la barra lateral.</p><a href="${appUrl}" style="display:inline-block;background:#1e3a5f;color:#93c5fd;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px">Abrir Finanzas →</a></div>`
          })
        });
      } catch (_) {}
      setInviteMsg({ text:`✅ Invitación enviada a ${email}.`, type:"success" });
      setInviteEmail("");
      await reloadMembers();
    }
    setInviteLoading(false);
  };

  const handleRemoveMember = async id => {
    await supabase.from("workspace_members").delete().eq("id", id);
    setMembers(p=>p.filter(m=>m.id!==id));
  };

  const handleCreate = () => {
    if (!newName.trim()) return;
    onCreate({ id:crypto.randomUUID(), name:newName.trim(), emoji:newEmoji, createdAt:new Date().toISOString() });
    setCreating(false); setNewName(""); setNewEmoji("💼");
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"#00000099", zIndex:400, display:"flex", alignItems:"flex-end", justifyContent:"center" }} onClick={onClose}>
      <div style={{ background:C.surface, borderRadius:"20px 20px 0 0", border:`1px solid ${C.border}`, padding:20, paddingBottom:"calc(20px + env(safe-area-inset-bottom))", width:"100%", maxWidth:480, maxHeight:"85vh", overflowY:"auto" }} onClick={e=>e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontSize:15, fontWeight:800, color:C.text }}>Mis economías</div>
          <button onClick={onClose} style={{ background:"none", border:"none", cursor:"pointer", color:C.muted, fontSize:20 }}>×</button>
        </div>

        {workspaces.map(ws=>{
          const isShared  = sharedWsIds.has(ws.id);
          const showShare = shareWsId === ws.id;
          return (
            <div key={ws.id} style={{ marginBottom: showShare ? 0 : 8 }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 14px", borderRadius: showShare?"12px 12px 0 0":12, background:ws.id===activeId?C.aGlow:C.surface2, border:`1px solid ${ws.id===activeId?C.accent:C.border}`, borderBottom: showShare?"none":undefined, cursor:"pointer" }} onClick={()=>{onSelect(ws.id);onClose();}}>
                <div style={{ fontSize:22, width:40, height:40, borderRadius:12, background:C.surface, display:"flex", alignItems:"center", justifyContent:"center" }}>{ws.emoji}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                    <span style={{ fontSize:14, fontWeight:700, color:ws.id===activeId?"#a78bfa":C.text }}>{ws.name}</span>
                    {isShared && <span style={{ fontSize:10, background:"#1e3a5f", color:"#93c5fd", padding:"1px 6px", borderRadius:4, fontWeight:700 }}>👥 compartido</span>}
                  </div>
                  <div style={{ fontSize:11, color:C.muted }}>{counts[ws.id]||0} movimientos</div>
                </div>
                {ws.id===activeId && !isShared && <div style={{ fontSize:11, color:"#a78bfa", fontWeight:700, flexShrink:0 }}>activa</div>}
                <div style={{ display:"flex", gap:4, flexShrink:0 }} onClick={e=>e.stopPropagation()}>
                  {!isShared && ws.id!=="personal" && (
                    <button onClick={()=>{ setShareWsId(showShare?null:ws.id); setInviteMsg(null); setInviteEmail(""); }}
                      style={{...ABTN, fontSize:15, color: showShare?"#93c5fd":C.muted}} title="Compartir">👥</button>
                  )}
                  {!isShared && ws.id!=="personal" && (
                    <button onClick={()=>{if(window.confirm(`¿Eliminar "${ws.name}"? Borra todos sus datos.`))onDelete(ws.id);}} style={{...ABTN,color:"#f87171",fontSize:14}}>🗑️</button>
                  )}
                  {isShared && (
                    <button onClick={()=>{if(window.confirm(`¿Salir de "${ws.name}"?`)){onLeave(ws.id);onClose();}}} style={{...ABTN,color:"#f87171",fontSize:12}}>Salir</button>
                  )}
                </div>
              </div>

              {showShare && (
                <div style={{ background:"#0a1628", border:`1px solid #1e3a5f`, borderTop:"none", borderRadius:"0 0 12px 12px", padding:"14px 16px", marginBottom:8 }} onClick={e=>e.stopPropagation()}>
                  <div style={{ fontSize:12, fontWeight:700, color:"#93c5fd", marginBottom:12 }}>Colaboradores de {ws.name}</div>
                  {members.length > 0 && (
                    <div style={{ marginBottom:12 }}>
                      {members.map(m=>(
                        <div key={m.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0", borderBottom:`1px solid ${C.border}` }}>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:13, color:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{m.invited_email}</div>
                            <div style={{ fontSize:10, color:m.member_user_id?"#4ade80":"#fbbf24", marginTop:2 }}>{m.member_user_id?"● Activo":"◌ Pendiente — no inició sesión aún"}</div>
                          </div>
                          <button onClick={()=>handleRemoveMember(m.id)} style={{...ABTN,color:"#f87171",fontSize:13}}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {members.length === 0 && <div style={{ fontSize:12, color:C.muted, marginBottom:12 }}>Sin colaboradores todavía.</div>}
                  <div style={{ display:"flex", gap:8 }}>
                    <input value={inviteEmail} onChange={e=>{setInviteEmail(e.target.value);setInviteMsg(null);}}
                      onKeyDown={e=>e.key==="Enter"&&handleInvite()}
                      placeholder="email del colaborador" type="email"
                      style={{...IINPUT, flex:1, fontSize:13}} />
                    <button onClick={handleInvite} disabled={inviteLoading||!inviteEmail}
                      style={{ background:"#1e3a5f", border:"1px solid #3b82f6", borderRadius:10, padding:"8px 14px", color:"#93c5fd", fontWeight:700, fontSize:13, cursor:"pointer", fontFamily:C.font, opacity:inviteLoading||!inviteEmail?0.5:1, flexShrink:0 }}>
                      {inviteLoading?"...":"Invitar"}
                    </button>
                  </div>
                  {inviteMsg && <div style={{ marginTop:8, fontSize:12, color:inviteMsg.type==="error"?"#f87171":"#86efac", lineHeight:1.5 }}>{inviteMsg.text}</div>}
                  <div style={{ marginTop:10, fontSize:11, color:C.muted, lineHeight:1.6 }}>El colaborador necesita tener cuenta en la app. Si no tiene, tiene que registrarse con ese email primero.</div>
                </div>
              )}
            </div>
          );
        })}

        {creating ? (
          <div style={{ marginTop:12, display:"flex", flexDirection:"column", gap:10 }}>
            <div style={{ fontSize:12, color:C.muted, fontWeight:600 }}>Elegí un emoji</div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              {EMOJIS.map(e=>(
                <button key={e} onPointerDown={ev=>{ev.preventDefault();setNewEmoji(e);}} style={{ width:38, height:38, borderRadius:10, border:`1px solid ${newEmoji===e?C.accent:C.border}`, background:newEmoji===e?C.aGlow:C.surface2, cursor:"pointer", fontSize:20 }}>{e}</button>
              ))}
            </div>
            <input value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleCreate()} placeholder="Nombre del proyecto (ej: J4MES)" style={IINPUT} autoFocus />
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={()=>setCreating(false)} style={{ flex:1, background:C.surface2, border:`1px solid ${C.border}`, borderRadius:10, padding:"10px", color:C.muted, fontSize:14, cursor:"pointer", fontFamily:C.font }}>Cancelar</button>
              <button onClick={handleCreate} style={{ flex:1, ...SBTN, width:"auto" }}>Crear</button>
            </div>
          </div>
        ) : (
          <button onClick={()=>setCreating(true)} style={{ ...SBTN, marginTop:12, background:C.surface2, color:"#a78bfa", border:`1px solid ${C.accent}` }}>+ Nueva economía</button>
        )}
      </div>
    </div>
  );
}

// ─── BUDGET ALERT BANNER ─────────────────────────────────────────────────────
function BudgetAlerts({ budgets, transactions }) {
  const alerts = useMemo(()=>{
    const now=new Date(), mo=now.getMonth(), yr=now.getFullYear();
    const spent={};
    transactions.filter(t=>t.type==="expense").forEach(t=>{
      const d=new Date(t.date);
      if(d.getMonth()===mo&&d.getFullYear()===yr) spent[t.category]=(spent[t.category]||0)+t.amount;
    });
    return Object.entries(budgets).map(([cat,limit])=>{
      const s=spent[cat]||0, pct=limit>0?Math.round((s/limit)*100):0;
      if(pct<80) return null;
      const c=CATS[cat]??CATS.otro;
      return { cat, label:c.label, icon:c.icon, color:c.color, spent:s, limit, pct, over:pct>=100 };
    }).filter(Boolean);
  },[budgets,transactions]);

  if (!alerts.length) return null;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:16 }}>
      {alerts.map(a=>(
        <div key={a.cat} style={{ background:a.over?"#1f0d0d":"#1c1a09", border:`1px solid ${a.over?"#7f1d1d":"#713f12"}`, borderRadius:12, padding:"10px 14px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
            <span style={{ fontSize:13, fontWeight:700, color:a.over?"#fc8181":"#fbbf24" }}>
              {a.over?"🔴":"⚠️"} {a.icon} {a.label} — {a.over?"¡Límite superado!":"Cerca del límite"}
            </span>
            <span style={{ fontSize:12, fontFamily:C.mono, color:a.over?"#fc8181":"#fbbf24", fontWeight:700 }}>{a.pct}%</span>
          </div>
          <div style={{ height:5, borderRadius:3, background:C.border, overflow:"hidden" }}>
            <div style={{ height:"100%", width:`${Math.min(a.pct,100)}%`, borderRadius:3, background:a.over?"#ef4444":"#eab308", transition:"width 0.4s" }} />
          </div>
          <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>{fmt(a.spent)} de {fmt(a.limit)}</div>
        </div>
      ))}
    </div>
  );
}

// ─── SHARED UI ───────────────────────────────────────────────────────────────
function Pill({ label, active, onClick }) {
  return <button onClick={onClick} style={{ padding:"6px 14px", borderRadius:20, border:`1px solid ${active?C.accent:C.border}`, background:active?C.aGlow:"transparent", color:active?"#a78bfa":C.muted, fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:C.font, flexShrink:0 }}>{label}</button>;
}
function MetricCard({ label, value, color, sub }) {
  return (
    <div style={{...CARD, display:"flex", flexDirection:"column", gap:4}}>
      <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase" }}>{label}</div>
      <div style={{ fontSize:20, fontWeight:800, color:color||C.text, fontFamily:C.mono, letterSpacing:"-0.04em" }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:C.muted }}>{sub}</div>}
    </div>
  );
}
function EomBanner({ onExport, onDismiss }) {
  return (
    <div style={{ marginBottom:16, background:"linear-gradient(135deg,#1a0a2e,#0d1f3c)", border:"1px solid #4c1d95", borderRadius:16, padding:"14px 16px", position:"relative" }}>
      <button onClick={onDismiss} style={{ position:"absolute", top:10, right:10, background:"none", border:"none", cursor:"pointer", color:C.muted, fontSize:16 }}>×</button>
      <div style={{ fontSize:13, fontWeight:700, color:"#c084fc", marginBottom:4 }}>🗓️ Fin de mes — guardá tu backup</div>
      <div style={{ fontSize:12, color:C.muted, marginBottom:12 }}>Exportá todos tus datos antes de que termine el mes.</div>
      <div style={{ display:"flex", gap:8 }}>
        <button onClick={onExport} style={{ flex:1, background:"#7c3aed", border:"none", borderRadius:10, padding:"9px 0", color:"white", fontWeight:700, fontSize:13, cursor:"pointer", fontFamily:C.font }}>💾 Exportar backup</button>
        <a href="https://drive.google.com" target="_blank" rel="noopener noreferrer" style={{ display:"flex", alignItems:"center", padding:"9px 14px", background:C.surface2, border:`1px solid ${C.border}`, borderRadius:10, color:"#a0aec0", fontSize:13, fontWeight:600, textDecoration:"none", fontFamily:C.font }}>📂 Drive</a>
      </div>
    </div>
  );
}

// ─── TAB: HOME ───────────────────────────────────────────────────────────────
function HomeTab({ inputRef, input, setInput, onSubmit, parsePreview, forceType, setForceType, pendingPriority, setPendingPriority, pendingNote, setPendingNote, transactions, setTransactions, setEditTx, todayExp, monthExp, monthInc, balance, totalFixed, disponible, projected, daysInMonth, dayOfMonth, showEomBanner, onExportBackup, onDismissBanner, budgets }) {
  const isIncome = forceType==="income"||(forceType!=="expense"&&parsePreview?.type==="income");
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      {showEomBanner && <EomBanner onExport={onExportBackup} onDismiss={onDismissBanner} />}
      <BudgetAlerts budgets={budgets} transactions={transactions} />

      <div style={{ background:C.surface, border:`1px solid ${parsePreview?(isIncome?"#22c55e55":"#7c3aed55"):forceType==="income"?"#22c55e55":C.border}`, borderRadius:16, overflow:"hidden", transition:"border-color 0.2s" }}>
        <div style={{ display:"flex", borderBottom:`1px solid ${C.border}` }}>
          {[["expense","💸 Gasto"],["income","💰 Ingreso"]].map(([t,l])=>(
            <button key={t} onPointerDown={e=>{ e.preventDefault(); setForceType(prev=>prev===t?null:t); requestAnimationFrame(()=>inputRef.current?.focus()); }}
              style={{ flex:1, padding:"8px 0", background:forceType===t?(t==="income"?"#0d281822":"#1a0a2e"):C.surface2, border:"none", color:forceType===t?(t==="income"?"#68d391":"#a78bfa"):C.muted, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:C.font }}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ display:"flex", alignItems:"center", padding:"4px 16px" }}>
          <span style={{ fontSize:20, marginRight:10 }}>{parsePreview?(isIncome?"💚":"💸"):forceType==="income"?"💚":"✏️"}</span>
          <input ref={inputRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&onSubmit()}
            inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            placeholder={forceType==="income"?"sueldo 500000 · cobré 80000":"uber 3500 · res 12000 · sueldo 500000"}
            style={{ flex:1, background:"transparent", border:"none", outline:"none", fontSize:16, color:C.text, fontFamily:C.font, padding:"16px 0", caretColor:"#a78bfa" }}
          />
          {input && <button onPointerDown={e=>{e.preventDefault();onSubmit();}} style={{ background:C.accent, border:"none", borderRadius:10, padding:"8px 14px", cursor:"pointer", color:"white", fontWeight:700, fontSize:13, fontFamily:C.font }}>↵</button>}
        </div>
        {parsePreview && (
          <>
            <div style={{ padding:"10px 16px 4px", borderTop:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:20 }}>{CATS[parsePreview.category]?.icon??"📌"}</span>
              <div>
                <div style={{ fontSize:12, color:C.muted }}>{isIncome?"Ingreso":"Gasto"} · {CATS[parsePreview.category]?.label}</div>
                <div style={{ fontSize:18, fontWeight:800, fontFamily:C.mono, color:isIncome?"#68d391":"#fc8181", letterSpacing:"-0.03em" }}>
                  {isIncome?"+":"-"}{fmt(parsePreview.amount)}
                </div>
              </div>
              {pendingPriority && !isIncome && <div style={{ marginLeft:"auto", fontSize:18 }}>{PRIORITY[pendingPriority]?.emoji}</div>}
            </div>
            <NoteInput value={pendingNote} onChange={setPendingNote} />
            {!isIncome && <PriorityPicker value={pendingPriority} onChange={setPendingPriority} />}
          </>
        )}
      </div>

      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
        {QUICK_BTNS.map(q=>(
          <button key={q.label} onPointerDown={e=>{ e.preventDefault(); setInput(q.prefix); setForceType(q.type); requestAnimationFrame(()=>inputRef.current?.focus()); }}
            style={{ background:q.type==="income"?"#0d2818":C.surface2, border:`1px solid ${q.type==="income"?"#166534":C.border}`, borderRadius:10, padding:"8px 14px", color:q.type==="income"?"#68d391":"#a0aec0", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:C.font }}>
            {q.label}
          </button>
        ))}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        <MetricCard label="Hoy"      value={fmt(todayExp)} color="#fc8181" />
        <MetricCard label="Este mes" value={fmt(monthExp)} color="#fc8181" />
        <MetricCard label="Ingresos" value={fmt(monthInc)} color="#68d391" />
        <MetricCard label="Balance"  value={fmt(balance)}  color={balance>=0?"#68d391":"#fc8181"} />
      </div>

      <div style={{...CARD, background:disponible>=0?"#0d2818":"#1f0d0d", border:`1px solid ${disponible>=0?"#166534":"#7f1d1d"}`}}>
        <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:6 }}>Dinero disponible <span style={{fontSize:10}}>(ingresos − fijos)</span></div>
        <div style={{ fontSize:28, fontWeight:900, fontFamily:C.mono, color:disponible>=0?"#4ade80":"#f87171", letterSpacing:"-0.04em" }}>{fmt(disponible)}</div>
        <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>Fijos: {fmt(totalFixed)} · Variables: {fmt(monthExp)}</div>
      </div>

      <div style={{...CARD, display:"flex", alignItems:"center", gap:14}}>
        <div style={{ fontSize:24 }}>📈</div>
        <div>
          <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase" }}>Proyección del mes</div>
          <div style={{ fontSize:18, fontWeight:800, fontFamily:C.mono, color:"#fbbf24", letterSpacing:"-0.03em" }}>{fmt(projected)}</div>
          <div style={{ fontSize:11, color:C.muted }}>Día {dayOfMonth} de {daysInMonth}</div>
        </div>
      </div>

      {transactions.length>0 && (
        <div>
          <div style={{ fontSize:12, color:C.muted, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:8 }}>Últimos movimientos</div>
          <div style={{...CARD, padding:"0 0 0 0", overflow:"hidden"}}>
            {transactions.slice(0,5).map(tx=>(
              <div key={tx.id} style={{ paddingLeft:18, paddingRight:0 }}>
                <TxItem tx={tx} onDelete={id=>setTransactions(p=>p.filter(t=>t.id!==id))} onEdit={setEditTx} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TAB: HISTORY ────────────────────────────────────────────────────────────
function HistoryTab({ transactions, setTransactions, setEditTx, period, setPeriod, filterCat, setFilterCat, filtered }) {
  const [filterPriority, setFilterPriority] = useState("all");
  const filteredFinal = useMemo(()=>filterPriority==="all"?filtered:filtered.filter(t=>t.priority===filterPriority),[filtered,filterPriority]);
  const cats = useMemo(()=>[...new Set(transactions.map(t=>t.category))],[transactions]);
  const {fExp,fInc} = useMemo(()=>({
    fExp:filtered.filter(t=>t.type==="expense").reduce((s,t)=>s+t.amount,0),
    fInc:filtered.filter(t=>t.type==="income").reduce((s,t)=>s+t.amount,0),
  }),[filtered]);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ display:"flex", gap:8, overflowX:"auto", paddingBottom:2 }}>
        {[["today","Hoy"],["week","Semana"],["month","Mes"],["all","Todo"]].map(([v,l])=><Pill key={v} label={l} active={period===v} onClick={()=>setPeriod(v)} />)}
      </div>
      <div style={{ display:"flex", gap:6, overflowX:"auto", paddingBottom:4 }}>
        <Pill label="Todas cat." active={filterCat==="all"} onClick={()=>setFilterCat("all")} />
        {cats.map(c=><Pill key={c} label={CATS[c]?.label??c} active={filterCat===c} onClick={()=>setFilterCat(c)} />)}
      </div>
      <div style={{ display:"flex", gap:6, overflowX:"auto", paddingBottom:4 }}>
        <Pill label="Toda prior." active={filterPriority==="all"} onClick={()=>setFilterPriority("all")} />
        {Object.entries(PRIORITY).map(([k,p])=><Pill key={k} label={`${p.emoji} ${p.label}`} active={filterPriority===k} onClick={()=>setFilterPriority(k)} />)}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
        {[["Gastos",fmt(fExp),"#fc8181"],["Ingresos",fmt(fInc),"#68d391"],["Items",filteredFinal.length,C.text]].map(([l,v,c])=>(
          <div key={l} style={{...CARD, padding:"10px 14px"}}>
            <div style={{ fontSize:10, color:C.muted, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase" }}>{l}</div>
            <div style={{ fontSize:15, fontWeight:800, fontFamily:C.mono, color:c }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize:11, color:C.muted, fontStyle:"italic" }}>← Deslizá un ítem para eliminarlo</div>
      <div style={{...CARD, padding:"0", overflow:"hidden"}}>
        {filteredFinal.length===0
          ? <div style={{ padding:"24px 0", textAlign:"center", color:C.muted, fontSize:14 }}>Sin movimientos</div>
          : filteredFinal.map(tx=>(
              <div key={tx.id} style={{ paddingLeft:18, paddingRight:0 }}>
                <TxItem tx={tx} onDelete={id=>setTransactions(p=>p.filter(t=>t.id!==id))} onEdit={setEditTx} />
              </div>
            ))
        }
      </div>
    </div>
  );
}

// ─── TAB: BUDGETS ────────────────────────────────────────────────────────────
function BudgetsTab({ budgets, setBudgets, transactions, showToast }) {
  const [editCat,   setEditCat]   = useState(null);
  const [editVal,   setEditVal]   = useState("");
  const [addCat,    setAddCat]    = useState("uber");
  const [addAmount, setAddAmount] = useState("");

  const monthlySpent = useMemo(()=>{
    const now=new Date(), mo=now.getMonth(), yr=now.getFullYear(), m={};
    transactions.filter(t=>t.type==="expense").forEach(t=>{
      const d=new Date(t.date);
      if(d.getMonth()===mo&&d.getFullYear()===yr) m[t.category]=(m[t.category]||0)+t.amount;
    });
    return m;
  },[transactions]);

  const saveBudget = (cat, amount) => {
    setBudgets(p=>({...p,[cat]:amount}));
    setEditCat(null); setEditVal("");
    showToast("✅ Presupuesto guardado");
  };
  const deleteBudget = cat => { setBudgets(p=>{ const n={...p}; delete n[cat]; return n; }); showToast("🗑️ Presupuesto eliminado"); };
  const addBudget = () => {
    if (!addAmount||parseFloat(addAmount)<=0) return;
    saveBudget(addCat, parseFloat(addAmount));
    setAddAmount("");
  };

  const expenseCats = Object.keys(CATS).filter(k=>!["sueldo","freelance","transferencia","ingreso"].includes(k));

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ fontSize:12, color:C.muted }}>
        Establecé límites de gasto mensuales por categoría. Te avisamos cuando llegás al 80% y cuando lo superás.
      </div>

      {Object.keys(budgets).length>0 && (
        <div style={{...CARD, padding:"0 18px"}}>
          {Object.entries(budgets).map(([cat, limit])=>{
            const c=CATS[cat]??CATS.otro;
            const spent=monthlySpent[cat]||0;
            const pct=limit>0?Math.round((spent/limit)*100):0;
            const barColor=pct>=100?"#ef4444":pct>=80?"#eab308":"#22c55e";
            return (
              <div key={cat} style={{ padding:"14px 0", borderBottom:`1px solid ${C.border}` }}>
                {editCat===cat ? (
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <span style={{ fontSize:20 }}>{c.icon}</span>
                    <input type="number" inputMode="numeric" value={editVal} onChange={e=>setEditVal(e.target.value)}
                      style={{...IINPUT, flex:1}} placeholder="Nuevo límite" autoFocus />
                    <button onClick={()=>saveBudget(cat,parseFloat(editVal)||0)} style={{ background:C.accent, border:"none", borderRadius:8, padding:"8px 12px", color:"white", fontWeight:700, cursor:"pointer", fontFamily:C.font }}>✓</button>
                    <button onClick={()=>setEditCat(null)} style={{ background:C.surface2, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 10px", color:C.muted, cursor:"pointer", fontFamily:C.font }}>✕</button>
                  </div>
                ) : (
                  <>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ fontSize:18 }}>{c.icon}</span>
                        <div>
                          <div style={{ fontSize:14, fontWeight:600, color:C.text }}>{c.label}</div>
                          <div style={{ fontSize:11, color:C.muted }}>{fmt(spent)} de {fmt(limit)} — {pct}%</div>
                        </div>
                      </div>
                      <div style={{ display:"flex", gap:6 }}>
                        <button onClick={()=>{setEditCat(cat);setEditVal(String(limit));}} style={ABTN}>✏️</button>
                        <button onClick={()=>deleteBudget(cat)} style={{...ABTN,color:"#f87171"}}>🗑️</button>
                      </div>
                    </div>
                    <div style={{ height:6, borderRadius:3, background:C.border, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${Math.min(pct,100)}%`, borderRadius:3, background:barColor, transition:"width 0.4s" }} />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={CARD}>
        <div style={{ fontSize:12, color:C.muted, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:12 }}>
          {Object.keys(budgets).length===0?"Agregar primer presupuesto":"Agregar categoría"}
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <select value={addCat} onChange={e=>setAddCat(e.target.value)} style={{...IINPUT, appearance:"none"}}>
            {expenseCats.filter(k=>!budgets[k]).map(k=><option key={k} value={k}>{CATS[k].icon} {CATS[k].label}</option>)}
          </select>
          <input type="number" inputMode="numeric" value={addAmount} onChange={e=>setAddAmount(e.target.value)} placeholder="Límite mensual (ej: 30000)" style={IINPUT} />
          <button onClick={addBudget} style={SBTN}>+ Agregar presupuesto</button>
        </div>
      </div>

      {Object.keys(budgets).length===0 && (
        <div style={{...CARD, background:"#0a1628", border:"1px solid #1d4ed8"}}>
          <div style={{ fontSize:13, color:"#93c5fd", fontWeight:600, marginBottom:4 }}>💡 ¿Para qué sirve esto?</div>
          <div style={{ fontSize:12, color:C.muted }}>Definís "Uber: $30.000/mes" y cuando llegás al 80% te aparece una alerta en el home. Cuando lo superás, la alerta se vuelve roja. Perfecto para categorías donde solés pasarte.</div>
        </div>
      )}
    </div>
  );
}

// ─── TAB: FIXED ──────────────────────────────────────────────────────────────
function FixedTab({ fixedExpenses, setFixedExpenses, totalFixed, monthInc, showToast }) {
  const [nf, setNf] = useState({ name:"", amount:"", dueDay:"", autoRegister:false });
  const [editId, setEditId] = useState(null);
  const today = new Date().getDate();
  const addFixed = () => {
    if (!nf.name||!nf.amount) return;
    setFixedExpenses(p=>[...p,{ id:crypto.randomUUID(), name:nf.name, amount:parseFloat(nf.amount), dueDay:parseInt(nf.dueDay)||null, autoRegister:nf.autoRegister }]);
    setNf({ name:"", amount:"", dueDay:"", autoRegister:false }); showToast("✅ Gasto fijo agregado");
  };
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{...CARD, background:"#150a2a", border:"1px solid #3b1d6b"}}>
        <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:6 }}>Total fijos / mes</div>
        <div style={{ fontSize:28, fontWeight:900, fontFamily:C.mono, color:"#c084fc", letterSpacing:"-0.04em" }}>{fmt(totalFixed)}</div>
        {monthInc>0 && <div style={{ fontSize:12, color:C.muted, marginTop:4 }}>{Math.round((totalFixed/monthInc)*100)}% de tus ingresos</div>}
      </div>
      <div style={{...CARD, padding:"0 18px"}}>
        {fixedExpenses.map(f=>{ const near=f.dueDay&&Math.abs(f.dueDay-today)<=3; return (
          <div key={f.id} style={{ padding:"12px 0", borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ flex:1, minWidth:0 }}>
              {editId===f.id ? (
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  <input value={f.name} onChange={e=>setFixedExpenses(p=>p.map(x=>x.id===f.id?{...x,name:e.target.value}:x))} style={IINPUT} placeholder="Nombre" />
                  <input type="number" inputMode="numeric" value={f.amount} onChange={e=>setFixedExpenses(p=>p.map(x=>x.id===f.id?{...x,amount:parseFloat(e.target.value)||0}:x))} style={IINPUT} placeholder="Monto" />
                  <input type="number" inputMode="numeric" value={f.dueDay||""} onChange={e=>setFixedExpenses(p=>p.map(x=>x.id===f.id?{...x,dueDay:parseInt(e.target.value)||null}:x))} style={IINPUT} placeholder="Día vto. (1-31)" min="1" max="31" />
                  <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, color:C.muted }}>
                    <input type="checkbox" checked={f.autoRegister} onChange={e=>setFixedExpenses(p=>p.map(x=>x.id===f.id?{...x,autoRegister:e.target.checked}:x))} /> Registrar automáticamente
                  </label>
                  <button onClick={()=>setEditId(null)} style={SBTN}>Guardar</button>
                </div>
              ) : (
                <>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:14, fontWeight:600, color:C.text }}>{f.name}</span>
                    {near && <span style={{ fontSize:10, background:"#7c3aed33", color:"#a78bfa", padding:"2px 6px", borderRadius:4, fontWeight:700 }}>vence día {f.dueDay}</span>}
                  </div>
                  <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>{f.dueDay?`Día ${f.dueDay}`:"Sin fecha"} · {f.autoRegister?"Auto":"Manual"}</div>
                </>
              )}
            </div>
            {editId!==f.id && (
              <div style={{ textAlign:"right", flexShrink:0 }}>
                <div style={{ fontSize:15, fontWeight:800, fontFamily:C.mono, color:"#fc8181" }}>{fmt(f.amount)}</div>
                <div style={{ display:"flex", gap:6, justifyContent:"flex-end", marginTop:4 }}>
                  <button onClick={()=>setEditId(f.id)} style={ABTN}>✏️</button>
                  <button onClick={()=>setFixedExpenses(p=>p.filter(x=>x.id!==f.id))} style={{...ABTN,color:"#fc8181"}}>🗑️</button>
                </div>
              </div>
            )}
          </div>
        );})}
      </div>
      <div style={CARD}>
        <div style={{ fontSize:12, color:C.muted, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:12 }}>Agregar gasto fijo</div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <input value={nf.name} onChange={e=>setNf(p=>({...p,name:e.target.value}))} placeholder="Nombre (ej: Netflix)" style={IINPUT} />
          <input type="number" inputMode="numeric" value={nf.amount} onChange={e=>setNf(p=>({...p,amount:e.target.value}))} placeholder="Monto mensual" style={IINPUT} />
          <input type="number" inputMode="numeric" value={nf.dueDay} onChange={e=>setNf(p=>({...p,dueDay:e.target.value}))} placeholder="Día de vencimiento (1-31)" style={IINPUT} />
          <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, color:C.muted }}>
            <input type="checkbox" checked={nf.autoRegister} onChange={e=>setNf(p=>({...p,autoRegister:e.target.checked}))} /> Registrar automáticamente cada mes
          </label>
          <button onClick={addFixed} style={SBTN}>+ Agregar</button>
        </div>
      </div>
    </div>
  );
}

// ─── TAB: INSIGHTS ───────────────────────────────────────────────────────────
function InsightsTab({ transactions, monthExp, monthInc, catBreakdown, projected, dayOfMonth, daysInMonth }) {
  const maxCat = catBreakdown[0]?.[1]??1;
  const lastMonthTotal = useMemo(()=>{
    const ref=new Date(); ref.setDate(1); ref.setMonth(ref.getMonth()-1);
    const lm=ref.getMonth(), ly=ref.getFullYear();
    return transactions.filter(t=>{ const d=new Date(t.date); return t.type==="expense"&&d.getMonth()===lm&&d.getFullYear()===ly; }).reduce((s,t)=>s+t.amount,0);
  },[transactions]);
  const diff=monthExp-lastMonthTotal, pct=lastMonthTotal>0?Math.round((diff/lastMonthTotal)*100):0;
  const priorityStats = useMemo(()=>{
    const monthTxs=transactions.filter(t=>isThisMonth(t.date)&&t.type==="expense");
    if (!monthTxs.length) return null;
    const total=monthTxs.reduce((s,t)=>s+t.amount,0);
    const groups={needed:0,optional:0,dispensable:0}, counts={needed:0,optional:0,dispensable:0};
    monthTxs.forEach(t=>{ if(t.priority){groups[t.priority]+=t.amount;counts[t.priority]++;} });
    return {total,groups,counts,unclassified:monthTxs.filter(t=>!t.priority)};
  },[transactions]);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={CARD}>
        <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:8 }}>vs. mes anterior</div>
        <div style={{ display:"flex", gap:24 }}>
          <div><div style={{ fontSize:11, color:C.muted }}>Este mes</div><div style={{ fontSize:20, fontWeight:800, fontFamily:C.mono, color:"#fc8181" }}>{fmt(monthExp)}</div></div>
          <div><div style={{ fontSize:11, color:C.muted }}>Mes anterior</div><div style={{ fontSize:20, fontWeight:800, fontFamily:C.mono, color:C.muted }}>{fmt(lastMonthTotal)}</div></div>
        </div>
        {lastMonthTotal>0 && <div style={{ marginTop:8, fontSize:13, fontWeight:700, color:diff>0?"#fc8181":"#68d391" }}>{diff>0?"↑":"↓"} {Math.abs(pct)}% {diff>0?"más":"menos"} que el mes pasado</div>}
      </div>
      <div style={CARD}>
        <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:12 }}>Por categoría — este mes</div>
        {catBreakdown.length===0 ? <div style={{ color:C.muted, fontSize:13 }}>Sin datos todavía</div>
          : catBreakdown.map(([cat,total])=>{ const c=CATS[cat]??CATS.otro, p=Math.round((total/maxCat)*100); return (
            <div key={cat} style={{ marginBottom:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                <span style={{ fontSize:13, color:C.text }}>{c.icon} {c.label}</span>
                <span style={{ fontSize:13, fontWeight:700, fontFamily:C.mono, color:c.color }}>{fmt(total)}</span>
              </div>
              <div style={{ height:6, borderRadius:3, background:C.border, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${p}%`, borderRadius:3, background:c.color, transition:"width 0.4s" }} />
              </div>
            </div>
          );})}
      </div>
      <div style={CARD}>
        <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:8 }}>Proyección fin de mes</div>
        <div style={{ fontSize:24, fontWeight:900, fontFamily:C.mono, color:"#fbbf24", letterSpacing:"-0.04em" }}>{fmt(projected)}</div>
        <div style={{ fontSize:12, color:C.muted, marginTop:4 }}>Promedio diario: {fmt(Math.round(monthExp/Math.max(dayOfMonth,1)))} · {daysInMonth-dayOfMonth} días restantes</div>
        {monthInc>0 && <div style={{ marginTop:8, fontSize:13, fontWeight:600, color:projected<monthInc?"#68d391":"#fc8181" }}>{projected<monthInc?"✅ Vas a cerrar el mes en positivo":"⚠️ Al ritmo actual, gastarías más de lo que ingresás"}</div>}
      </div>
      {priorityStats && (
        <div style={CARD}>
          <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:12 }}>Por prioridad — este mes</div>
          {Object.entries(PRIORITY).map(([k,p])=>{ const pct=priorityStats.total>0?Math.round((priorityStats.groups[k]/priorityStats.total)*100):0; return (
            <div key={k} style={{ marginBottom:12 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                <span style={{ fontSize:13, color:C.text }}>{p.emoji} {p.label} <span style={{color:C.muted,fontSize:11}}>({priorityStats.counts[k]})</span></span>
                <span style={{ fontSize:13, fontWeight:700, fontFamily:C.mono, color:p.color }}>{fmt(priorityStats.groups[k])}</span>
              </div>
              <div style={{ height:6, borderRadius:3, background:C.border, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${pct}%`, borderRadius:3, background:p.color, transition:"width 0.4s" }} />
              </div>
            </div>
          );})}
          {priorityStats.unclassified.length>0 && <div style={{ fontSize:11, color:C.muted }}>+ {priorityStats.unclassified.length} sin clasificar ({fmt(priorityStats.unclassified.reduce((s,t)=>s+t.amount,0))})</div>}
          {priorityStats.groups.dispensable>0 && <div style={{ marginTop:12, padding:"10px 12px", background:"#1f0d0d", borderRadius:10, fontSize:12, color:"#f87171", fontWeight:600 }}>⚪ Gastaste {fmt(priorityStats.groups.dispensable)} en cosas prescindibles{priorityStats.total>0?` (${Math.round((priorityStats.groups.dispensable/priorityStats.total)*100)}% del total)`:""}</div>}
        </div>
      )}
      <div style={{...CARD, background:"#0a1628", border:"1px solid #1d4ed8"}}>
        <div style={{ fontSize:14, color:"#93c5fd" }}>💡 ¿Anotaste todos tus gastos de hoy?</div>
        <div style={{ fontSize:12, color:C.muted, marginTop:4 }}>Los gastos chicos no registrados son los que más desajustan el presupuesto.</div>
      </div>
    </div>
  );
}

// ─── TAB: SETTINGS ───────────────────────────────────────────────────────────
function SettingsTab({ transactions, fixedExpenses, budgets, setTransactions, setFixedExpenses, setBudgets, lastBackup, setLastBackup, showToast, activeWs, wsName, onLogout, userEmail }) {
  const fileRef = useRef(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const storageSize = () => { try { const b=(localStorage.getItem(wsKey(activeWs,"tx"))||"").length+(localStorage.getItem(wsKey(activeWs,"fx"))||"").length; return b>1024?`${(b/1024).toFixed(1)} KB`:`${b} B`; } catch { return "—"; } };
  const handleExport = () => { const ts=exportBackupJSON(activeWs,wsName,transactions,fixedExpenses,budgets); setLastBackup(ts); showToast("💾 Backup exportado"); };
  const handleImport = e => {
    const file=e.target.files?.[0]; if (!file) return;
    importBackupJSON(file, data=>{ if(window.confirm(`Importar backup de "${data.workspaceName||data.month}"?\nEsto REEMPLAZARÁ los datos actuales de "${wsName}".`)) { setTransactions(data.transactions||[]); setFixedExpenses(data.fixedExpenses||DEFAULT_FX); if(data.budgets)setBudgets(data.budgets); showToast("✅ Backup importado"); } }, ()=>showToast("❌ Archivo inválido","error"));
    e.target.value="";
  };
  const handleReset = () => { if(!confirmReset){setConfirmReset(true);setTimeout(()=>setConfirmReset(false),4000);return;} setTransactions([]); setFixedExpenses(DEFAULT_FX); setBudgets({}); setConfirmReset(false); showToast("🗑️ Datos eliminados"); };
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      {/* Account */}
      <div style={{...CARD, background:"#0d1520", border:"1px solid #1e3a5f"}}>
        <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:8 }}>Cuenta</div>
        <div style={{ fontSize:13, color:C.text, marginBottom:12 }}>
          <span style={{ color:"#93c5fd" }}>☁️ Sincronizado</span> · {userEmail}
        </div>
        <button onClick={onLogout} style={{...SBTN, background:"#1f0d0d", color:"#fca5a5", border:"1px solid #7f1d1d"}}>
          Cerrar sesión
        </button>
      </div>

      <div style={{...CARD, background:"#0d1f0a", border:"1px solid #166534"}}>
        <div style={{ fontSize:11, color:C.muted, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:6 }}>Estado — {wsName}</div>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
          <div style={{ width:10, height:10, borderRadius:"50%", background:lastBackup?"#4ade80":"#f87171", flexShrink:0 }} />
          <div style={{ fontSize:13, color:C.text, fontWeight:600 }}>{lastBackup?`Último backup: ${fmtShort(lastBackup)}`:"Sin backup registrado"}</div>
        </div>
        <div style={{ fontSize:12, color:C.muted }}>{transactions.length} movimientos · {fixedExpenses.length} gastos fijos · {Object.keys(budgets).length} presupuestos · {storageSize()}</div>
      </div>
      <div style={CARD}>
        <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:4 }}>💾 Exportar backup</div>
        <div style={{ fontSize:12, color:C.muted, marginBottom:12 }}>Incluye movimientos, gastos fijos y presupuestos de <strong style={{color:C.text}}>{wsName}</strong>.</div>
        <button onClick={handleExport} style={SBTN}>💾 Exportar backup JSON</button>
        <a href="https://drive.google.com/drive/folders" target="_blank" rel="noopener noreferrer" style={{ display:"block", textAlign:"center", marginTop:10, padding:"10px 0", background:C.surface2, border:`1px solid ${C.border}`, borderRadius:10, color:"#a0aec0", fontSize:13, fontWeight:600, textDecoration:"none", fontFamily:C.font }}>📂 Abrir Google Drive</a>
      </div>
      <div style={CARD}>
        <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:4 }}>📊 Exportar CSV</div>
        <div style={{ fontSize:12, color:C.muted, marginBottom:12 }}>Para Excel o Google Sheets. Incluye columna de notas.</div>
        <button onClick={()=>exportCSV(transactions,wsName)} style={{...SBTN, background:C.surface2, color:"#a0aec0", border:`1px solid ${C.border}`}}>📥 Exportar movimientos (.csv)</button>
      </div>
      <div style={CARD}>
        <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:4 }}>📤 Restaurar desde backup</div>
        <div style={{ fontSize:12, color:C.muted, marginBottom:12 }}>Importá un <code style={{background:C.surface2,padding:"1px 5px",borderRadius:4,fontSize:11}}>.json</code> previo. <strong style={{color:"#f87171"}}>Reemplaza los datos actuales de {wsName}.</strong></div>
        <input ref={fileRef} type="file" accept=".json" onChange={handleImport} style={{ display:"none" }} />
        <button onClick={()=>fileRef.current?.click()} style={{...SBTN, background:C.surface2, color:"#a0aec0", border:`1px solid ${C.border}`}}>📂 Seleccionar archivo</button>
      </div>
      <div style={{...CARD, background:"#0a1628", border:"1px solid #1d4ed8"}}>
        <div style={{ fontSize:13, fontWeight:700, color:"#93c5fd", marginBottom:8 }}>📋 Rutina recomendada</div>
        {[["Último día del mes","Exportá el backup JSON"],["Guardalo en Drive","Carpeta Finanzas → nombre del mes"],["Cambio de dispositivo","Importá el .json desde Drive"],["Browser borra datos","Restaurás desde el último backup"]].map(([t,d])=>(
          <div key={t} style={{ display:"flex", gap:10, marginBottom:10 }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:"#3b82f6", marginTop:6, flexShrink:0 }} />
            <div><div style={{ fontSize:12, fontWeight:700, color:C.text }}>{t}</div><div style={{ fontSize:11, color:C.muted }}>{d}</div></div>
          </div>
        ))}
      </div>
      <div style={{...CARD, border:"1px solid #7f1d1d"}}>
        <div style={{ fontSize:13, fontWeight:700, color:"#f87171", marginBottom:4 }}>⚠️ Zona peligrosa</div>
        <div style={{ fontSize:12, color:C.muted, marginBottom:12 }}>Elimina todos los datos de {wsName}. Irreversible.</div>
        <button onClick={handleReset} style={{...SBTN, background:confirmReset?"#7f1d1d":C.surface2, color:confirmReset?"#fca5a5":"#f87171", border:`1px solid ${confirmReset?"#ef4444":"#7f1d1d"}`}}>
          {confirmReset?"⚠️ Confirmá: borrar todo":"🗑️ Resetear datos de "+wsName}
        </button>
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const [user,        setUser]       = useState(null);
  const [loadingAuth, setLoadingAuth]= useState(true);
  const syncReady  = useRef(false);  // true after Supabase data loaded; prevents saving stale data
  const wsLoadRef  = useRef(null);   // tracks which workspace is being loaded to discard stale responses

  // ── App state ─────────────────────────────────────────────────────────────
  const [workspaces,  setWorkspaces]  = useState(()=>load(SK_GLOBAL.workspaces, DEFAULT_WORKSPACES));
  const [activeWsId,  setActiveWsId]  = useState(()=>load(SK_GLOBAL.activeWs, "personal"));
  const [showWsModal, setShowWsModal] = useState(false);

  const [transactions,  setTransactions]  = useState(()=>loadWs(activeWsId,"tx",[]));
  const [fixedExpenses, setFixedExpenses] = useState(()=>loadWs(activeWsId,"fx",DEFAULT_FX));
  const [budgets,       setBudgets]       = useState(()=>loadWs(activeWsId,"budgets",{}));
  const [lastBackup,    setLastBackupRaw] = useState(()=>loadWs(activeWsId,"lastBackup",null));

  const [dismissedKey, setDismissedKey]   = useState(()=>load(SK_GLOBAL.dismissedBanner,null));
  const [input,        setInput]          = useState("");
  const [forceType,    setForceType]      = useState(null);
  const [activeTab,    setActiveTab]      = useState("home");
  const [period,       setPeriod]         = useState("month");
  const [filterCat,    setFilterCat]      = useState("all");
  const [editTx,       setEditTx]         = useState(null);
  const [toast,        setToast]          = useState(null);
  const [pendingPriority, setPendingPriority] = useState(null);
  const [pendingNote,     setPendingNote]     = useState("");
  const inputRef       = useRef(null);
  const prevTab        = useRef(null);
  const wsOwnersRef    = useRef({});   // { wsId: ownerUserId } — sync access in effects
  const sharedWsIdsRef = useRef(new Set()); // wsIds where user is member, not owner
  const [wsOwners,    setWsOwners]    = useState({});
  const [sharedWsIds, setSharedWsIds] = useState(new Set());

  const activeWs = workspaces.find(w=>w.id===activeWsId)||workspaces[0];

  // ── Auth listener ─────────────────────────────────────────────────────────
  useEffect(()=>{
    supabase.auth.getSession().then(({ data: { session } })=>{
      setUser(session?.user ?? null);
      setLoadingAuth(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session)=>{
      setUser(session?.user ?? null);
      if (!session) syncReady.current = false;
    });
    return () => subscription.unsubscribe();
  },[]);

  // ── Load workspaces + memberships from Supabase on login ────────────────────
  useEffect(()=>{
    if (!user) return;
    (async ()=>{
      // Resolve pending invites for this email
      await supabase.from("workspace_members")
        .update({ member_user_id: user.id })
        .eq("invited_email", user.email)
        .is("member_user_id", null);

      // Own workspaces
      const { data: wss } = await supabase
        .from("workspaces").select("*").eq("user_id", user.id).order("created_at");

      // Shared workspaces (member)
      const { data: memberships } = await supabase
        .from("workspace_members").select("workspace_id, owner_user_id").eq("member_user_id", user.id);

      const owners = {};
      const sharedIds = new Set();
      let all = wss?.length ? wss.map(w=>({ id:w.id, name:w.name, emoji:w.emoji, createdAt:w.created_at })) : [];
      all.forEach(w=>{ owners[w.id] = user.id; });

      if (memberships?.length) {
        const sharedResults = await Promise.all(
          memberships.map(m=>
            supabase.from("workspaces").select("*")
              .eq("id", m.workspace_id).eq("user_id", m.owner_user_id).maybeSingle()
          )
        );
        sharedResults.forEach((r, i)=>{
          if (!r.data) return;
          const w = r.data, m = memberships[i];
          all.push({ id:w.id, name:w.name, emoji:w.emoji, createdAt:w.created_at });
          owners[w.id] = m.owner_user_id;
          sharedIds.add(w.id);
        });
      }

      if (all.length) { setWorkspaces(all); save(SK_GLOBAL.workspaces, all); }
      wsOwnersRef.current    = owners;
      sharedWsIdsRef.current = sharedIds;
      setWsOwners(owners);
      setSharedWsIds(sharedIds);

      // Bootstrap: upload localStorage data for any own workspace not yet in DB
      const ownIds = all.filter(w => !sharedIds.has(w.id)).map(w => w.id);
      if (ownIds.length) {
        const { data: existing } = await supabase
          .from("workspace_data").select("workspace_id")
          .in("workspace_id", ownIds).eq("user_id", user.id);
        const inDB = new Set(existing?.map(d => d.workspace_id) || []);
        for (const ws of all.filter(w => !sharedIds.has(w.id) && !inDB.has(w.id))) {
          await supabase.from("workspace_data").upsert(
            { workspace_id: ws.id, user_id: user.id,
              transactions:   loadWs(ws.id, "tx",      []),
              fixed_expenses: loadWs(ws.id, "fx",      DEFAULT_FX),
              budgets:        loadWs(ws.id, "budgets", {}) },
            { onConflict: "workspace_id,user_id" }
          );
        }
      }
    })();
  },[user]);

  // ── Realtime: detect new workspace invites while logged in ────────────────
  useEffect(()=>{
    if (!user) return;
    const channel = supabase
      .channel(`invites-${user.id}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "workspace_members",
        filter: `invited_email=eq.${user.email}`
      }, async (payload) => {
        const { id: rowId, workspace_id, owner_user_id } = payload.new;
        if (sharedWsIdsRef.current.has(workspace_id)) return;
        await supabase.from("workspace_members").update({ member_user_id: user.id }).eq("id", rowId);
        const { data: wsData } = await supabase.from("workspaces").select("*")
          .eq("id", workspace_id).eq("user_id", owner_user_id).maybeSingle();
        if (!wsData) return;
        const newWs = { id: wsData.id, name: wsData.name, emoji: wsData.emoji, createdAt: wsData.created_at };
        setWorkspaces(p => {
          if (p.some(w => w.id === newWs.id)) return p;
          const updated = [...p, newWs];
          save(SK_GLOBAL.workspaces, updated);
          return updated;
        });
        wsOwnersRef.current[workspace_id] = owner_user_id;
        sharedWsIdsRef.current.add(workspace_id);
        setWsOwners(p => ({ ...p, [workspace_id]: owner_user_id }));
        setSharedWsIds(p => { const n = new Set(p); n.add(workspace_id); return n; });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  },[user]);

  // ── Realtime: sync workspace data changes from other users ───────────────
  useEffect(()=>{
    if (!user || !activeWsId) return;
    const channel = supabase
      .channel(`wsdata-${activeWsId}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "workspace_data",
        filter: `workspace_id=eq.${activeWsId}`
      }, (payload) => {
        const ownerUid = wsOwnersRef.current[activeWsId] ?? user.id;
        if (payload.new.user_id !== ownerUid) return;
        if (payload.new.updated_at === payload.old?.updated_at) return;
        const d = payload.new;
        setTransactions(d.transactions || []);
        setFixedExpenses(d.fixed_expenses || DEFAULT_FX);
        setBudgets(d.budgets || {});
        saveWs(activeWsId, "tx",      d.transactions    || []);
        saveWs(activeWsId, "fx",      d.fixed_expenses  || DEFAULT_FX);
        saveWs(activeWsId, "budgets", d.budgets         || {});
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  },[user, activeWsId]);

  // ── Load workspace data from Supabase when user or workspace changes ──────
  useEffect(()=>{
    if (!user) return;
    syncReady.current = false;
    const target = activeWsId;
    wsLoadRef.current = target;

    (async ()=>{
      const ownerUid = wsOwnersRef.current[target] ?? user.id;
      const { data } = await supabase
        .from("workspace_data")
        .select("*")
        .eq("user_id", ownerUid)
        .eq("workspace_id", target)
        .maybeSingle();

      if (wsLoadRef.current !== target) return; // stale response, discard

      if (data) {
        setTransactions(data.transactions || []);
        setFixedExpenses(data.fixed_expenses || DEFAULT_FX);
        setBudgets(data.budgets || {});
        setLastBackupRaw(data.last_backup);
        // Keep localStorage cache in sync
        saveWs(target, "tx",         data.transactions   || []);
        saveWs(target, "fx",         data.fixed_expenses || DEFAULT_FX);
        saveWs(target, "budgets",    data.budgets        || {});
        saveWs(target, "lastBackup", data.last_backup);
      }

      syncReady.current = true;
    })();
  },[user, activeWsId]);

  // ── When wsOwners resolves, reload shared workspace data with correct ownerUid
  useEffect(()=>{
    const ownerUid = wsOwners[activeWsId];
    if (!ownerUid || !user || ownerUid === user.id) return;
    syncReady.current = false;
    wsLoadRef.current = activeWsId;
    const target = activeWsId;
    (async ()=>{
      const { data } = await supabase.from("workspace_data").select("*")
        .eq("user_id", ownerUid).eq("workspace_id", target).maybeSingle();
      if (wsLoadRef.current !== target) return;
      if (data) {
        setTransactions(data.transactions || []);
        setFixedExpenses(data.fixed_expenses || DEFAULT_FX);
        setBudgets(data.budgets || {});
        setLastBackupRaw(data.last_backup);
        saveWs(target,"tx",data.transactions||[]);
        saveWs(target,"fx",data.fixed_expenses||DEFAULT_FX);
        saveWs(target,"budgets",data.budgets||{});
        saveWs(target,"lastBackup",data.last_backup);
      }
      syncReady.current = true;
    })();
  },[wsOwners, activeWsId, user]);

  // ── Workspace switch: reset from localStorage immediately ─────────────────
  useEffect(()=>{
    setTransactions(loadWs(activeWsId,"tx",[]));
    setFixedExpenses(loadWs(activeWsId,"fx",DEFAULT_FX));
    setBudgets(loadWs(activeWsId,"budgets",{}));
    setLastBackupRaw(loadWs(activeWsId,"lastBackup",null));
    setInput(""); setForceType(null); setPendingPriority(null); setPendingNote("");
  },[activeWsId]);

  // ── Persist to localStorage ───────────────────────────────────────────────
  useEffect(()=>{ saveWs(activeWsId,"tx",transactions); },[transactions,activeWsId]);
  useEffect(()=>{ saveWs(activeWsId,"fx",fixedExpenses); },[fixedExpenses,activeWsId]);
  useEffect(()=>{ saveWs(activeWsId,"budgets",budgets); },[budgets,activeWsId]);
  useEffect(()=>{ saveWs(activeWsId,"lastBackup",lastBackup); },[lastBackup,activeWsId]);
  useEffect(()=>{ save(SK_GLOBAL.workspaces,workspaces); },[workspaces]);
  useEffect(()=>{ save(SK_GLOBAL.activeWs,activeWsId); },[activeWsId]);

  // ── Sync workspace list to Supabase (only own workspaces) ────────────────
  useEffect(()=>{
    if (!user) return;
    workspaces.filter(ws=>!sharedWsIdsRef.current.has(ws.id)).forEach(ws=>{
      supabase.from("workspaces").upsert(
        { id:ws.id, user_id:user.id, name:ws.name, emoji:ws.emoji, created_at:ws.createdAt },
        { onConflict:"id,user_id" }
      );
    });
  },[workspaces, user]);

  // ── Debounced save of workspace data to Supabase ──────────────────────────
  useEffect(()=>{
    if (!user) return;
    const timer = setTimeout(()=>{
      if (!syncReady.current) return;
      supabase.from("workspace_data").upsert(
        {
          workspace_id: activeWsId,
          user_id:      wsOwnersRef.current[activeWsId] ?? user.id,
          transactions,
          fixed_expenses: fixedExpenses,
          budgets,
          last_backup:  lastBackup,
          updated_at:   new Date().toISOString(),
        },
        { onConflict:"workspace_id,user_id" }
      );
    }, 1500);
    return () => clearTimeout(timer);
  },[transactions, fixedExpenses, budgets, lastBackup, activeWsId, user]);

  const setLastBackup = useCallback(ts=>setLastBackupRaw(ts),[]);

  useEffect(()=>{
    if (activeTab==="home"&&prevTab.current!=="home") inputRef.current?.focus();
    prevTab.current=activeTab;
  },[activeTab]);

  const parsePreview = useMemo(()=>input.trim().length>=3?parseInput(input,forceType):null,[input,forceType]);
  const toastTimer = useRef(null);
  const showToast = useCallback((msg,type="success")=>{ clearTimeout(toastTimer.current); setToast({msg,type}); toastTimer.current=setTimeout(()=>setToast(null),2500); },[]);

  const onSubmit = useCallback(()=>{
    if (!input.trim()) return;
    const tx = parseInput(input,forceType);
    if (!tx) { showToast("No pude detectar el monto. Ej: 'uber 3500'","error"); return; }
    const final = { ...tx, ...(tx.type==="expense"?{priority:pendingPriority||null}:{}), ...(pendingNote.trim()?{note:pendingNote.trim()}:{}), createdBy:user.email };
    setTransactions(p=>[final,...p]);
    setInput(""); setForceType(null); setPendingPriority(null); setPendingNote("");
    showToast(final.type==="income"?`✅ Ingreso: ${fmt(final.amount)}`:`✅ Gasto: ${fmt(final.amount)}`);
    requestAnimationFrame(()=>inputRef.current?.focus());
  },[input,forceType,pendingPriority,pendingNote,showToast,user]);

  const handleCreateWs = useCallback(ws=>{
    setWorkspaces(p=>[...p,ws]);
    setActiveWsId(ws.id);
    if (user) {
      supabase.from("workspaces").upsert(
        { id:ws.id, user_id:user.id, name:ws.name, emoji:ws.emoji, created_at:ws.createdAt },
        { onConflict:"id,user_id" }
      );
    }
  },[user]);

  const handleDeleteWs = useCallback(wsId=>{
    setWorkspaces(p=>p.filter(w=>w.id!==wsId));
    if(activeWsId===wsId) setActiveWsId("personal");
    if (user) {
      supabase.from("workspaces").delete().match({ id:wsId, user_id:user.id });
      supabase.from("workspace_data").delete().match({ workspace_id:wsId, user_id:user.id });
    }
  },[activeWsId, user]);

  const handleLeaveWs = useCallback(wsId=>{
    setWorkspaces(p=>p.filter(w=>w.id!==wsId));
    if (activeWsId===wsId) setActiveWsId("personal");
    setWsOwners(p=>{ const n={...p}; delete n[wsId]; return n; });
    setSharedWsIds(p=>{ const n=new Set(p); n.delete(wsId); return n; });
    delete wsOwnersRef.current[wsId];
    sharedWsIdsRef.current.delete(wsId);
    if (user) supabase.from("workspace_members").delete().eq("workspace_id",wsId).eq("member_user_id",user.id);
  },[activeWsId, user]);

  const handleLogout = useCallback(async ()=>{
    syncReady.current = false;
    await supabase.auth.signOut();
  },[]);

  const curDismissKey   = getDismissKey();
  const showEomBanner   = isLastDaysOfMonth()&&dismissedKey!==curDismissKey;
  const handleDismiss   = useCallback(()=>{ setDismissedKey(curDismissKey); save(SK_GLOBAL.dismissedBanner,curDismissKey); },[curDismissKey]);
  const handleExport    = useCallback(()=>{ const ts=exportBackupJSON(activeWsId,activeWs.name,transactions,fixedExpenses,budgets); setLastBackup(ts); showToast("💾 Backup exportado — guardalo en Drive"); },[activeWsId,activeWs,transactions,fixedExpenses,budgets,setLastBackup,showToast]);

  const {todayExp,monthExp,monthInc} = useMemo(()=>{
    const td=new Date().toDateString(), now=new Date(), mo=now.getMonth(), yr=now.getFullYear();
    let te=0, me=0, mi=0;
    for (const t of transactions) {
      const d=new Date(t.date);
      if(d.getMonth()===mo&&d.getFullYear()===yr) {
        if(t.type==="expense"){me+=t.amount;if(d.toDateString()===td)te+=t.amount;}
        else mi+=t.amount;
      }
    }
    return {todayExp:te,monthExp:me,monthInc:mi};
  },[transactions]);

  const totalFixed = useMemo(()=>fixedExpenses.reduce((s,f)=>s+(f.amount||0),0),[fixedExpenses]);
  const balance=monthInc-monthExp, disponible=monthInc-totalFixed;
  const [daysInMonth,dayOfMonth] = useMemo(()=>{ const now=new Date(); return [new Date(now.getFullYear(),now.getMonth()+1,0).getDate(),now.getDate()]; },[transactions]);
  const projected = dayOfMonth>0?Math.round((monthExp/dayOfMonth)*daysInMonth):0;

  const catBreakdown = useMemo(()=>{
    const now=new Date(), mo=now.getMonth(), yr=now.getFullYear(), m={};
    for (const t of transactions) { if(t.type!=="expense") continue; const d=new Date(t.date); if(d.getMonth()===mo&&d.getFullYear()===yr) m[t.category]=(m[t.category]||0)+t.amount; }
    return Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,6);
  },[transactions]);

  const filtered = useMemo(()=>{ let txs=byPeriod(transactions,period); if(filterCat!=="all") txs=txs.filter(t=>t.category===filterCat); return txs; },[transactions,period,filterCat]);

  const TABS = [["home","🏠"],["history","📋"],["fixed","📌"],["budgets","🎯"],["insights","📊"],["settings","⚙️"]];

  // ── Auth gates ────────────────────────────────────────────────────────────
  if (loadingAuth) {
    return (
      <div style={{ minHeight:"100vh", background:C.bg, display:"flex", alignItems:"center", justifyContent:"center" }}>
        <div style={{ fontSize:13, color:C.muted, fontFamily:C.font }}>Cargando...</div>
        <style>{`* { box-sizing:border-box; margin:0; padding:0; }`}</style>
      </div>
    );
  }

  if (!user) return <LoginScreen />;

  // ── Main app ──────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:C.font, display:"flex", flexDirection:"column", maxWidth:480, margin:"0 auto" }}>

      {/* Header */}
      <div style={{ paddingTop:"calc(16px + env(safe-area-inset-top))", paddingBottom:"10px", paddingLeft:"16px", paddingRight:"16px", display:"flex", alignItems:"center", justifyContent:"space-between", borderBottom:`1px solid ${C.border}`, position:"sticky", top:0, background:C.bg, zIndex:50 }}>
        <button onClick={()=>setShowWsModal(true)} style={{ display:"flex", alignItems:"center", gap:8, background:"none", border:"none", cursor:"pointer", padding:0 }}>
          <div style={{ width:32, height:32, borderRadius:10, background:C.surface2, border:`1px solid ${C.border}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>{activeWs.emoji}</div>
          <div style={{ textAlign:"left" }}>
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <span style={{ fontSize:14, fontWeight:800, color:C.text, letterSpacing:"-0.02em", lineHeight:1.2 }}>{activeWs.name}</span>
                {sharedWsIds.has(activeWsId) && <span style={{ fontSize:10, color:"#93c5fd" }}>👥</span>}
              </div>
            <div style={{ fontSize:10, color:C.muted }}>{new Date().toLocaleDateString("es-AR",{weekday:"short",day:"numeric",month:"short"})}</div>
          </div>
          <span style={{ fontSize:10, color:C.muted, marginLeft:2 }}>▾</span>
        </button>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {lastBackup && <div style={{ fontSize:10, color:C.muted, textAlign:"right" }}>backup<br/>{new Date(lastBackup).toLocaleDateString("es-AR",{day:"2-digit",month:"short"})}</div>}
          <div style={{ fontSize:11, fontWeight:700, color:balance>=0?"#4ade80":"#f87171", fontFamily:C.mono, background:(balance>=0?"#4ade80":"#f87171")+"22", border:`1px solid ${(balance>=0?"#4ade80":"#f87171")+"44"}`, padding:"6px 12px", borderRadius:20 }}>
            {balance>=0?"+":""}{fmt(balance)}
          </div>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex:1, paddingTop:"16px", paddingLeft:"16px", paddingRight:"16px", paddingBottom:"calc(80px + env(safe-area-inset-bottom))", overflowY:"auto" }}>
        {activeTab==="home"     && <HomeTab inputRef={inputRef} input={input} setInput={setInput} onSubmit={onSubmit} parsePreview={parsePreview} forceType={forceType} setForceType={setForceType} pendingPriority={pendingPriority} setPendingPriority={setPendingPriority} pendingNote={pendingNote} setPendingNote={setPendingNote} transactions={transactions} setTransactions={setTransactions} setEditTx={setEditTx} todayExp={todayExp} monthExp={monthExp} monthInc={monthInc} balance={balance} totalFixed={totalFixed} disponible={disponible} projected={projected} daysInMonth={daysInMonth} dayOfMonth={dayOfMonth} showEomBanner={showEomBanner} onExportBackup={handleExport} onDismissBanner={handleDismiss} budgets={budgets} />}
        {activeTab==="history"  && <HistoryTab transactions={transactions} setTransactions={setTransactions} setEditTx={setEditTx} period={period} setPeriod={setPeriod} filterCat={filterCat} setFilterCat={setFilterCat} filtered={filtered} />}
        {activeTab==="fixed"    && <FixedTab fixedExpenses={fixedExpenses} setFixedExpenses={setFixedExpenses} totalFixed={totalFixed} monthInc={monthInc} showToast={showToast} />}
        {activeTab==="budgets"  && <BudgetsTab budgets={budgets} setBudgets={setBudgets} transactions={transactions} showToast={showToast} />}
        {activeTab==="insights" && <InsightsTab transactions={transactions} monthExp={monthExp} monthInc={monthInc} catBreakdown={catBreakdown} projected={projected} dayOfMonth={dayOfMonth} daysInMonth={daysInMonth} />}
        {activeTab==="settings" && <SettingsTab transactions={transactions} fixedExpenses={fixedExpenses} budgets={budgets} setTransactions={setTransactions} setFixedExpenses={setFixedExpenses} setBudgets={setBudgets} lastBackup={lastBackup} setLastBackup={setLastBackup} showToast={showToast} activeWs={activeWsId} wsName={activeWs.name} onLogout={handleLogout} userEmail={user.email} />}
      </div>

      {/* Bottom nav */}
      <div style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:C.surface, borderTop:`1px solid ${C.border}`, display:"flex", zIndex:100, paddingBottom:"env(safe-area-inset-bottom)" }}>
        {TABS.map(([id,icon])=>(
          <button key={id} onClick={()=>setActiveTab(id)} style={{ flex:1, padding:"10px 0", background:"none", border:"none", cursor:"pointer", fontSize:16, opacity:activeTab===id?1:0.35, transition:"opacity 0.15s", position:"relative" }}>
            {icon}
            {id==="settings"&&!lastBackup&&<span style={{ position:"absolute", top:6, right:"calc(50% - 12px)", width:6, height:6, borderRadius:"50%", background:"#ef4444" }} />}
          </button>
        ))}
      </div>

      {/* Toast */}
      {toast && <div style={{ position:"fixed", bottom:"calc(80px + env(safe-area-inset-bottom))", left:"50%", transform:"translateX(-50%)", background:toast.type==="error"?"#7f1d1d":"#14532d", color:toast.type==="error"?"#fca5a5":"#86efac", border:`1px solid ${toast.type==="error"?"#ef444444":"#22c55e44"}`, borderRadius:12, padding:"10px 20px", fontSize:13, fontWeight:600, zIndex:200, pointerEvents:"none", whiteSpace:"nowrap" }}>{toast.msg}</div>}

      {showWsModal && <WorkspaceModal workspaces={workspaces} activeId={activeWsId} onSelect={setActiveWsId} onClose={()=>setShowWsModal(false)} onCreate={handleCreateWs} onDelete={handleDeleteWs} onLeave={handleLeaveWs} userId={user.id} sharedWsIds={sharedWsIds} />}
      {editTx && <EditModal tx={editTx} onSave={tx=>{setTransactions(p=>p.map(t=>t.id===tx.id?{...tx,editedBy:user.email,editedAt:new Date().toISOString()}:t));setEditTx(null);showToast("✅ Actualizado");}} onClose={()=>setEditTx(null)} />}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;700;800&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:0; }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; }
        input, button, select { -webkit-tap-highlight-color:transparent; }
      `}</style>
    </div>
  );
}
