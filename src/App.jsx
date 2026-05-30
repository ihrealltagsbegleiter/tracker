import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ─── Storage (localStorage) ───────────────────────────────────────────────────
const KEYS = { routines:"rt-routines-v1", logs:"rt-logs-v2", trackFields:"rt-fields-v1", settings:"rt-settings-v1" };

function lsLoad(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSave(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) { console.error(e); }
}

// ─── Push Notification Scheduling ────────────────────────────────────────────
async function scheduleNotifications(routines) {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.ready;
  // Store schedule in SW via postMessage
  reg.active?.postMessage({ type: 'SCHEDULE', routines });
}

// ─── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULT_ROUTINES = [
  { id:"r1", name:"Aufstehen",  time:"06:30", active:true, weeklyGoal:7 },
  { id:"r2", name:"Meditation", time:"07:00", active:true, weeklyGoal:5 },
  { id:"r3", name:"Bewegung",   time:"07:30", active:true, weeklyGoal:5 },
];
const DEFAULT_FIELDS = [
  { id:"t1", label:"Schlaf (Std.)", type:"number", icon:"◑", min:0, max:24,  step:0.5 },
  { id:"t2", label:"HRV",          type:"number", icon:"♡", min:0, max:200, step:1   },
  { id:"t3", label:"Schmerzen",    type:"scale",  icon:"△", min:0, max:10             },
  { id:"t5", label:"Lebensgefühl", type:"scale",  icon:"◉", min:0, max:10             },
  { id:"t6", label:"Tagesnotiz",   type:"text",   icon:"◻"                            },
];
const FEEL = [
  { v:5, label:"Sehr gut", color:"#c8f060" },
  { v:4, label:"Gut",      color:"#a0d040" },
  { v:3, label:"Neutral",  color:"#888888" },
  { v:2, label:"Schwer",   color:"#f0a060" },
  { v:1, label:"Schlecht", color:"#f06060" },
];
const LIFE_FIELD = "t5";

// ─── Utilities ────────────────────────────────────────────────────────────────
const todayKey = () => new Date().toISOString().split("T")[0];
const nowTime  = () => new Date().toTimeString().slice(0,5);
const dateKey  = (d) => d.toISOString().split("T")[0];
const fmtDate  = (iso) => new Date(iso+"T12:00:00").toLocaleDateString("de-DE",{weekday:"short",day:"2-digit",month:"short"});
const fmtDateShort = (iso) => new Date(iso+"T12:00:00").toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit"});

function getPastKeys(n) {
  return Array.from({length:n},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-(n-1-i)); return dateKey(d); });
}

function streakCount(logs, routineId) {
  let cur=0, best=0, tmp=0;
  const today=new Date();
  for(let i=0;i<365;i++){
    const d=new Date(today); d.setDate(d.getDate()-i);
    if(logs[dateKey(d)]?.routines?.[routineId]) cur++;
    else break;
  }
  const keys=Object.keys(logs).sort();
  for(const k of keys){
    if(logs[k]?.routines?.[routineId]){ tmp++; best=Math.max(best,tmp); } else { tmp=0; }
  }
  return { cur, best };
}

function weeklyCount(logs, routineId) {
  let n=0;
  const today=new Date();
  for(let i=0;i<7;i++){
    const d=new Date(today); d.setDate(d.getDate()-i);
    if(logs[dateKey(d)]?.routines?.[routineId]) n++;
  }
  return n;
}

function pearson(pairs) {
  const n=pairs.length; if(n<3) return null;
  const mx=pairs.reduce((s,p)=>s+p[0],0)/n;
  const my=pairs.reduce((s,p)=>s+p[1],0)/n;
  const num=pairs.reduce((s,p)=>s+(p[0]-mx)*(p[1]-my),0);
  const den=Math.sqrt(pairs.reduce((s,p)=>s+(p[0]-mx)**2,0)*pairs.reduce((s,p)=>s+(p[1]-my)**2,0));
  return den===0?0:num/den;
}

function computeCorrelations(logs, trackFields) {
  const entries=Object.values(logs).filter(l=>l.tracking?.[LIFE_FIELD]!=null);
  if(entries.length<3) return [];
  const results=[];
  for(const f of trackFields.filter(f=>f.type!=="text"&&f.id!==LIFE_FIELD)){
    const pairs=entries.filter(e=>e.tracking[f.id]!=null).map(e=>[Number(e.tracking[f.id]),Number(e.tracking[LIFE_FIELD])]);
    const r=pearson(pairs); if(r===null) continue;
    results.push({label:f.label,r:r.toFixed(2),n:pairs.length,icon:f.icon});
  }
  const mealPairs=entries.filter(e=>e.meals?.length).map(e=>{
    const feels=e.meals.filter(m=>m.feel).map(m=>m.feel);
    if(!feels.length) return null;
    return [feels.reduce((a,b)=>a+b,0)/feels.length, Number(e.tracking[LIFE_FIELD])];
  }).filter(Boolean);
  const mr=pearson(mealPairs); if(mr!==null) results.push({label:"Befinden nach Essen",r:mr.toFixed(2),n:mealPairs.length,icon:"◈"});
  return results.sort((a,b)=>Math.abs(Number(b.r))-Math.abs(Number(a.r)));
}

function exportCSV(logs, trackFields) {
  const headers=["Datum","Routinen erledigt","Mahlzeiten",...trackFields.map(f=>f.label)];
  const keys=Object.keys(logs).sort();
  const rows=keys.map(k=>{
    const l=logs[k];
    const routinesDone=Object.values(l.routines||{}).filter(Boolean).length;
    const meals=(l.meals||[]).length;
    const fields=trackFields.map(f=>l.tracking?.[f.id]??"");
    return [k,routinesDone,meals,...fields].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",");
  });
  return [headers.join(","),...rows].join("\n");
}

// ─── MicroLine ────────────────────────────────────────────────────────────────
function MicroLine({ data, color="#c8f060", height=40 }) {
  const pts=data.filter(d=>d!=null);
  if(pts.length<2) return <div style={{height,display:"flex",alignItems:"center",paddingLeft:4}}><span style={{color:"var(--muted)",fontSize:10}}>Zu wenig Daten</span></div>;
  const min=Math.min(...pts), max=Math.max(...pts), range=max-min||1;
  const w=260, h=height;
  const xs=data.map((_,i)=>i*(w/(data.length-1)));
  const ys=data.map(v=>v==null?null:h-(((v-min)/range)*(h-8)+4));
  const pathParts=[];
  data.forEach((v,i)=>{
    if(v==null) return;
    const cmd=pathParts.length===0||(i>0&&data[i-1]==null)?"M":"L";
    pathParts.push(`${cmd}${xs[i].toFixed(1)},${ys[i].toFixed(1)}`);
  });
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{display:"block",height}}>
      <path d={pathParts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      {data.map((v,i)=>v!=null&&<circle key={i} cx={xs[i]} cy={ys[i]} r="2.5" fill={color} opacity="0.7"/>)}
    </svg>
  );
}

// ─── ScaleInput ───────────────────────────────────────────────────────────────
function ScaleInput({value,onChange,min=0,max=10}){
  return(
    <div className="scale-row">
      <span className="scale-label">{min}</span>
      <input type="range" min={min} max={max} value={value??Math.floor((min+max)/2)} onChange={e=>onChange(Number(e.target.value))} className="scale-slider"/>
      <span className="scale-label">{max}</span>
      <span className="scale-value">{value??"–"}</span>
    </div>
  );
}

// ─── RoutineItem ──────────────────────────────────────────────────────────────
function RoutineItem({routine,done,onToggle,streak,weekDots}){
  const {cur}=streak;
  return(
    <div className={`routine-item ${done?"done":""}`} onClick={onToggle}>
      <div className="routine-check">{done?"✓":""}</div>
      <div className="routine-info">
        <span className="routine-name">{routine.name}</span>
        <span className="routine-time">{routine.time}</span>
      </div>
      <div className="routine-right">
        <div className="week-dots">{weekDots.map((f,i)=><div key={i} className={`wd ${f?"filled":""}`}/>)}</div>
        {cur>0&&<div className="streak-badge"><span>{cur}</span><span className="streak-label">T</span></div>}
      </div>
    </div>
  );
}

// ─── MealTracker ──────────────────────────────────────────────────────────────
function MealTracker({meals=[],onChange,suggestions}){
  const [draft,setDraft]=useState({time:nowTime(),items:"",feel:null,notes:""});
  const [open,setOpen]=useState(false);
  const [editId,setEditId]=useState(null);
  const [showSuggest,setShowSuggest]=useState(false);

  const feelColor=v=>FEEL.find(o=>o.v===v)?.color??"var(--muted)";
  const feelLabel=v=>FEEL.find(o=>o.v===v)?.label??"";

  const filteredSugg=useMemo(()=>{
    if(!draft.items.trim()) return suggestions.slice(0,8);
    const q=draft.items.toLowerCase();
    return suggestions.filter(s=>s.toLowerCase().includes(q)).slice(0,8);
  },[draft.items,suggestions]);

  const commit=()=>{
    if(!draft.items.trim()) return;
    if(editId){ onChange(meals.map(m=>m.id===editId?{...draft,id:editId}:m)); setEditId(null); }
    else { onChange([...meals,{...draft,id:Date.now().toString()}]); }
    setDraft({time:nowTime(),items:"",feel:null,notes:""}); setOpen(false); setShowSuggest(false);
  };
  const remove=id=>onChange(meals.filter(m=>m.id!==id));
  const startEdit=m=>{ setDraft({time:m.time,items:m.items,feel:m.feel??null,notes:m.notes??""}); setEditId(m.id); setOpen(true); };
  const cancel=()=>{ setDraft({time:nowTime(),items:"",feel:null,notes:""}); setEditId(null); setOpen(false); setShowSuggest(false); };

  return(
    <div className="meal-tracker">
      {meals.length===0&&!open&&<p className="empty" style={{marginBottom:12}}>Noch keine Mahlzeit eingetragen.</p>}
      {[...meals].sort((a,b)=>a.time.localeCompare(b.time)).map(m=>(
        <div key={m.id} className="meal-card">
          <div className="meal-top">
            <span className="meal-time">{m.time}</span>
            <span className="meal-items">{m.items}</span>
            <div className="meal-actions">
              <button className="btn-icon" onClick={()=>startEdit(m)}>✎</button>
              <button className="btn-icon danger" onClick={()=>remove(m.id)}>✕</button>
            </div>
          </div>
          {(m.feel||m.notes)&&(
            <div className="meal-bottom">
              {m.feel&&<span className="meal-feel" style={{color:feelColor(m.feel)}}>{feelLabel(m.feel)}</span>}
              {m.notes&&<span className="meal-notes">{m.notes}</span>}
            </div>
          )}
        </div>
      ))}
      {open&&(
        <div className="meal-form">
          <div className="meal-form-row">
            <div className="meal-form-group" style={{flex:"0 0 90px"}}>
              <label className="form-label">Uhrzeit</label>
              <input type="time" className="edit-input" value={draft.time} onChange={e=>setDraft({...draft,time:e.target.value})}/>
            </div>
            <div className="meal-form-group" style={{flex:1,position:"relative"}}>
              <label className="form-label">Was gegessen</label>
              <input className="edit-input" placeholder="z.B. Haferflocken, Banane, Kaffee"
                value={draft.items} autoFocus
                onChange={e=>{ setDraft({...draft,items:e.target.value}); setShowSuggest(true); }}
                onFocus={()=>setShowSuggest(true)}
                onBlur={()=>setTimeout(()=>setShowSuggest(false),150)}/>
              {showSuggest&&filteredSugg.length>0&&(
                <div className="suggest-list">
                  {filteredSugg.map((s,i)=>(
                    <div key={i} className="suggest-item" onMouseDown={()=>{ setDraft({...draft,items:s}); setShowSuggest(false); }}>{s}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="meal-form-group">
            <label className="form-label">Wie habe ich mich danach gefühlt?</label>
            <div className="feel-pills">
              {FEEL.map(o=>(
                <button key={o.v} className={`feel-pill ${draft.feel===o.v?"selected":""}`}
                  style={draft.feel===o.v?{borderColor:o.color,color:o.color}:{}}
                  onClick={()=>setDraft({...draft,feel:draft.feel===o.v?null:o.v})}>{o.label}</button>
              ))}
            </div>
          </div>
          <div className="meal-form-group">
            <label className="form-label">Notiz (optional)</label>
            <input className="edit-input" placeholder="z.B. sehr sättigend, Bauch danach schwer..."
              value={draft.notes} onChange={e=>setDraft({...draft,notes:e.target.value})}/>
          </div>
          <div className="edit-actions">
            <button className="btn-primary" onClick={commit}>{editId?"Aktualisieren":"Hinzufügen"}</button>
            <button className="btn-ghost" onClick={cancel}>Abbrechen</button>
          </div>
        </div>
      )}
      {!open&&(
        <button className="btn-add-meal" onClick={()=>{ setOpen(true); setDraft(d=>({...d,time:nowTime()})); }}>
          + Mahlzeit hinzufügen
        </button>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab,setTab]=useState("heute");
  const [routines,setRoutines]=useState(()=>lsLoad(KEYS.routines,DEFAULT_ROUTINES));
  const [trackFields,setTrackFields]=useState(()=>lsLoad(KEYS.trackFields,DEFAULT_FIELDS));
  const [logs,setLogs]=useState(()=>lsLoad(KEYS.logs,{}));
  const [settings,setSettings]=useState(()=>lsLoad(KEYS.settings,{theme:"dark",statRange:30}));
  const [editRoutine,setEditRoutine]=useState(null);
  const [editField,setEditField]=useState(null);
  const [notifStatus,setNotifStatus]=useState(typeof Notification!=="undefined"?Notification.permission:"denied");
  const [mealSearch,setMealSearch]=useState("");

  const today=todayKey();
  const todayLog=useMemo(()=>logs[today]||{routines:{},tracking:{},meals:[]},[logs,today]);

  // Persist on change
  useEffect(()=>lsSave(KEYS.routines,routines),[routines]);
  useEffect(()=>lsSave(KEYS.logs,logs),[logs]);
  useEffect(()=>lsSave(KEYS.trackFields,trackFields),[trackFields]);
  useEffect(()=>lsSave(KEYS.settings,settings),[settings]);

  // Schedule push notifications whenever routines change
  useEffect(()=>{ scheduleNotifications(routines); },[routines]);

  // Fallback interval check (app open)
  const notifRef=useRef(null);
  useEffect(()=>{
    notifRef.current=setInterval(()=>{
      if(Notification.permission!=="granted") return;
      const now=nowTime();
      routines.filter(r=>r.active&&r.time===now).forEach(r=>{
        if(!logs[today]?.routines?.[r.id]){
          new Notification("Alltagsbegleiter",{body:`Zeit für: ${r.name}`,icon:"/icon-192.png"});
        }
      });
    },30000);
    return()=>clearInterval(notifRef.current);
  },[routines,logs,today]);

  const toggleRoutine=useCallback((id)=>{
    setLogs(prev=>{ const day=prev[today]||{routines:{},tracking:{},meals:[]}; return{...prev,[today]:{...day,routines:{...day.routines,[id]:!day.routines[id]}}}; });
  },[today]);

  const updateTracking=(fid,value)=>{
    setLogs(prev=>{ const day=prev[today]||{routines:{},tracking:{},meals:[]}; return{...prev,[today]:{...day,tracking:{...day.tracking,[fid]:value}}}; });
  };
  const updateMeals=(meals)=>{
    setLogs(prev=>{ const day=prev[today]||{routines:{},tracking:{},meals:[]}; return{...prev,[today]:{...day,meals}}; });
  };

  const mealSuggestions=useMemo(()=>{
    const freq={};
    Object.values(logs).forEach(d=>(d.meals||[]).forEach(m=>{ if(m.items) freq[m.items]=(freq[m.items]||0)+1; }));
    return Object.entries(freq).sort((a,b)=>b[1]-a[1]).map(e=>e[0]);
  },[logs]);

  const activeRoutines=routines.filter(r=>r.active);
  const doneCount=activeRoutines.filter(r=>todayLog.routines[r.id]).length;
  const progress=activeRoutines.length?doneCount/activeRoutines.length:0;

  const statKeys=getPastKeys(settings.statRange);
  const last7keys=getPastKeys(7);
  const lifeData=statKeys.map(k=>logs[k]?.tracking?.[LIFE_FIELD]??null);
  const sleepData=statKeys.map(k=>logs[k]?.tracking?.["t1"]??null);
  const correlations=useMemo(()=>computeCorrelations(logs,trackFields),[logs,trackFields]);

  const mealSearchResults=useMemo(()=>{
    if(!mealSearch.trim()) return [];
    const q=mealSearch.toLowerCase();
    const results=[];
    Object.entries(logs).sort((a,b)=>b[0].localeCompare(a[0])).forEach(([date,day])=>{
      (day.meals||[]).filter(m=>m.items?.toLowerCase().includes(q)||(m.notes?.toLowerCase().includes(q))).forEach(m=>{
        results.push({date,meal:m});
      });
    });
    return results.slice(0,30);
  },[mealSearch,logs]);

  const mealHistory=getPastKeys(14).reverse().map(k=>({date:k,meals:logs[k]?.meals??[]})).filter(d=>d.meals.length>0);

  const requestNotif=async()=>{
    if("Notification" in window){
      const p=await Notification.requestPermission();
      setNotifStatus(p);
      if(p==="granted") scheduleNotifications(routines);
    }
  };

  const doExportJSON=()=>{
    const blob=new Blob([JSON.stringify({logs,routines,trackFields},null,2)],{type:"application/json"});
    Object.assign(document.createElement("a"),{href:URL.createObjectURL(blob),download:`alltagsbegleiter-${today}.json`}).click();
  };
  const doExportCSV=()=>{
    const blob=new Blob([exportCSV(logs,trackFields)],{type:"text/csv;charset=utf-8;"});
    Object.assign(document.createElement("a"),{href:URL.createObjectURL(blob),download:`alltagsbegleiter-${today}.csv`}).click();
  };

  return(
    <div className="app" data-theme={settings.theme}>
      <style>{CSS}</style>

      <header className="header">
        <div className="header-inner">
          <div className="wordmark">ALLTAGSBEGLEITER</div>
          <div style={{display:"flex",alignItems:"center",gap:16}}>
            <div className="header-date">{new Date().toLocaleDateString("de-DE",{weekday:"long",day:"2-digit",month:"long"})}</div>
            <button className="theme-toggle" onClick={()=>setSettings(s=>({...s,theme:s.theme==="dark"?"light":"dark"}))}>
              {settings.theme==="dark"?"☀":"☾"}
            </button>
          </div>
        </div>
      </header>

      <nav className="nav">
        {["heute","ernährung","statistik","einstellungen"].map(t=>(
          <button key={t} className={`nav-btn ${tab===t?"active":""}`} onClick={()=>setTab(t)}>
            {t.charAt(0).toUpperCase()+t.slice(1)}
          </button>
        ))}
      </nav>

      <main className="main">
        {tab==="heute"&&(
          <div className="section-stack">
            <div className="progress-card">
              <svg className="ring" viewBox="0 0 120 120">
                <circle cx="60" cy="60" r="52" className="ring-bg"/>
                <circle cx="60" cy="60" r="52" className="ring-fg" strokeDasharray={`${327*progress} ${327*(1-progress)}`}/>
              </svg>
              <div className="ring-label">
                <span className="ring-count">{doneCount}/{activeRoutines.length}</span>
                <span className="ring-sub">erledigt</span>
              </div>
            </div>

            <div className="card">
              <div className="card-head">Routine</div>
              {activeRoutines.length===0&&<p className="empty">Keine Routinen konfiguriert.</p>}
              {activeRoutines.map(r=>{
                const wdots=Array.from({length:7},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-(6-i)); return !!logs[dateKey(d)]?.routines?.[r.id]; });
                return <RoutineItem key={r.id} routine={r} done={!!todayLog.routines[r.id]} onToggle={()=>toggleRoutine(r.id)} streak={streakCount(logs,r.id)} weekDots={wdots}/>;
              })}
            </div>

            <div className="card">
              <div className="card-head">Tages-Tracking</div>
              {trackFields.map(f=>(
                <div key={f.id} className="track-row">
                  <div className="track-label"><span className="track-icon">{f.icon}</span><span>{f.label}</span></div>
                  {f.type==="scale"&&<ScaleInput value={todayLog.tracking[f.id]} onChange={v=>updateTracking(f.id,v)} min={f.min} max={f.max}/>}
                  {f.type==="number"&&<input type="number" className="num-input" min={f.min} max={f.max} step={f.step} value={todayLog.tracking[f.id]??""} onChange={e=>updateTracking(f.id,e.target.value===""?null:Number(e.target.value))}/>}
                  {f.type==="text"&&<textarea className="text-input" placeholder="Kurze Notiz..." value={todayLog.tracking[f.id]??""} onChange={e=>updateTracking(f.id,e.target.value)}/>}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab==="ernährung"&&(
          <div className="section-stack">
            <div className="card">
              <div className="card-head">Mahlzeiten heute<span className="card-sub">{(todayLog.meals??[]).length} Einträge</span></div>
              <MealTracker meals={todayLog.meals??[]} onChange={updateMeals} suggestions={mealSuggestions}/>
            </div>
            <div className="card">
              <div className="card-head">Verlauf durchsuchen</div>
              <input className="edit-input" placeholder="Suchbegriff..." value={mealSearch} onChange={e=>setMealSearch(e.target.value)} style={{marginBottom:mealSearchResults.length?12:0}}/>
              {mealSearch&&mealSearchResults.length===0&&<p className="empty" style={{marginTop:10}}>Kein Treffer.</p>}
              {mealSearchResults.map(({date,meal},i)=>(
                <div key={i} className="history-meal" style={{paddingTop:8,paddingBottom:8,borderBottom:"1px solid var(--border)"}}>
                  <span className="meal-time" style={{color:"var(--muted)",minWidth:70}}>{fmtDate(date)}</span>
                  <span className="meal-time">{meal.time}</span>
                  <span className="history-items">{meal.items}</span>
                  {meal.feel&&<span className="meal-feel-small" style={{color:FEEL.find(o=>o.v===meal.feel)?.color}}>{FEEL.find(o=>o.v===meal.feel)?.label}</span>}
                </div>
              ))}
            </div>
            {mealHistory.length>0&&(
              <div className="card">
                <div className="card-head">Letzte 14 Tage</div>
                {mealHistory.map(day=>(
                  <div key={day.date} className="history-day">
                    <div className="history-date">{fmtDate(day.date)}</div>
                    {[...day.meals].sort((a,b)=>a.time.localeCompare(b.time)).map(m=>(
                      <div key={m.id} className="history-meal">
                        <span className="meal-time">{m.time}</span>
                        <span className="history-items">{m.items}</span>
                        {m.feel&&<span className="meal-feel-small" style={{color:FEEL.find(o=>o.v===m.feel)?.color}}>{FEEL.find(o=>o.v===m.feel)?.label}</span>}
                        {m.notes&&<span className="meal-notes" style={{fontSize:10}}>{m.notes}</span>}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div className="card">
              <div className="card-head">Befinden nach Mahlzeiten</div>
              {(()=>{
                const all=Object.values(logs).flatMap(d=>d.meals??[]).filter(m=>m.feel);
                if(!all.length) return <p className="empty">Noch keine Befinden-Einträge.</p>;
                const counts={}; FEEL.forEach(o=>{counts[o.v]=0;}); all.forEach(m=>{if(counts[m.feel]!==undefined)counts[m.feel]++;});
                return(
                  <div className="feel-bars">
                    {FEEL.map(o=>(
                      <div key={o.v} className="feel-bar-row">
                        <span className="feel-bar-label" style={{color:o.color}}>{o.label}</span>
                        <div className="feel-bar-outer"><div className="feel-bar-inner" style={{width:`${(counts[o.v]/all.length)*100}%`,background:o.color}}/></div>
                        <span className="feel-bar-count">{counts[o.v]}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {tab==="statistik"&&(
          <div className="section-stack">
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              {[7,14,30,90].map(n=>(
                <button key={n} className={settings.statRange===n?"btn-primary":"btn-ghost"}
                  style={{padding:"5px 12px",fontSize:10}}
                  onClick={()=>setSettings(s=>({...s,statRange:n}))}>
                  {n}T
                </button>
              ))}
            </div>
            <div className="card">
              <div className="card-head">Lebensgefühl ({settings.statRange} Tage)</div>
              <MicroLine data={lifeData} color="var(--accent)" height={56}/>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:6}}>
                <span style={{fontSize:9,color:"var(--muted)"}}>{fmtDateShort(statKeys[0])}</span>
                <span style={{fontSize:9,color:"var(--muted)"}}>{fmtDateShort(statKeys[statKeys.length-1])}</span>
              </div>
            </div>
            <div className="card">
              <div className="card-head">Schlaf in Stunden ({settings.statRange} Tage)</div>
              <MicroLine data={sleepData} color="var(--accent2)" height={56}/>
            </div>
            <div className="card">
              <div className="card-head">Routine Completion (7 Tage)</div>
              <div className="bar-chart">
                {last7keys.map(k=>{
                  const dayLog=logs[k]||{routines:{}};
                  const done=activeRoutines.filter(r=>dayLog.routines[r.id]).length;
                  const pct=activeRoutines.length?done/activeRoutines.length:0;
                  return(
                    <div key={k} className="bar-col">
                      <div className="bar-outer"><div className="bar-inner" style={{height:`${pct*100}%`}}/></div>
                      <span className="bar-label">{fmtDate(k).slice(0,2)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="card">
              <div className="card-head">Streaks & Wochenziel</div>
              {activeRoutines.map(r=>{
                const {cur,best}=streakCount(logs,r.id);
                const wc=weeklyCount(logs,r.id);
                const goal=r.weeklyGoal||7;
                return(
                  <div key={r.id} className="streak-row-v2">
                    <div className="streak-row-top">
                      <span className="streak-name">{r.name}</span>
                      <span className="streak-badges">
                        <span className="sbadge accent">Jetzt: {cur}T</span>
                        <span className="sbadge muted">Best: {best}T</span>
                        <span className={`sbadge ${wc>=goal?"accent":"muted"}`}>{wc}/{goal} Wo</span>
                      </span>
                    </div>
                    <div className="streak-track">
                      {Array.from({length:7},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-(6-i)); const k=dateKey(d); return <div key={k} className={`streak-dot ${logs[k]?.routines?.[r.id]?"filled":""}`}/>; })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="card">
              <div className="card-head">Verlaufstabelle (7 Tage)</div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead><tr><th>Tag</th>{trackFields.filter(f=>f.type!=="text").map(f=><th key={f.id}>{f.icon}</th>)}<th>◈</th></tr></thead>
                  <tbody>
                    {[...last7keys].reverse().map(k=>(
                      <tr key={k}>
                        <td>{fmtDate(k)}</td>
                        {trackFields.filter(f=>f.type!=="text").map(f=><td key={f.id}>{logs[k]?.tracking?.[f.id]??"–"}</td>)}
                        <td>{logs[k]?.meals?.length??"–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-head">Korrelation mit Lebensgefühl<span className="card-sub"> (Pearson r, min. 3 Einträge)</span></div>
              {correlations.length===0
                ?<p className="empty">Mindestens 3 Tage mit Lebensgefühl-Eintrag benötigt.</p>
                :correlations.map(c=>(
                  <div key={c.label} className="corr-row">
                    <span className="corr-icon">{c.icon}</span>
                    <span className="corr-label">{c.label}</span>
                    <div className="corr-bar-outer"><div className={`corr-bar-inner ${Number(c.r)>0?"pos":"neg"}`} style={{width:`${Math.abs(Number(c.r))*100}%`}}/></div>
                    <span className="corr-val" style={{color:Number(c.r)>0?"var(--accent)":"var(--danger)"}}>{c.r}</span>
                    <span className="corr-n">n={c.n}</span>
                  </div>
                ))
              }
              <p style={{fontSize:9,color:"var(--muted)",marginTop:12,lineHeight:1.6}}>r=1.0 perfekte positive Korrelation · r=-1.0 negativ · r=0 kein Zusammenhang</p>
            </div>
          </div>
        )}

        {tab==="einstellungen"&&(
          <div className="section-stack">
            <div className="card">
              <div className="card-head">Erinnerungen</div>
              <p className="settings-hint">
                Status: <strong style={{color:notifStatus==="granted"?"var(--accent)":notifStatus==="denied"?"var(--danger)":"var(--muted)"}}>
                  {notifStatus==="granted"?"Aktiv":notifStatus==="denied"?"Verweigert":"Nicht aktiviert"}
                </strong>
              </p>
              <p className="settings-hint">Push-Benachrichtigungen werden zur Routine-Uhrzeit ausgelöst, auch wenn die App geschlossen ist (Android Chrome + PWA installiert).</p>
              {notifStatus!=="granted"&&<button className="btn-primary" onClick={requestNotif}>Benachrichtigungen aktivieren</button>}
            </div>

            <div className="card">
              <div className="card-head">Routinen<button className="btn-add" onClick={()=>setEditRoutine({id:null,name:"",time:"07:00",active:true,weeklyGoal:7})}>+ Neu</button></div>
              {editRoutine&&(
                <div className="edit-form">
                  <input className="edit-input" placeholder="Name" value={editRoutine.name} onChange={e=>setEditRoutine({...editRoutine,name:e.target.value})}/>
                  <input type="time" className="edit-input" value={editRoutine.time} onChange={e=>setEditRoutine({...editRoutine,time:e.target.value})}/>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <label className="form-label" style={{whiteSpace:"nowrap"}}>Wochenziel</label>
                    <input type="number" className="edit-input" min={1} max={7} value={editRoutine.weeklyGoal??7} onChange={e=>setEditRoutine({...editRoutine,weeklyGoal:Number(e.target.value)})} style={{width:60}}/>
                    <span style={{fontSize:10,color:"var(--muted)"}}>Tage/Woche</span>
                  </div>
                  <div className="edit-actions">
                    <button className="btn-primary" onClick={()=>{
                      if(!editRoutine.name.trim()) return;
                      if(editRoutine.id) setRoutines(prev=>prev.map(r=>r.id===editRoutine.id?editRoutine:r));
                      else setRoutines(prev=>[...prev,{...editRoutine,id:"r"+Date.now()}]);
                      setEditRoutine(null);
                    }}>Speichern</button>
                    <button className="btn-ghost" onClick={()=>setEditRoutine(null)}>Abbrechen</button>
                  </div>
                </div>
              )}
              {routines.map(r=>(
                <div key={r.id} className="settings-row">
                  <div className="settings-row-info">
                    <span className={r.active?"":"inactive"}>{r.name}</span>
                    <span className="settings-time">{r.time} · Ziel {r.weeklyGoal??7}x/Wo</span>
                  </div>
                  <div className="settings-row-actions">
                    <button className="btn-toggle" onClick={()=>setRoutines(prev=>prev.map(x=>x.id===r.id?{...x,active:!x.active}:x))}>{r.active?"An":"Aus"}</button>
                    <button className="btn-icon" onClick={()=>setEditRoutine({...r})}>✎</button>
                    <button className="btn-icon danger" onClick={()=>setRoutines(prev=>prev.filter(x=>x.id!==r.id))}>✕</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="card">
              <div className="card-head">Tracking-Felder<button className="btn-add" onClick={()=>setEditField({id:null,label:"",type:"scale",icon:"◆",min:0,max:10})}>+ Neu</button></div>
              {editField&&(
                <div className="edit-form">
                  <input className="edit-input" placeholder="Bezeichnung" value={editField.label} onChange={e=>setEditField({...editField,label:e.target.value})}/>
                  <select className="edit-input" value={editField.type} onChange={e=>setEditField({...editField,type:e.target.value})}>
                    <option value="scale">Skala (0–10)</option>
                    <option value="number">Zahl</option>
                    <option value="text">Text</option>
                  </select>
                  <input className="edit-input" placeholder="Icon (1 Zeichen)" maxLength={2} value={editField.icon} onChange={e=>setEditField({...editField,icon:e.target.value})}/>
                  <div className="edit-actions">
                    <button className="btn-primary" onClick={()=>{
                      if(!editField.label.trim()) return;
                      if(editField.id) setTrackFields(prev=>prev.map(f=>f.id===editField.id?editField:f));
                      else setTrackFields(prev=>[...prev,{...editField,id:"t"+Date.now()}]);
                      setEditField(null);
                    }}>Speichern</button>
                    <button className="btn-ghost" onClick={()=>setEditField(null)}>Abbrechen</button>
                  </div>
                </div>
              )}
              {trackFields.map(f=>(
                <div key={f.id} className="settings-row">
                  <div className="settings-row-info"><span>{f.icon} {f.label}</span><span className="settings-time">{f.type}</span></div>
                  <div className="settings-row-actions">
                    <button className="btn-icon" onClick={()=>setEditField({...f})}>✎</button>
                    <button className="btn-icon danger" onClick={()=>setTrackFields(prev=>prev.filter(x=>x.id!==f.id))}>✕</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="card">
              <div className="card-head">Daten exportieren</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button className="btn-ghost" onClick={doExportJSON}>JSON exportieren</button>
                <button className="btn-ghost" onClick={doExportCSV}>CSV exportieren</button>
              </div>
              <p className="settings-hint" style={{marginTop:10}}>CSV öffnet direkt in Excel.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Mono:wght@300;400;500&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  .app{
    --bg:#0e0e0e;--surface:#161616;--border:#2a2a2a;
    --accent:#c8f060;--accent2:#60c8f0;--text:#e8e4dc;--muted:#6b6b6b;--danger:#f06060;
    --radius:2px;--font-head:'DM Serif Display',serif;--font-mono:'DM Mono',monospace;
    min-height:100vh;min-height:100dvh;background:var(--bg);color:var(--text);
    font-family:var(--font-mono);font-size:13px;letter-spacing:0.02em;
    padding-bottom:env(safe-area-inset-bottom);
  }
  .app[data-theme="light"]{--bg:#f4f2ee;--surface:#ffffff;--border:#e0ddd8;--text:#1a1a1a;--muted:#999;}
  .header{border-bottom:1px solid var(--border);padding:20px 24px 16px;padding-top:calc(20px + env(safe-area-inset-top));position:sticky;top:0;background:var(--bg);z-index:10;}
  .header-inner{display:flex;justify-content:space-between;align-items:center;max-width:640px;margin:0 auto;}
  .wordmark{font-family:var(--font-head);font-size:18px;letter-spacing:0.12em;color:var(--accent);}
  .header-date{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;}
  .theme-toggle{background:none;border:1px solid var(--border);color:var(--text);width:28px;height:28px;cursor:pointer;border-radius:var(--radius);font-size:14px;display:flex;align-items:center;justify-content:center;}
  .nav{display:flex;border-bottom:1px solid var(--border);max-width:640px;margin:0 auto;padding:0 24px;}
  .nav-btn{background:none;border:none;color:var(--muted);font-family:var(--font-mono);font-size:11px;letter-spacing:0.1em;text-transform:uppercase;padding:14px 14px 12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color 0.15s,border-color 0.15s;}
  .nav-btn:first-child{padding-left:0;}
  .nav-btn.active{color:var(--accent);border-bottom-color:var(--accent);}
  .main{max-width:640px;margin:0 auto;padding:24px;}
  .section-stack{display:flex;flex-direction:column;gap:16px;}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;}
  .card-head{font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:var(--muted);margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;}
  .card-sub{font-size:9px;}
  .progress-card{position:relative;display:flex;justify-content:center;align-items:center;padding:8px 0;}
  .ring{width:140px;height:140px;transform:rotate(-90deg);}
  .ring-bg{fill:none;stroke:var(--border);stroke-width:6;}
  .ring-fg{fill:none;stroke:var(--accent);stroke-width:6;stroke-linecap:round;transition:stroke-dasharray 0.6s cubic-bezier(0.4,0,0.2,1);}
  .ring-label{position:absolute;display:flex;flex-direction:column;align-items:center;}
  .ring-count{font-family:var(--font-head);font-size:32px;color:var(--text);line-height:1;}
  .ring-sub{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em;margin-top:4px;}
  .routine-item{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer;transition:opacity 0.15s;}
  .routine-item:last-child{border-bottom:none;}
  .routine-item:hover{opacity:0.8;}
  .routine-item.done .routine-name{color:var(--muted);text-decoration:line-through;}
  .routine-check{width:22px;height:22px;border:1px solid var(--border);border-radius:2px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--accent);flex-shrink:0;transition:background 0.15s;}
  .routine-item.done .routine-check{background:var(--accent);color:var(--bg);}
  .routine-info{flex:1;display:flex;flex-direction:column;gap:2px;}
  .routine-name{font-size:13px;}
  .routine-time{font-size:10px;color:var(--muted);}
  .routine-right{display:flex;align-items:center;gap:8px;flex-shrink:0;}
  .week-dots{display:flex;gap:3px;}
  .wd{width:7px;height:7px;border-radius:50%;background:var(--border);}
  .wd.filled{background:var(--accent);opacity:0.7;}
  .streak-badge{background:var(--border);border-radius:2px;padding:2px 7px;display:flex;align-items:baseline;gap:2px;font-size:12px;color:var(--accent);}
  .streak-label{font-size:9px;color:var(--muted);}
  .track-row{padding:12px 0;border-bottom:1px solid var(--border);}
  .track-row:last-child{border-bottom:none;}
  .track-label{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;}
  .track-icon{color:var(--accent2);}
  .scale-row{display:flex;align-items:center;gap:8px;}
  .scale-label{font-size:10px;color:var(--muted);width:12px;text-align:center;}
  .scale-slider{flex:1;-webkit-appearance:none;height:2px;background:var(--border);border-radius:1px;outline:none;}
  .scale-slider::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--accent);cursor:pointer;}
  .scale-value{font-size:14px;color:var(--accent);width:24px;text-align:right;}
  .num-input{background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:var(--font-mono);font-size:14px;padding:6px 10px;width:100px;border-radius:var(--radius);outline:none;}
  .num-input:focus{border-color:var(--accent);}
  .text-input{background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:var(--font-mono);font-size:12px;padding:8px 10px;width:100%;border-radius:var(--radius);resize:vertical;min-height:60px;outline:none;}
  .text-input:focus{border-color:var(--accent);}
  .meal-tracker{display:flex;flex-direction:column;gap:0;}
  .meal-card{padding:12px 0;border-bottom:1px solid var(--border);}
  .meal-card:last-of-type{border-bottom:none;}
  .meal-top{display:flex;align-items:flex-start;gap:10px;}
  .meal-time{font-size:11px;color:var(--accent2);flex-shrink:0;padding-top:1px;min-width:36px;}
  .meal-items{flex:1;font-size:13px;line-height:1.5;}
  .meal-actions{display:flex;gap:4px;flex-shrink:0;}
  .meal-bottom{display:flex;gap:12px;margin-top:6px;padding-left:46px;flex-wrap:wrap;}
  .meal-feel{font-size:11px;font-style:italic;}
  .meal-notes{font-size:11px;color:var(--muted);}
  .meal-form{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:12px;display:flex;flex-direction:column;gap:12px;}
  .meal-form-row{display:flex;gap:10px;}
  .meal-form-group{display:flex;flex-direction:column;gap:6px;position:relative;}
  .form-label{font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);}
  .suggest-list{position:absolute;top:100%;left:0;right:0;background:var(--surface);border:1px solid var(--border);border-top:none;z-index:20;max-height:180px;overflow-y:auto;}
  .suggest-item{padding:8px 10px;font-size:12px;cursor:pointer;border-bottom:1px solid var(--border);}
  .suggest-item:last-child{border-bottom:none;}
  .suggest-item:hover{background:var(--border);}
  .feel-pills{display:flex;flex-wrap:wrap;gap:6px;}
  .feel-pill{background:none;border:1px solid var(--border);color:var(--muted);font-family:var(--font-mono);font-size:11px;padding:5px 12px;cursor:pointer;border-radius:20px;transition:border-color 0.15s,color 0.15s;}
  .feel-pill:hover{border-color:var(--text);color:var(--text);}
  .feel-pill.selected{font-weight:500;}
  .btn-add-meal{background:none;border:1px dashed var(--border);color:var(--accent);font-family:var(--font-mono);font-size:11px;padding:10px;width:100%;cursor:pointer;border-radius:var(--radius);margin-top:8px;transition:border-color 0.15s;letter-spacing:0.06em;}
  .btn-add-meal:hover{border-color:var(--accent);}
  .history-day{margin-bottom:16px;}
  .history-day:last-child{margin-bottom:0;}
  .history-date{font-size:9px;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);}
  .history-meal{display:flex;align-items:baseline;gap:10px;padding:5px 0;flex-wrap:wrap;}
  .history-items{flex:1;font-size:12px;min-width:100px;}
  .meal-feel-small{font-size:10px;font-style:italic;flex-shrink:0;}
  .feel-bars{display:flex;flex-direction:column;gap:8px;}
  .feel-bar-row{display:flex;align-items:center;gap:10px;}
  .feel-bar-label{font-size:11px;width:72px;flex-shrink:0;}
  .feel-bar-outer{flex:1;height:4px;background:var(--border);border-radius:2px;overflow:hidden;}
  .feel-bar-inner{height:100%;border-radius:2px;transition:width 0.5s ease;}
  .feel-bar-count{font-size:10px;color:var(--muted);width:16px;text-align:right;}
  .bar-chart{display:flex;align-items:flex-end;gap:8px;height:100px;}
  .bar-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;}
  .bar-outer{flex:1;width:100%;background:var(--border);border-radius:1px;display:flex;align-items:flex-end;overflow:hidden;}
  .bar-inner{width:100%;background:var(--accent);border-radius:1px;transition:height 0.5s ease;}
  .bar-label{font-size:9px;color:var(--muted);text-transform:uppercase;}
  .streak-row-v2{padding:12px 0;border-bottom:1px solid var(--border);}
  .streak-row-v2:last-child{border-bottom:none;}
  .streak-row-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
  .streak-name{font-size:12px;}
  .streak-badges{display:flex;gap:6px;}
  .sbadge{font-size:9px;padding:2px 7px;border-radius:2px;background:var(--border);}
  .sbadge.accent{color:var(--accent);}
  .sbadge.muted{color:var(--muted);}
  .streak-track{display:flex;gap:4px;}
  .streak-dot{width:10px;height:10px;border-radius:50%;background:var(--border);}
  .streak-dot.filled{background:var(--accent);}
  .table-scroll{overflow-x:auto;}
  .data-table{width:100%;border-collapse:collapse;font-size:11px;}
  .data-table th{text-align:left;color:var(--muted);font-weight:400;padding:6px 8px 10px;border-bottom:1px solid var(--border);white-space:nowrap;}
  .data-table td{padding:8px 8px;border-bottom:1px solid var(--border);white-space:nowrap;}
  .data-table tr:last-child td{border-bottom:none;}
  .corr-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);}
  .corr-row:last-child{border-bottom:none;}
  .corr-icon{color:var(--accent2);width:14px;text-align:center;}
  .corr-label{font-size:11px;flex:1;}
  .corr-bar-outer{width:100px;height:4px;background:var(--border);border-radius:2px;overflow:hidden;}
  .corr-bar-inner{height:100%;border-radius:2px;transition:width 0.5s ease;}
  .corr-bar-inner.pos{background:var(--accent);}
  .corr-bar-inner.neg{background:var(--danger);}
  .corr-val{font-size:11px;width:36px;text-align:right;}
  .corr-n{font-size:9px;color:var(--muted);width:30px;}
  .settings-hint{font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.6;}
  .warn{font-size:11px;color:var(--danger);margin-top:8px;}
  .settings-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);}
  .settings-row:last-child{border-bottom:none;}
  .settings-row-info{display:flex;flex-direction:column;gap:2px;}
  .settings-time{font-size:10px;color:var(--muted);}
  .settings-row-actions{display:flex;gap:6px;align-items:center;}
  .inactive{color:var(--muted);text-decoration:line-through;}
  .btn-primary{background:var(--accent);color:var(--bg);border:none;font-family:var(--font-mono);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:8px 16px;cursor:pointer;border-radius:var(--radius);font-weight:500;transition:opacity 0.15s;}
  .btn-primary:hover{opacity:0.85;}
  .btn-ghost{background:none;border:1px solid var(--border);color:var(--text);font-family:var(--font-mono);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;padding:8px 16px;cursor:pointer;border-radius:var(--radius);transition:border-color 0.15s;}
  .btn-ghost:hover{border-color:var(--text);}
  .btn-add{background:none;border:1px solid var(--border);color:var(--accent);font-family:var(--font-mono);font-size:10px;padding:4px 10px;cursor:pointer;border-radius:var(--radius);}
  .btn-toggle{background:none;border:1px solid var(--border);color:var(--muted);font-family:var(--font-mono);font-size:10px;padding:4px 8px;cursor:pointer;border-radius:var(--radius);}
  .btn-icon{background:none;border:1px solid var(--border);color:var(--muted);font-size:12px;width:26px;height:26px;cursor:pointer;border-radius:var(--radius);display:flex;align-items:center;justify-content:center;}
  .btn-icon.danger:hover{color:var(--danger);border-color:var(--danger);}
  .edit-form{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:12px;display:flex;flex-direction:column;gap:8px;}
  .edit-input{background:var(--surface);border:1px solid var(--border);color:var(--text);font-family:var(--font-mono);font-size:12px;padding:8px 10px;border-radius:var(--radius);outline:none;width:100%;}
  .edit-input:focus{border-color:var(--accent);}
  select.edit-input option{background:var(--surface);}
  .edit-actions{display:flex;gap:8px;margin-top:4px;}
  .empty{font-size:11px;color:var(--muted);font-style:italic;}
`;
