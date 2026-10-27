/* Kötészet – könyvoldalak fotóiból kereshető PDF és EPUB, a telefonon.
   Minden adat a készüléken marad (IndexedDB). A szövegfelismerés (Tesseract) helyben fut. */
"use strict";
const $=(s,r=document)=>r.querySelector(s);
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const withTimeout=(p,ms)=>Promise.race([p,new Promise((_,r)=>setTimeout(()=>r(new Error("időtúllépés")),ms))]);
const BASE=document.baseURI;
const LOW_CONF=80;
const ROLES={text:"Szöveg",image:"Csak kép",pdfOnly:"Csak PDF",back:"Hátlap, fül"};

/* ---------- tárolás ---------- */
let dbp=null;
function idb(){ if(!dbp) dbp=new Promise((res,rej)=>{ const r=indexedDB.open("koteszet",1);
  r.onupgradeneeded=()=>{const d=r.result; d.createObjectStore("books",{keyPath:"id"}); d.createObjectStore("images");};
  r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); r.onblocked=()=>rej(new Error("blocked"));}); return dbp; }
async function tx(store,mode,fn){ const d=await idb(); return new Promise((res,rej)=>{ const t=d.transaction(store,mode); const s=t.objectStore(store);
  let out; const r=fn(s); if(r) r.onsuccess=()=>{out=r.result}; t.oncomplete=()=>res(out); t.onerror=()=>rej(t.error); t.onabort=()=>rej(t.error);}); }
const memImgs=new Map(); let idbBroken=false;
const getAllBooks=()=>tx("books","readonly",s=>s.getAll());
async function putBookNow(b){ if(idbBroken) return; await withTimeout(tx("books","readwrite",s=>s.put(b)),10000); }
async function delBookRec(id){ if(idbBroken) return; try{ await tx("books","readwrite",s=>s.delete(id)); }catch{} }
async function putImg(id,blob){ if(!idbBroken){ try{ await withTimeout(tx("images","readwrite",s=>s.put(blob,id)),15000); return; }catch(e){ console.warn(e); idbBroken=true; S.storageOk=false; } } memImgs.set(id,blob); }
async function getImg(id){ if(memImgs.has(id)) return memImgs.get(id); if(idbBroken) return null; try{ return await withTimeout(tx("images","readonly",s=>s.get(id)),15000); }catch{ return null; } }
async function delImg(id){ dropUrl(id); memImgs.delete(id); if(idbBroken) return; try{ await tx("images","readwrite",s=>s.delete(id)); }catch{} }
const urls=new Map();
function dropUrl(id){ if(urls.has(id)){URL.revokeObjectURL(urls.get(id)); urls.delete(id);} }
async function imgUrl(id){ if(urls.has(id)) return urls.get(id); const b=await getImg(id); if(!b) return ""; const u=URL.createObjectURL(b); urls.set(id,u); return u; }

const saveTimers=new Map();
function save(b,now){ b.updated=Date.now(); clearTimeout(saveTimers.get(b.id));
  const run=()=>putBookNow(b).catch(()=>toast("Nem sikerült menteni a változást a telefonra."));
  if(now) return run(); saveTimers.set(b.id,setTimeout(run,600)); }

const S={books:[],cur:null,view:"book",edit:null,storageOk:true,installEvt:null,updateReady:null};
const book=()=>S.books.find(b=>b.id===S.cur);
const allPages=b=>b.chapters.flatMap(c=>c.pages);
/* kimarad a kiolvasásból: borító és a kézzel „Csak kép”-nek jelölt oldal */
const noOcr=(b,p)=>p.id===b.cover||(p.role==="image"&&p.roleManual);
const pending=b=>allPages(b).filter(p=>p.status!=="done"&&!noOcr(b,p)).length;
const roleOf=(b,p)=>p.id===b.cover?"cover":(p.role||"text");
const DEF_OPTS={hyphen:true,reflow:true,dropNums:true,dashes:true,dropHeads:true,blurb:true,enhance:true};
/* az eredeti fotó külön kulcson marad meg a lezárásig */
const OID=id=>"o_"+id;
function newBook(title,author){ return {id:uid(),uuid:(crypto.randomUUID?crypto.randomUUID():uid()+uid()),title:title||"Névtelen könyv",author:author||"",
  cover:null,coverData:null,status:"active",saved:{},opts:{...DEF_OPTS},chapters:[{id:uid(),title:"1. fejezet",pages:[]}],created:Date.now(),updated:Date.now()}; }
function fixBook(b){ b.status=b.status||"active"; b.saved=b.saved||{}; b.opts=Object.assign({...DEF_OPTS},b.opts||{});
  for(const p of allPages(b)){ if(p.status==="working") p.status="new"; if(p.text==null) p.text=""; if(!p.role) p.role="text"; } return b; }

/* ---------- felület segédek ---------- */
let toastT;
function toast(msg,ms=4200){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true,ms); }
function ask(msg,yes="Igen",danger=true){ return new Promise(res=>{ const root=$("#modalRoot");
  root.innerHTML=`<div class="modal"><div class="box" role="dialog" aria-modal="true"><p>${esc(msg)}</p><div class="row" style="justify-content:flex-end">
  <button class="btn" id="mNo">Mégse</button><button class="btn ${danger?"danger":"primary"}" id="mYes">${esc(yes)}</button></div></div></div>`;
  const done=v=>{root.innerHTML="";res(v);}; $("#mNo").onclick=()=>done(false); $("#mYes").onclick=()=>done(true); $("#mYes").focus(); }); }
let wl=null;
async function keepAwake(on){ try{ if(on&&!wl&&navigator.wakeLock){ wl=await navigator.wakeLock.request("screen"); wl.addEventListener("release",()=>{wl=null;}); } else if(!on&&wl){ const w=wl; wl=null; await w.release(); } }catch{} }
let busyCount=0; function busy(on){ busyCount+=on?1:-1; keepAwake(busyCount>0); }

/* ---------- képek ---------- */
async function decode(blob){ try{ return await createImageBitmap(blob,{imageOrientation:"from-image"}); }catch{}
  try{ return await createImageBitmap(blob); }catch{}
  return await withTimeout(new Promise((res,rej)=>{const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error("ezt a képformátumot a böngésző nem tudja megnyitni")); i.src=URL.createObjectURL(blob);}),20000); }
function toBlob(c,q=0.88){ return new Promise(r=>c.toBlob(r,"image/jpeg",q)); }
async function scaleTo(blob,max,q){ const bmp=await decode(blob); const k=Math.min(1,max/Math.max(bmp.width,bmp.height));
  const c=document.createElement("canvas"); c.width=Math.round(bmp.width*k); c.height=Math.round(bmp.height*k);
  c.getContext("2d").drawImage(bmp,0,0,c.width,c.height); const out=await toBlob(c,q); if(bmp.close) bmp.close(); return {blob:out,w:c.width,h:c.height}; }
async function rotateImage(id){ const src=await getImg(id); if(!src) return null; const bmp=await decode(src); const c=document.createElement("canvas"); c.width=bmp.height; c.height=bmp.width;
  const x=c.getContext("2d"); x.translate(c.width,0); x.rotate(Math.PI/2); x.drawImage(bmp,0,0); await putImg(id,await toBlob(c)); dropUrl(id); return {w:c.width,h:c.height}; }
/* oldal forgatása: a javított kép, az eredeti és a sarkok együtt fordulnak (90° jobbra) */
async function rotatePage(p){ const d=await rotateImage(p.id); await rotateImage(OID(p.id));
  if(p.quad) p.quad=[p.quad[3],p.quad[0],p.quad[1],p.quad[2]].map(([x,y])=>[1-y,x]); return d; }
async function delPage(p){ await delImg(p.id); await delImg(OID(p.id)); }

/* ---------- képjavítás ---------- */
const BLUR_LIM=80, GLARE_LIM=0.02;
/* quad: undefined = automatikus lapkeresés, null = nincs vágás, tömb = kézi sarkok */
async function processPage(p,quad){ const ob=await getImg(OID(p.id))||await getImg(p.id); if(!ob) throw new Error("hiányzik a kép");
  const bmp=await decode(ob); const r=KImage.enhance(bmp,quad===undefined?{}:{quad}); if(bmp.close) bmp.close();
  if(!await getImg(OID(p.id))) await putImg(OID(p.id),ob);
  await putImg(p.id,await toBlob(r.canvas,0.88)); dropUrl(p.id);
  Object.assign(p,{w:r.canvas.width,h:r.canvas.height,quad:r.quad,enh:true,sharp:Math.round(r.sharp),glare:+r.glare.toFixed(4),lines:null,
    warn:r.sharp<BLUR_LIM?"blur":r.glare>GLARE_LIM?"glare":null});
  r.canvas.width=r.canvas.height=0; return p; }
async function restoreOriginal(p){ const ob=await getImg(OID(p.id)); if(!ob) return false; await putImg(p.id,ob); dropUrl(p.id);
  const bmp=await decode(ob); Object.assign(p,{w:bmp.width,h:bmp.height,quad:null,enh:false,warn:null,lines:null}); if(bmp.close) bmp.close(); return true; }
const WARN_TEXT={blur:"Homályosnak tűnik, érdemes újrafotózni.",glare:"Csillogó, kiégett folt van rajta, érdemes más szögből újrafotózni."};
function dataUrlToBlob(d){ const [h,b64]=d.split(","); const bin=atob(b64); const u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
  return new Blob([u],{type:(h.match(/data:([^;]+)/)||[])[1]||"image/jpeg"}); }
function blobToDataUrl(b){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(r.error); r.readAsDataURL(b); }); }
async function coverBlob(b){ if(b.cover){ const x=await getImg(b.cover); if(x) return x; } return b.coverData?dataUrlToBlob(b.coverData):null; }

async function addFiles(b,chId,files){ const ch=b.chapters.find(c=>c.id===chId); if(!ch) return;
  const list=[...files].filter(f=>!f.type||f.type.startsWith("image/")||/\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)).sort((a,c)=>(a.name||"").localeCompare(c.name||"",undefined,{numeric:true}));
  if(!list.length){ toast("Ezek között nem találtam képet."); return; }
  if(navigator.storage&&navigator.storage.persist) navigator.storage.persist().catch(()=>{});
  let ok=0, err=""; busy(true);
  for(let i=0;i<list.length;i++){ const f=list[i]; if(list.length>1) toast(`${i+1}/${list.length}. kép előkészítése…`,60000);
    try{ const r=await withTimeout(scaleTo(f,2400,0.88),60000); const id=uid(); await putImg(id,r.blob);
      const p={id,text:"",status:"new",conf:null,w:r.w,h:r.h,lines:null,edited:false,role:"text"};
      if(b.opts.enhance){ await putImg(OID(id),r.blob); try{ await withTimeout(processPage(p),60000); }catch(e){ console.warn("képjavítás",e); } }
      ch.pages.push(p); ok++; }
    catch(e){ console.error(e); if(!err) err=(e&&e.message)||String(e); } }
  busy(false);
  if(b.status==="done") b.status="active";
  save(b,true); render();
  const bad=ch.pages.map((p,i)=>p.warn&&!p.warnSeen?i+1:0).filter(Boolean); ch.pages.forEach(p=>p.warnSeen=true);
  toast((ok===list.length?`${ok} oldal hozzáadva.`:`${ok} oldal hozzáadva, ${list.length-ok} képet nem tudtam megnyitni (${err}).`)
    +(bad.length?` Gyenge fotó (homályos vagy csillogó): ${bad.join(", ")}. oldal, érdemes újrafotózni.`:""),bad.length?10000:7000); }
/* egy oldal fotójának cseréje (újrafotózás), a helye és a fejezete marad */
async function replacePhoto(b,p,file){ busy(true); try{ const r=await withTimeout(scaleTo(file,2400,0.88),60000);
  await putImg(p.id,r.blob); await delImg(OID(p.id)); Object.assign(p,{text:"",status:"new",conf:null,w:r.w,h:r.h,lines:null,edited:false,quad:null,enh:false,warn:null,doubt:false});
  if(!p.roleManual) p.role="text";
  if(b.opts.enhance){ await putImg(OID(p.id),r.blob); try{ await withTimeout(processPage(p),60000); }catch(e){ console.warn(e); } }
  dropUrl(p.id); save(b,true); toast(p.warn?"Kicserélve, de ez a fotó is gyengének tűnik.":"Kicserélve. Most kiolvashatod az oldalt."); } finally{ busy(false); } }

/* ---------- szövegfelismerés ---------- */
let worker=null, ocr={running:false,stop:false,done:0,total:0,cur:0,bookId:null};
async function getWorker(){ if(worker) return worker;
  worker=await Tesseract.createWorker("hun",1,{workerPath:new URL("tess/worker.min.js",BASE).href,corePath:new URL("tess/",BASE).href,
    langPath:new URL("lang",BASE).href,workerBlobURL:false,gzip:true,cacheMethod:"none",
    logger:m=>{ if(m.status==="recognizing text"){ocr.cur=m.progress||0; paintOcr();} else if(ocr.running&&!ocr.done){ setOcrText(loadingText(m)); } }});
  // automatikus oldalfelbontás (a rajzok melletti szöveghasábokat így jobban külön veszi)
  try{ await worker.setParameters({tessedit_pageseg_mode:"3"}); }catch(e){ console.warn(e); }
  return worker; }
function loadingText(m){ const map={"loading tesseract core":"Olvasómotor betöltése","initializing tesseract":"Olvasómotor indítása","loading language traineddata":"Magyar nyelvi adat betöltése","initializing api":"Előkészítés"};
  return (map[m.status]||"Előkészítés")+(m.progress?` · ${Math.round(m.progress*100)}%`:""); }
function setOcrText(t){ const el=$("#ocrText"); if(el) el.textContent=t; }
function paintOcr(){ const bar=$("#ocrBar"); if(!bar) return; const pct=ocr.total?((ocr.done+ocr.cur)/ocr.total)*100:0; bar.style.width=pct.toFixed(1)+"%";
  if(ocr.running&&ocr.bookId===S.cur) setOcrText(`${ocr.done+1}. oldal olvasása a ${ocr.total}-ból · ${Math.round(ocr.cur*100)}%`); }
/* Oldalszerep kitalálása a kiolvasás után (kézi beállítást nem ír felül) */
function autoRole(b,p,r){ if(p.roleManual) return;
  const pages=allPages(b), idx=pages.indexOf(p), short=r.words<10||r.caps;
  if(!b.cover&&idx===0&&short){ b.cover=p.id; b.coverData=null; p.role="image"; return; }
  const low=s=>s.toLocaleLowerCase("hu");
  const titleHit=idx<Math.max(4,pages.length*0.1)&&low(b.title||"").split(/\s+/).filter(w=>w.length>=5).some(w=>low(r.text).includes(w));
  p.role=/ISBN|ISSN|©|\bKIADÁS\b|\(c\)\s*\d{4}|Felelős (kiadó|szerkesztő)|Nyomda|\d példány/.test(r.text)?"pdfOnly"   // impresszum
    :(short||r.words<30)&&(titleHit||/KIADÓ/.test(r.text))?"pdfOnly"   // címlap (dedikálással is)
    :short?"image":"text"; }
async function runOcr(b,onlyIds){ if(ocr.running){ toast("Már fut egy kiolvasás."); return; }
  const cand=allPages(b).filter(p=>onlyIds?onlyIds.includes(p.id):(p.status!=="done"&&!noOcr(b,p)));
  const targets=[]; let missing=0; for(const p of cand){ if(await getImg(p.id)) targets.push(p); else missing++; }
  if(!targets.length){ toast(missing?`${missing} oldal képe hiányzik, ezeket nem lehet kiolvasni.`:"Nincs kiolvasásra váró oldal."); return; }
  Object.assign(ocr,{running:true,stop:false,done:0,total:targets.length,cur:0,bookId:b.id}); busy(true); render();
  let w; try{ setOcrText("Olvasómotor betöltése…"); w=await getWorker(); }
  catch(e){ console.error(e); ocr.running=false; worker=null; busy(false); render(); toast("Nem sikerült elindítani a szövegfelismerést. Ellenőrizd az internetkapcsolatot (az első indításhoz kell), és próbáld újra.",7000); return; }
  for(const p of targets){ if(ocr.stop) break; p.status="working"; ocr.cur=0; paintThumb(p); paintOcr();
    try{ const blob=await getImg(p.id); const {data}=await w.recognize(blob,{}, {text:true,blocks:true});
      const r=cleanOcr(data); p.text=r.text; p.lines=r.lines; p.edited=false; p.conf=r.words?r.conf:null; p.doubt=!!r.frag; p.status="done"; autoRole(b,p,r);
      if(!p.w){ const bmp=await decode(blob); p.w=bmp.width; p.h=bmp.height; } }
    catch(e){ console.error(e); p.status="error"; }
    ocr.done++; save(b); paintThumb(p); paintOcr(); if(S.edit&&S.edit.pageId===p.id) renderEditor(); }
  const stopped=ocr.stop; ocr.running=false; busy(false); save(b,true); render();
  toast((stopped?`Leállítva. ${ocr.done} oldal elkészült.`:`Kész: ${ocr.done} oldal kiolvasva.`)+(missing?` ${missing} oldal képe hiányzik.`:"")); }

/* ---------- szöveg összeállítása ---------- */
/* Két oldal szövegének összefűzése: mondatvég után új bekezdés, különben folytatódik */
const MK=/\s*\uE000([^\uE001]+)\uE001/g;
function joinTwo(s,t){ if(!s) return t; return s+(/[.!?…:"”»)]\s*$/.test(s.replace(MK,""))?"\n\n":"\n")+t; }
function paragraphs(s,o){ if(o.dashes) s=fixDashes(s); let lines=s.split("\n");
  if(o.dropNums) lines=lines.filter(l=>!/^\s*[-–—]?\s*\d{1,4}\s*[-–—]?\s*$/.test(l));
  s=lines.join("\n");
  if(o.hyphen) s=s.replace(/([A-Za-zÀ-ž])[-¬]\n[ \t]*([a-zà-ž])/g,"$1$2");
  let ps=s.split(/\n[ \t]*\n/).map(p=>p.trim()).filter(Boolean);
  return o.reflow?ps.map(p=>p.replace(/[ \t]*\n[ \t]*/g," ").replace(/ {2,}/g," ")):ps; }
/* A könyv folyó szövege fejezetenként. Elemek: {p:"bekezdés"} vagy {img:oldalId} (egész oldalas kép).
   A képoldal a mellette álló bekezdés végére kerül, hogy ne vágja ketté a mondatot. */
function bookContent(b){ const o=b.opts;
  const textPages=allPages(b).filter(p=>roleOf(b,p)==="text");
  const rep=o.dropHeads?repeatedLines(textPages.map(p=>p.text||"")):new Set();
  const txt=p=>dropRepeated((p.text||"").replace(/\r/g,""),rep).trim();
  const toItems=s=>{ const items=[]; for(const para of paragraphs(s,o)){ const ids=[];
      const clean=para.replace(MK,(_,id)=>{ids.push(id);return "";}).trim(); if(clean) items.push({p:clean}); ids.forEach(id=>items.push({img:id})); } return items; };
  const out=b.chapters.map((c,i)=>{ let s="", pend=[], lead=[];
    for(const p of c.pages){ const r=roleOf(b,p);
      if(r==="image"){ pend.push(p.id); continue; } if(r!=="text") continue;
      let t=txt(p); if(!t) continue;
      if(pend.length&&!s){ lead.push(...pend); pend=[]; }   // a fejezet eleji képek a szöveg elé
      if(pend.length){ const mk=pend.map(id=>`\uE000${id}\uE001`).join(""); pend=[]; const k=t.indexOf("\n\n"); t=k<0?t+" "+mk:t.slice(0,k)+" "+mk+t.slice(k); }
      s=joinTwo(s,t); }
    if(pend.length) s+=(s?" ":"")+pend.map(id=>`\uE000${id}\uE001`).join("");
    return {title:c.title.trim()||`${i+1}. fejezet`,items:[...lead.map(id=>({img:id})),...toItems(s)]}; });
  if(o.blurb){ const back=allPages(b).filter(p=>roleOf(b,p)==="back").map(txt).filter(Boolean);
    if(back.length) out.push({title:"Fülszöveg",items:toItems(back.join("\n\n"))}); }
  for(const c of out) c.paras=c.items.filter(x=>x.p).map(x=>x.p);
  return out.filter(c=>c.items.length); }
const fileBase=b=>((b.author?b.author+" - ":"")+b.title).replace(/[\\/:*?"<>|]+/g,"").replace(/\s+/g," ").trim()||"konyv";

/* ---------- EPUB ---------- */
async function buildEpub(b){ const chs=bookContent(b); if(!chs.length) throw new Error("empty");
  const z=new JSZip(); z.file("mimetype","application/epub+zip",{compression:"STORE"});
  z.file("META-INF/container.xml",`<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  z.file("OEBPS/style.css","body{font-family:serif;line-height:1.5;margin:0 4%}h1{font-size:1.4em;text-align:center;margin:2em 0 1.2em}p{margin:0;text-indent:1.3em;text-align:justify}h1+p{text-indent:0}.cover{text-align:center;margin:0;padding:0}.cover img{max-width:100%;max-height:100%}.tp{text-align:center;margin-top:30%}.tp h1{font-size:1.8em}.tp p{text-indent:0;text-align:center;font-style:italic}.fig{text-align:center;margin:1em 0;page-break-inside:avoid}.fig img{max-width:100%;max-height:95vh}");
  const head=t=>`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="hu" lang="hu"><head><meta charset="UTF-8"/><title>${esc(t)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>`;
  const man=[], spine=[];
  let cb=await coverBlob(b); let coverOk=false;
  if(cb){ try{ cb=(await scaleTo(cb,1400,0.82)).blob; }catch{}
    z.file("OEBPS/cover.jpg",cb); coverOk=true;
    z.file("OEBPS/cover.xhtml",head("Borító")+`<div class="cover"><img src="cover.jpg" alt="Borító"/></div></body></html>`);
    man.push(`<item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`,`<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="cover"/>`); }
  z.file("OEBPS/title.xhtml",head(b.title)+`<div class="tp"><h1>${esc(b.title)}</h1>${b.author?`<p>${esc(b.author)}</p>`:""}</div></body></html>`);
  man.push(`<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="title"/>`);
  let nImg=0;
  for(let i=0;i<chs.length;i++){ const c=chs[i], f=`ch${String(i+1).padStart(3,"0")}.xhtml`, body=[];
    for(const it of c.items){ if(it.p!=null){ body.push(`<p>${esc(it.p)}</p>`); continue; }
      const blob=await getImg(it.img); if(!blob) continue; let jb=blob; try{ jb=(await scaleTo(blob,1400,0.8)).blob; }catch{}
      nImg++; const name=`img/k${String(nImg).padStart(3,"0")}.jpg`; z.file("OEBPS/"+name,jb);
      man.push(`<item id="k${nImg}" href="${name}" media-type="image/jpeg"/>`); body.push(`<div class="fig"><img src="${name}" alt="Kép"/></div>`); }
    z.file("OEBPS/"+f,head(c.title)+`<section epub:type="chapter"><h1>${esc(c.title)}</h1>\n${body.join("\n")}</section></body></html>`);
    man.push(`<item id="c${i+1}" href="${f}" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="c${i+1}"/>`); }
  z.file("OEBPS/nav.xhtml",head("Tartalom")+`<nav epub:type="toc" id="toc"><h1>Tartalom</h1><ol>${chs.map((c,i)=>`<li><a href="ch${String(i+1).padStart(3,"0")}.xhtml">${esc(c.title)}</a></li>`).join("")}</ol></nav></body></html>`);
  z.file("OEBPS/toc.ncx",`<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${b.uuid}"/></head><docTitle><text>${esc(b.title)}</text></docTitle><navMap>${chs.map((c,i)=>`<navPoint id="n${i+1}" playOrder="${i+1}"><navLabel><text>${esc(c.title)}</text></navLabel><content src="ch${String(i+1).padStart(3,"0")}.xhtml"/></navPoint>`).join("")}</navMap></ncx>`);
  const mod=new Date().toISOString().replace(/\.\d+Z$/,"Z");
  z.file("OEBPS/content.opf",`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="hu"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:${b.uuid}</dc:identifier><dc:title>${esc(b.title)}</dc:title>${b.author?`<dc:creator>${esc(b.author)}</dc:creator>`:""}<dc:language>hu</dc:language><meta property="dcterms:modified">${mod}</meta>${coverOk?`<meta name="cover" content="cover-img"/>`:""}</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>${man.join("")}</manifest><spine toc="ncx">${spine.join("")}</spine></package>`);
  return z.generateAsync({type:"blob",mimeType:"application/epub+zip",compression:"DEFLATE"}); }

/* ---------- PDF ---------- */
let fontB64=null;
async function loadFont(){ if(fontB64) return fontB64; const buf=new Uint8Array(await (await fetch(new URL("fonts/DejaVuSerif.ttf",BASE))).arrayBuffer());
  let s=""; for(let i=0;i<buf.length;i+=0x8000) s+=String.fromCharCode.apply(null,buf.subarray(i,i+0x8000)); return fontB64=btoa(s); }
async function newPdf(fmt,orient){ const {jsPDF}=window.jspdf; const doc=new jsPDF({unit:"pt",format:fmt,orientation:orient,compress:true});
  doc.addFileToVFS("DejaVuSerif.ttf",await loadFont()); doc.addFont("DejaVuSerif.ttf","DejaVu","normal"); doc.setFont("DejaVu","normal"); return doc; }

/* Van-e színes rajz a lapon (a papír alapszínéhez képest) */
function isColorful(cv){ const k=Math.min(1,240/Math.max(cv.width,cv.height)); const c=document.createElement("canvas"); c.width=Math.max(1,Math.round(cv.width*k)); c.height=Math.max(1,Math.round(cv.height*k));
  const x=c.getContext("2d",{willReadFrequently:true}); x.drawImage(cv,0,0,c.width,c.height); const d=x.getImageData(0,0,c.width,c.height).data;
  const hist=new Uint32Array(256), ch=new Uint8Array(d.length/4);
  for(let i=0,j=0;i<d.length;i+=4,j++){ const v=Math.max(d[i],d[i+1],d[i+2])-Math.min(d[i],d[i+1],d[i+2]); ch[j]=v; hist[v]++; }
  let acc=0, med=0; for(;med<256;med++){ acc+=hist[med]; if(acc>=ch.length/2) break; }
  let col=0; for(const v of ch) if(v>med+20) col++;   // a papír árnyalatához képest érezhetően színes
  return col/ch.length>0.0015; }
/* PDF-oldalkép: szöveges oldal szürkeárnyalatos, ha nincs rajta színes rajz; képes oldal mindig színes */
async function pdfImage(blob,role){ const bmp=await decode(blob); const k=Math.min(1,1700/Math.max(bmp.width,bmp.height));
  const c=document.createElement("canvas"); c.width=Math.round(bmp.width*k); c.height=Math.round(bmp.height*k); const x=c.getContext("2d",{willReadFrequently:true}); x.drawImage(bmp,0,0,c.width,c.height); if(bmp.close) bmp.close();
  let gray=false;
  if((role==="text"||role==="pdfOnly")&&!isColorful(c)){ gray=true; const im=x.getImageData(0,0,c.width,c.height), d=im.data;
    for(let i=0;i<d.length;i+=4){ const v=(d[i]*299+d[i+1]*587+d[i+2]*114)/1000; d[i]=d[i+1]=d[i+2]=v; } x.putImageData(im,0,0); }
  return {blob:await toBlob(c,gray?0.68:0.72),w:c.width,h:c.height,gray}; }

/* Képes, kereshető PDF: minden oldal a fotó, alatta láthatatlan szövegréteg. Borító elöl, hátlap/fül a végén. */
async function buildImagePdf(b,onProg){
  const order=[], tail=[]; const cov=b.cover?allPages(b).find(p=>p.id===b.cover):null; if(cov) order.push({p:cov,ch:null});
  b.chapters.forEach(c=>{ let first=true; for(const p of c.pages){ if(p.id===b.cover) continue; if(roleOf(b,p)==="back"){ tail.push({p,ch:null}); continue; } order.push({p,ch:first?c:null}); first=false; } });
  order.push(...tail);
  let doc=null, n=0, missing=0;
  for(let i=0;i<order.length;i++){ const {p,ch}=order[i]; onProg&&onProg(i,order.length);
    const blob=await getImg(p.id); if(!blob){ missing++; continue; }
    const img=await pdfImage(blob,roleOf(b,p)); const bytes=new Uint8Array(await img.blob.arrayBuffer());
    const s=595/Math.max(img.w,img.h), pw=img.w*s, ph=img.h*s, orient=pw>ph?"l":"p";
    if(!doc) doc=await newPdf([pw,ph],orient); else doc.addPage([pw,ph],orient);
    n++; doc.addImage(bytes,"JPEG",0,0,pw,ph,undefined,"NONE");
    const k=pw/(p.w||img.w);
    if(p.lines&&p.lines.length&&!p.edited){
      for(const ln of p.lines){ const hh=(ln.y1-ln.y0)*k; if(hh<=0) continue; const fs=Math.max(3,hh*0.82); doc.setFontSize(fs);
        const tw=doc.getTextWidth(ln.t), target=(ln.x1-ln.x0)*k;
        doc.text(ln.t,ln.x0*k,ln.y1*k-hh*0.18,{renderingMode:"invisible",horizontalScale:tw>0?Math.max(0.2,Math.min(5,target/tw)):1}); } }
    else if(p.text&&p.text.trim()){ const ls=p.text.split("\n").map(x=>x.trim()).filter(Boolean); const top=ph*0.06, lh=Math.min(16,(ph*0.88)/Math.max(ls.length,1)), fs=lh*0.75;
      doc.setFontSize(fs); ls.forEach((t,j)=>{ const tw=doc.getTextWidth(t), target=pw*0.84; doc.text(t,pw*0.08,top+(j+1)*lh,{renderingMode:"invisible",horizontalScale:tw>target&&tw>0?target/tw:1}); }); }
    if(ch) doc.outline.add(null,ch.title||"Fejezet",{pageNumber:doc.getNumberOfPages()});
    if(i%10===9) await new Promise(r=>setTimeout(r,0)); }
  if(!doc) throw new Error("Ennek a könyvnek már nincsenek meg a képei ezen a telefonon.");
  doc.setProperties({title:b.title,author:b.author||"",creator:"Kötészet"});
  return {blob:doc.output("blob"),n,missing}; }

/* Szöveges PDF (A5) */
async function buildTextPdf(b){ const chs=bookContent(b); if(!chs.length) throw new Error("empty");
  const doc=await newPdf("a5","p"); const W=420,H=595,M=48,TW=W-2*M,LH=15,BOT=H-M-10;
  doc.setFontSize(20); doc.text(doc.splitTextToSize(b.title,TW),W/2,230,{align:"center"});
  if(b.author){ doc.setFontSize(13); doc.text(b.author,W/2,285,{align:"center"}); }
  chs.forEach(c=>{ doc.addPage(); doc.setFontSize(16); let y=M+40; const tl=doc.splitTextToSize(c.title,TW);
    doc.outline.add(null,c.title,{pageNumber:doc.getNumberOfPages()}); tl.forEach(l=>{doc.text(l,W/2,y,{align:"center"}); y+=22;}); y+=16; doc.setFontSize(11);
    c.paras.forEach(p=>{ doc.splitTextToSize(p,TW).forEach(l=>{ if(y>BOT){doc.addPage(); y=M+12;} doc.text(l,M,y); y+=LH; }); y+=LH*0.55; }); });
  const n=doc.getNumberOfPages(); doc.setFontSize(9); for(let i=2;i<=n;i++){ doc.setPage(i); doc.text(String(i-1),W/2,H-24,{align:"center"}); }
  return doc.output("blob"); }
function buildTxt(b){ const chs=bookContent(b); if(!chs.length) throw new Error("empty");
  return new Blob([[b.title,b.author].filter(Boolean).join("\n")+"\n\n\n"+chs.map(c=>c.title+"\n\n"+c.paras.join("\n\n")).join("\n\n\n")+"\n"],{type:"text/plain"}); }

/* ---------- mentés a telefonra / megosztás (Drive) ---------- */
const MIME={pdf:"application/pdf",epub:"application/epub+zip",txt:"text/plain",zip:"application/zip",md:"text/markdown"};
function download(name,blob){ const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=name; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),20000); }
async function deliver(name,blob,how){ const ext=name.split(".").pop(); const file=new File([blob],name,{type:MIME[ext]||blob.type||"application/octet-stream"});
  if(how!=="download"&&navigator.canShare){ try{ if(navigator.canShare({files:[file]})){ await navigator.share({files:[file],title:name}); return "shared"; } }catch(e){ if(e&&e.name==="AbortError") return "cancel"; } }
  download(name,blob); return "downloaded"; }
function deliveredMsg(r,name){ return r==="shared"?`Megosztva: ${name}`:r==="downloaded"?`Letöltve a telefonra: ${name} (Letöltések mappa)`:"Megszakítva."; }

/* ---------- biztonsági mentés ---------- */
async function buildBackup(b){ const z=new JSZip(); const copy=JSON.parse(JSON.stringify(b));
  const cb=await coverBlob(b); if(cb&&!copy.coverData){ try{ copy.coverData=await blobToDataUrl((await scaleTo(cb,900,0.8)).blob); }catch{} }
  z.file("koteszet.json",JSON.stringify({format:"koteszet",version:1,book:copy}));
  for(const p of allPages(b)){ const blob=await getImg(p.id); if(blob) z.file(`kepek/${p.id}.jpg`,blob); const o=await getImg(OID(p.id)); if(o) z.file(`kepek/o_${p.id}.jpg`,o); }
  return z.generateAsync({type:"blob",compression:"STORE"}); }
/* Projektcsomag: a javított, tömörített oldalképek + a szöveg Markdownban + a beállítások.
   Visszatölthető a „Mentett könyv betöltése” gombbal; ebből minden kimenet újra elkészíthető. */
async function buildPackage(b,onProg){ const z=new JSZip(); const copy=JSON.parse(JSON.stringify(b)); const pages=allPages(b); let missing=0;
  for(const p of allPages(copy)){ delete p.warnSeen; }
  const cb=await coverBlob(b); if(cb&&!copy.coverData){ try{ copy.coverData=await blobToDataUrl((await scaleTo(cb,900,0.8)).blob); }catch{} }
  for(let i=0;i<pages.length;i++){ const p=pages[i]; onProg&&onProg(i,pages.length); const blob=await getImg(p.id); if(!blob){ missing++; continue; }
    const img=await pdfImage(blob,roleOf(b,p)); z.file(`kepek/${p.id}.jpg`,img.blob);
    const cp=allPages(copy).find(x=>x.id===p.id); if(cp){ const k=img.w/(p.w||img.w); if(cp.lines&&k!==1) cp.lines=cp.lines.map(l=>({t:l.t,x0:l.x0*k,y0:l.y0*k,x1:l.x1*k,y1:l.y1*k})); cp.w=img.w; cp.h=img.h; } }
  z.file("koteszet.json",JSON.stringify({format:"koteszet",version:2,kind:"projektcsomag",created:new Date().toISOString(),book:copy}));
  z.file("szoveg.md",buildMd(b));
  z.file("OLVASSEL.txt","Kötészet projektcsomag: "+b.title+"\n\nkoteszet.json – a könyv adatai és beállításai\nkepek/ – a javított oldalképek\nszoveg.md – a teljes szöveg Markdownban\n\nVisszatöltés: Kötészet → Mentett könyv betöltése (.zip).\n");
  return {blob:await z.generateAsync({type:"blob",compression:"STORE"}),missing}; }
function buildMd(b){ const chs=bookContent(b); const out=[`# ${b.title}`]; if(b.author) out.push(`*${b.author}*`);
  for(const c of chs){ out.push(`## ${c.title}`); for(const it of c.items) out.push(it.p!=null?it.p.replace(/^([#>*+-]|\d+\.)\s/,"\\$1 "):`![](kepek/${it.img}.jpg)`); }
  return out.join("\n\n")+"\n"; }
async function importBackup(file){ const z=await JSZip.loadAsync(file); const j=z.file("koteszet.json")||z.file("lapolvaso.json"); if(!j) throw new Error("nem mentés");
  const b=JSON.parse(await j.async("string")).book; const remap={};
  b.id=uid(); for(const c of b.chapters){ c.id=uid(); for(const p of c.pages){ const nid=uid(); remap[p.id]=nid;
    const f=z.file(`kepek/${p.id}.jpg`); if(f) await putImg(nid,new Blob([await f.async("arraybuffer")],{type:"image/jpeg"}));
    const o=z.file(`kepek/o_${p.id}.jpg`); if(o) await putImg(OID(nid),new Blob([await o.async("arraybuffer")],{type:"image/jpeg"}));
    p.id=nid; delete p.k; } }
  b.cover=b.cover?remap[b.cover]||null:null; fixBook(b);
  if(S.books.some(x=>x.title===b.title)) b.title+=" (betöltött)";
  S.books.push(b); await save(b,true); return b; }

/* ---------- próbakönyv ---------- */
const SAMPLE=[
 "A régi könyvek különös illatot őriznek. Az antikvárium polcain sorakozó kötetek nemcsak szöveget, hanem egy kor betűformáit, papírját és nyomdászainak gondosságát is magukban hordozzák.",
 "Ez a próbaoldal azért készült, hogy megnézhesd, hogyan dolgozik a Kötészet. A gép most egy fényképnek tekinti ezt a lapot, és a Kiolvasás gombra megpróbálja visszaalakítani belőle a szöveget.",
 "Figyeld meg az ékezeteket: tűzőgép, őszibarack, árvíztűrő tükörfúrógép. Ha ezeket helyesen ismeri fel, a valódi könyveiddel is jó eséllyel boldogul majd.",
 "A második oldalon folytatódik a fejezet. A kész szöveget ellenőrizheted és javíthatod, mielőtt PDF vagy EPUB lesz belőle.",
 "Ha egy mondat az oldal alján félbeszakad, a program a következő oldallal összefűzi, így a felolvasás nem akad meg a lapok határán. A lap tetején és alján álló oldalszámokat pedig kihagyja."];
function drawPage(paras,num){ const c=document.createElement("canvas"); c.width=1240; c.height=1754; const x=c.getContext("2d");
  x.fillStyle="#fbf8f1"; x.fillRect(0,0,c.width,c.height); x.fillStyle="#222"; x.font="38px Georgia, 'Times New Roman', serif";
  let y=200; const L=150,R=c.width-150;
  for(const p of paras){ let line="", first=true; for(const w of p.split(" ")){ const ind=first?60:0; const t=line?line+" "+w:w; if(x.measureText(t).width>R-L-ind){x.fillText(line,L+ind,y);y+=58;line=w;first=false;} else line=t; } x.fillText(line,L+(first?60:0),y); y+=72; }
  x.font="32px Georgia, serif"; x.textAlign="center"; x.fillText(String(num),c.width/2,c.height-120); return toBlob(c); }
async function makeSample(){ const b=newBook("Próbakönyv","Kötészet"); const ch=b.chapters[0]; ch.title="A régi könyvekről";
  const pages=[[SAMPLE[0],SAMPLE[1],SAMPLE[2]],[SAMPLE[3],SAMPLE[4]]];
  for(let i=0;i<pages.length;i++){ const id=uid(); await putImg(id,await drawPage(pages[i],i+7)); ch.pages.push({id,text:"",status:"new",conf:null,w:1240,h:1754,lines:null,edited:false}); }
  S.books.push(b); await save(b,true); S.cur=b.id; S.view="book"; render(); }

/* ---------- megjelenítés ---------- */
function statusClass(p){ if(p.status!=="working"&&p.role==="image"&&(p.roleManual||p.status==="done")) return "img";
  return p.status==="done"?(((p.conf!=null&&p.conf<LOW_CONF)||p.doubt)&&p.role==="text"&&!p.edited?"low":"done"):p.status; }
function statusLabel(p){ return {new:"vár",working:"olvasás",done:"kész",low:"ellenőrizd",error:"hiba",img:"csak kép"}[statusClass(p)]; }
const ROLE_BADGE={image:"kép",pdfOnly:"csak PDF",back:"fül"};
function paintThumb(p){ const el=document.querySelector(`.thumb[data-page="${p.id}"] .st`); if(el){ el.className="st "+statusClass(p); el.parentElement.title=statusLabel(p);
    const th=el.parentElement, b=book(), r=b?roleOf(b,p):"text"; th.className=`thumb${r==="cover"?" cover":""} r-${r}`;
    let bd=th.querySelector(".role"); if(ROLE_BADGE[r]){ if(!bd){ bd=document.createElement("span"); bd.className="role"; th.append(bd); } bd.textContent=ROLE_BADGE[r]; } else if(bd) bd.remove(); }
  const pc=$("#pendCount"); const b=book(); if(pc&&b) pc.textContent=pending(b); }
async function loadThumbs(){ const b=book(); for(const im of document.querySelectorAll("img[data-img]")){ const id=im.dataset.img; const u=await imgUrl(id);
  if(u){ im.src=u; continue; } const p=b&&allPages(b).find(x=>x.id===id); const sp=document.createElement("span"); sp.className="snip";
  sp.textContent=p&&p.text?p.text.slice(0,180):"(nincs kép)"; const btn=im.closest(".thumb"); if(btn) btn.classList.add("txt"); im.replaceWith(sp); } }
const isStandalone=()=>matchMedia("(display-mode: standalone)").matches||navigator.standalone===true;
function banners(){ let h="";
  if(S.updateReady) h+=`<div class="banner"><span>Elérhető a Kötészet új verziója.</span><button class="btn small primary" data-act="update">Frissítés</button></div>`;
  if(!isStandalone()) h+=S.installEvt?`<div class="banner"><span>Telepítsd a Kötészetet a kezdőképernyőre, hogy appként fusson.</span><button class="btn small primary" data-act="install">Telepítés</button></div>`
    :`<div class="banner"><span>Tipp: a Chrome menüjében (⋮) a „Hozzáadás a kezdőképernyőhöz” vagy „Alkalmazás telepítése” pont appként telepíti.</span></div>`;
  if(!S.storageOk) h+=`<p class="warn">Ez a böngésző nem enged adatot tárolni (például inkognitó ablakban), ezért a munka az oldal bezárásakor elveszik.</p>`;
  return h; }
const mast=()=>`<header class="mast"><h1>Köt<span>észet</span></h1><p style="flex-basis:100%">Könyvoldalak fotóiból kereshető PDF és EPUB. Minden a telefonodon marad.</p></header>`;
function bookRow(x){ const all=allPages(x), done=all.length-pending(x)-(x.cover?1:0);
  return `<li class="book" data-act="open" data-id="${x.id}" tabindex="0"><span class="spine" style="${x.status==="done"?"background:var(--gilt)":""}"></span><div style="min-width:0"><div class="book-title">${esc(x.title)}</div>
  <div class="book-meta">${esc(x.author||"Szerző nélkül")} · <span class="mono">${all.length}</span> oldal</div>
  ${x.status!=="done"&&all.length?`<div class="meter"><i style="width:${(Math.max(0,done)/Math.max(1,all.length-(x.cover?1:0))*100).toFixed(0)}%"></i></div>`:""}</div><span class="muted" style="font-size:13px">${x.status==="done"?"kész":""}</span></li>`; }

function render(){ const app=$("#app"); const b=book();
  if(!b){ const lib=S.books.slice().sort((a,c)=>(c.updated||0)-(a.updated||0)); const act=lib.filter(x=>x.status!=="done"), done=lib.filter(x=>x.status==="done");
    app.innerHTML=mast()+banners()+`
    <form class="newbook" id="newBook"><div class="field"><label class="label" for="nbTitle">Könyv címe</label><input id="nbTitle" required placeholder="pl. A kőszívű ember fiai" autocomplete="off"></div>
      <div class="field"><label class="label" for="nbAuthor">Szerző</label><input id="nbAuthor" placeholder="pl. Jókai Mór" autocomplete="off"></div>
      <button class="btn primary" type="submit">Új könyv</button></form>
    ${act.length?`<section class="lib-group"><h2 style="font-size:20px">Folyamatban</h2><ul class="books">${act.map(bookRow).join("")}</ul></section>`:""}
    ${done.length?`<section class="lib-group"><h2 style="font-size:20px">Kész könyvek</h2><ul class="books">${done.map(bookRow).join("")}</ul></section>`:""}
    ${lib.length?"":`<section style="display:flex;flex-direction:column;gap:18px"><h2 style="font-size:20px">Így működik</h2><ol class="steps">
      <li><b>1</b><div><h3>Fotózd le az oldalakat</h3><p>Oldalanként egy fotó, egyenesen, jó fénynél. Fotózhatsz az appból, vagy választhatsz a galériából.</p></div></li>
      <li><b>2</b><div><h3>Kiolvasás és javítás</h3><p>A magyar szövegfelismerés a telefonon fut. Bármikor abbahagyhatod és folytathatod.</p></div></li>
      <li><b>3</b><div><h3>Kész: PDF és EPUB</h3><p>Képes, kereshető PDF és EPUB készül, ezeket a Drive-ra mented, utána a képek törölhetők.</p></div></li></ol>
      <div class="row"><button class="btn" data-act="sample">Próbakönyv betöltése</button><span class="note">Két generált oldal a kipróbáláshoz.</span></div></section>`}
    <div class="row" style="border-top:1px solid var(--line);padding-top:16px"><label class="btn small" style="position:relative">Mentett könyv betöltése (.zip)<input type="file" id="importZip" accept=".zip,application/zip" style="position:absolute;inset:0;width:100%;height:100%;opacity:0;font-size:0"></label>
      ${lib.length?`<button class="btn small ghost" data-act="sample">Próbakönyv</button>`:""}<span class="note" id="usage"></span></div>`;
    try{ navigator.storage.estimate().then(e=>{ const el=$("#usage"); if(el&&e.usage!=null) el.textContent=`Foglalt hely a telefonon: kb. ${Math.round(e.usage/1048576)} MB`; }).catch(()=>{}); }catch{}
    return; }
  if(S.view==="finish") return renderFinish(b);

  const np=pending(b), total=allPages(b).length, mine=ocr.running&&ocr.bookId===b.id, isDone=b.status==="done";
  app.innerHTML=mast()+banners()+`
  <div><button class="btn ghost small" data-act="home">← Könyvtár</button></div>
  <section class="bookhead"><span class="pill ${isDone?"done":"active"}" style="align-self:flex-start">${isDone?"Kész":"Folyamatban"}</span>
    <input id="bTitle" value="${esc(b.title)}" aria-label="Könyv címe"><input id="bAuthor" value="${esc(b.author)}" placeholder="Szerző" aria-label="Szerző"></section>
  ${isDone&&!np?"":`<section class="ocrbar">
    <div class="row" style="justify-content:space-between">
      <div><div class="label">Szövegfelismerés · magyar</div><div><span class="mono" id="pendCount">${np}</span> oldal vár a <span class="mono">${total}</span>-ból</div></div>
      ${mine?`<button class="btn" data-act="stop">Leállítás</button>`:`<button class="btn primary" data-act="ocr" ${np&&!ocr.running?"":"disabled"}>Kiolvasás</button>`}
    </div>
    ${!mine&&total>np?`<div><button class="btn small ghost" data-act="ocrAll" ${ocr.running?"disabled":""}>Minden oldal újraolvasása</button></div>`:""}
    ${mine?`<div class="progress"><i id="ocrBar"></i></div><div class="note" id="ocrText">Indítás…</div>`:`<p class="note">Oldalanként néhány másodperc. Amíg fut, a képernyő ébren marad. A kész oldalak azonnal mentődnek, így bármikor abbahagyhatod.</p>`}
    <div class="legend"><span><i class="st"></i>vár</span><span><i class="st done"></i>kész</span><span><i class="st low"></i>bizonytalan, nézd át</span><span><i class="st error"></i>hiba</span><span><i class="st img"></i>csak kép</span></div>
  </section>`}
  ${b.chapters.map((c,ci)=>`<section class="chap" data-ch="${c.id}">
    <div class="chap-head"><input value="${esc(c.title)}" data-chtitle="${c.id}" aria-label="Fejezet címe"><span class="muted mono" style="font-size:13px">${c.pages.length} old.</span>
      <button class="btn ghost small" data-act="chUp" data-id="${c.id}" ${ci?"":"disabled"} aria-label="Fejezet feljebb">↑</button>
      <button class="btn ghost small" data-act="chDown" data-id="${c.id}" ${ci<b.chapters.length-1?"":"disabled"} aria-label="Fejezet lejjebb">↓</button>
      <button class="btn ghost small danger" data-act="chDel" data-id="${c.id}">Törlés</button></div>
    <div class="pages">${c.pages.map((p,pi)=>{ const r=roleOf(b,p); return `<button class="thumb${r==="cover"?" cover":""} r-${r}" data-act="edit" data-ch="${c.id}" data-page="${p.id}" title="${statusLabel(p)}">
      <img data-img="${p.id}" alt="${pi+1}. oldal"><span class="n mono">${pi+1}</span><span class="st ${statusClass(p)}"></span>${ROLE_BADGE[r]?`<span class="role">${ROLE_BADGE[r]}</span>`:""}${p.warn?`<span class="pwarn" title="${esc(WARN_TEXT[p.warn])}">!</span>`:""}</button>`; }).join("")}</div>
    <div class="addrow"><label class="addbtn">📷 Fotózás<input type="file" accept="image/*" capture="environment" data-add="${c.id}"></label>
      <label class="addbtn">＋ Képek a galériából<input type="file" accept="image/*" multiple data-add="${c.id}"></label></div>
  </section>`).join("")}
  <div><button class="btn" data-act="chAdd">+ Új fejezet</button></div>
  <section class="export">
    <h2 style="font-size:20px">${isDone?"Fájlok újra":"Kész a könyv?"}</h2>
    ${isDone?`<p class="note">A képek törölve, a szöveg megmaradt. Az EPUB és a szöveges fájlok bármikor újra elkészíthetők. Új oldal feltöltésével a könyv újra „Folyamatban” lesz.</p>
      <div class="row"><button class="btn primary" data-act="mk" data-kind="epub">EPUB</button><button class="btn" data-act="mk" data-kind="tpdf">Szöveges PDF</button><button class="btn" data-act="mk" data-kind="txt">TXT</button><button class="btn" data-act="mk" data-kind="md">Markdown</button></div>`
    :`<p class="note">Ha minden oldal megvan és ki van olvasva, itt készül el a képes PDF és az EPUB. A mentésük után törölheted a képeket.</p>
      <div class="row"><button class="btn primary" data-act="toFinish">Tovább a befejezéshez</button></div>`}
    <details class="more"><summary>Beállítások és egyéb</summary><div style="display:flex;flex-direction:column;gap:14px;padding-top:12px">
    <div class="checks">
      <label><input type="checkbox" data-opt="hyphen" ${b.opts.hyphen?"checked":""}><span>Elválasztott szavak összevonása<small>„elvá-/lasztott” → „elválasztott” a sorok végén</small></span></label>
      <label><input type="checkbox" data-opt="reflow" ${b.opts.reflow?"checked":""}><span>Sorok bekezdéssé fűzése<small>Felolvasáshoz és e-olvasóhoz kell. Verseknél kapcsold ki.</small></span></label>
      <label><input type="checkbox" data-opt="dropNums" ${b.opts.dropNums?"checked":""}><span>Oldalszámok kihagyása<small>A csak számot tartalmazó sorokat elhagyja</small></span></label>
      <label><input type="checkbox" data-opt="dropHeads" ${b.opts.dropHeads?"checked":""}><span>Élőfej és élőláb kihagyása<small>Az oldalak tetején/alján sok oldalon ismétlődő sor (pl. a könyv vagy fejezet címe)</small></span></label>
      <label><input type="checkbox" data-opt="dashes" ${b.opts.dashes?"checked":""}><span>Párbeszédjel javítása<small>A sor eleji kötőjelből (-) gondolatjel (–) lesz</small></span></label>
      <label><input type="checkbox" data-opt="enhance" ${b.opts.enhance?"checked":""}><span>Képjavítás feltöltéskor<small>Lapkeresés, háttér levágása, perspektíva, papírfehérítés. Az eredeti fotó a lezárásig megmarad.</small></span></label>
      <label><input type="checkbox" data-opt="blurb" ${b.opts.blurb?"checked":""}><span>Fülszöveg az EPUB végére<small>A „Hátlap, fül” szerepű oldalak szövege külön fejezetben</small></span></label>
    </div>
    ${isDone?"":`<div class="row"><button class="btn small" data-act="mk" data-kind="epub">EPUB most</button><button class="btn small" data-act="mk" data-kind="tpdf">Szöveges PDF</button><button class="btn small" data-act="mk" data-kind="txt">TXT</button><button class="btn small" data-act="mk" data-kind="md">Markdown</button></div>
    ${allPages(b).some(p=>!p.enh)?`<div class="row"><button class="btn small" data-act="enhAll">Képjavítás a régi oldalakra</button><span class="note">A korábban feltöltött, még nem javított oldalakra.</span></div>`:""}`}
    <div class="danger-zone"><button class="btn small" data-act="backup">Biztonsági mentés (.zip)</button><button class="btn small danger" data-act="bookDel">Könyv törlése</button></div>
    <p class="note">A biztonsági mentés a képeket és a szöveget is tartalmazza. Félkész könyvet így vihetsz át másik telefonra.</p></div></details>
  </section>`;
  loadThumbs(); if(mine) paintOcr(); }

function renderFinish(b){ const app=$("#app"); const np=pending(b); const sv=b.saved||{};
  app.innerHTML=mast()+`
  <div><button class="btn ghost small" data-act="back">← Vissza a könyvhöz</button></div>
  <section class="bookhead"><h2 style="font-size:24px">${esc(b.title)}</h2><span class="sub">${esc(b.author||"")}</span></section>
  ${np?`<p class="warn">${np} oldal még nincs kiolvasva. Ezek a képes PDF-ben benne lesznek, de kereshető szöveg nélkül, az EPUB-ból pedig kimaradnak.</p>`:""}
  <div class="done-steps">
    <div class="done-step${sv.pdf?" ok":""}"><b class="num">1</b><div><b>Képes PDF</b><div class="sub">Az oldalak fotói kijelölhető, felolvastatható szöveggel. Ez őrzi meg a képeket.</div><div class="sub" id="pdfProg"></div></div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">${sv.pdf?`<span class="ck">✓ elmentve</span>`:""}<button class="btn primary small" data-act="save" data-kind="ipdf">Mentés / Drive</button><button class="btn ghost small" data-act="save" data-kind="ipdf" data-how="download">Letöltés</button></div></div>
    <div class="done-step${sv.epub?" ok":""}"><b class="num">2</b><div><b>EPUB</b><div class="sub">Kindle-re és ElevenReaderbe. Csak a szöveg, fejezetekkel és borítóval.</div></div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">${sv.epub?`<span class="ck">✓ elmentve</span>`:""}<button class="btn primary small" data-act="save" data-kind="epub">Mentés / Drive</button><button class="btn ghost small" data-act="save" data-kind="epub" data-how="download">Letöltés</button></div></div>
    <div class="done-step${sv.pkg?" ok":""}"><b class="num">3</b><div><b>Projektcsomag (.zip)</b><div class="sub">A javított oldalképek, a szöveg Markdownban és a beállítások. Visszatölthető, és belőle minden újra elkészíthető újrafotózás nélkül.</div><div class="sub" id="pkgProg"></div></div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">${sv.pkg?`<span class="ck">✓ elmentve</span>`:""}<button class="btn primary small" data-act="save" data-kind="pkg">Mentés / Drive</button><button class="btn ghost small" data-act="save" data-kind="pkg" data-how="download">Letöltés</button></div></div>
    <div class="done-step"><b class="num">4</b><div><b>Lezárás</b><div class="sub">A fotók (az eredetiek is) törlődnek a telefonról, a szöveg megmarad. Az EPUB később is újra elkészíthető, a képes PDF a projektcsomagból.</div></div>
      <div><button class="btn small danger" data-act="finish">Képek törlése</button></div></div>
  </div>
  <p class="note">„Mentés / Drive”: megnyílik a telefon megosztás ablaka, ott válaszd a Google Drive-ot. Ha a telefon az adott fájltípust nem tudja megosztani, a Letöltések mappába kerül, onnan a Drive appban tudod feltölteni.</p>`; }

async function renderEditor(){ const root=$("#editorRoot"); const b=book(); if(!S.edit||!b){root.innerHTML="";document.body.style.overflow="";return;}
  const ch=b.chapters.find(c=>c.id===S.edit.chId); const i=ch?ch.pages.findIndex(p=>p.id===S.edit.pageId):-1; if(i<0){S.edit=null;return renderEditor();}
  const p=ch.pages[i]; document.body.style.overflow="hidden";
  const keepScroll=$("#edText")?$("#edText").scrollTop:0; const u=await imgUrl(p.id);
  root.innerHTML=`<div class="editor" role="dialog" aria-modal="true" aria-label="Oldal szerkesztése">
    <div class="ed-top"><button class="btn ghost small" data-act="edClose" aria-label="Bezárás">✕</button>
      <span class="t">${esc(ch.title)} · <span class="mono">${i+1}/${ch.pages.length}</span></span>
      <span class="muted" style="font-size:13px">${b.cover===p.id?"borító":statusLabel(p)}${p.conf!=null&&b.cover!==p.id&&p.role!=="image"?` · <span class="mono">${p.conf}%</span>`:""}</span>
      ${b.cover===p.id?"":`<select id="edRole" class="rolesel" aria-label="Oldal szerepe">${Object.entries(ROLES).map(([k,v])=>`<option value="${k}" ${(p.role||"text")===k?"selected":""}>${v}</option>`).join("")}</select>`}</div>
    ${p.warn&&u?`<div class="ed-warn">⚠ ${WARN_TEXT[p.warn]} <label class="btn small">📷 Újrafotózás<input type="file" accept="image/*" capture="environment" data-replace="${p.id}" hidden></label></div>`:""}
    <div class="ed-body${u?"":" noimg"}"><div class="ed-img"><img id="edImg" alt="Az oldal képe"></div>
      <div class="ed-text"><textarea id="edText" placeholder="${b.cover===p.id?"Ez a borító, a szövegét nem olvassa ki.":p.role==="image"?"Képes oldal: a PDF-ben benne van, az EPUB-ba képként kerül, felolvasásnál kimarad.":p.status==="done"?"Ezen az oldalon nem talált szöveget.":"Még nincs kiolvasva."}" spellcheck="true" lang="hu">${esc(p.text)}</textarea></div></div>
    <div class="ed-bottom">
      <button class="btn small" data-act="edPrev" ${i?"":"disabled"}>‹ Előző</button><button class="btn small" data-act="edNext" ${i<ch.pages.length-1?"":"disabled"}>Következő ›</button>
      <span class="sp"></span>
      <button class="btn small" data-act="edOcr" ${ocr.running||!u?"disabled":""}>${p.status==="done"?"Újraolvasás":"Kiolvasás"}</button>
      <button class="btn small" data-act="edRot" ${u?"":"disabled"}>Forgatás ↻</button>
      <button class="btn small" data-act="edCorners" ${u&&!ocr.running?"":"disabled"}>Sarkok</button>
      ${p.warn?"":`<label class="btn small ${u?"":"disabled"}">📷 Csere<input type="file" accept="image/*" capture="environment" data-replace="${p.id}" hidden ${u?"":"disabled"}></label>`}
      <button class="btn small" data-act="edLeft" ${i?"":"disabled"} aria-label="Előrébb sorolás">←</button><button class="btn small" data-act="edRight" ${i<ch.pages.length-1?"":"disabled"} aria-label="Hátrébb sorolás">→</button>
      <button class="btn small" data-act="edCover" ${u||b.cover===p.id?"":"disabled"}>${b.cover===p.id?"Borító ✓":"Borítónak"}</button>
      <button class="btn small danger" data-act="edDel">Törlés</button></div></div>`;
  if(u) $("#edImg").src=u; $("#edText").scrollTop=keepScroll;
  $("#edText").addEventListener("input",e=>{ p.text=e.target.value; p.edited=true; if(p.status!=="done"){p.status="done";p.conf=null;paintThumb(p);} save(b); }); }

/* ---------- sarkok kézi igazítása ---------- */
let CE=null; // {p, quad, w, h, url}
async function openCorners(b,p){ let ob=await getImg(OID(p.id)); if(!ob){ ob=await getImg(p.id); if(!ob) return; await putImg(OID(p.id),ob); }
  const bmp=await decode(ob); const w=bmp.width, h=bmp.height; if(bmp.close) bmp.close();
  let quad=p.quad; if(!quad){ try{ const c=document.createElement("canvas"); const k=Math.min(1,1200/Math.max(w,h)); c.width=w*k; c.height=h*k; const bm=await decode(ob); c.getContext("2d").drawImage(bm,0,0,c.width,c.height); quad=KImage.findPage(c); }catch{} }
  CE={p,quad:(quad||[[0,0],[1,0],[1,1],[0,1]]).map(q=>q.slice()),w,h,url:URL.createObjectURL(ob)}; renderCorners(); }
function renderCorners(){ let root=$("#cornerRoot"); if(!CE){ if(root) root.remove(); return; }
  if(!root){ root=document.createElement("div"); root.id="cornerRoot"; document.body.append(root); }
  root.innerHTML=`<div class="corners" role="dialog" aria-modal="true" aria-label="Sarkok igazítása">
    <div class="ed-top"><b class="t">Húzd a sarkokat a lap sarkaira</b></div>
    <div class="cstage" id="cStage"><div class="cbox" id="cBox"><img src="${CE.url}" alt="Eredeti fotó" draggable="false"><svg viewBox="0 0 1 1" preserveAspectRatio="none"><polygon id="cPoly" vector-effect="non-scaling-stroke"/></svg>
      ${CE.quad.map((_,i)=>`<span class="hd" data-h="${i}"></span>`).join("")}</div></div>
    <div class="ed-bottom"><button class="btn small" data-act="cCancel">Mégse</button><span class="sp"></span>
      <button class="btn small" data-act="cAuto">Automatikus</button><button class="btn small" data-act="cFull">Teljes kép</button><button class="btn small" data-act="cOrig">Eredeti fotó</button>
      <button class="btn small primary" data-act="cApply">Alkalmaz</button></div></div>`;
  const stage=$("#cStage"), box=$("#cBox"); const fit=()=>{ const k=Math.min((stage.clientWidth-48)/CE.w,(stage.clientHeight-48)/CE.h); box.style.width=CE.w*k+"px"; box.style.height=CE.h*k+"px"; paintCorners(); };
  requestAnimationFrame(fit); addEventListener("resize",fit,{once:true});
  root.querySelectorAll(".hd").forEach(hd=>{ hd.addEventListener("pointerdown",e=>{ e.preventDefault(); hd.setPointerCapture(e.pointerId); const i=+hd.dataset.h;
    const move=ev=>{ const r=box.getBoundingClientRect(); CE.quad[i]=[Math.min(1,Math.max(0,(ev.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(ev.clientY-r.top)/r.height))]; paintCorners(); };
    const up=()=>{ hd.removeEventListener("pointermove",move); hd.removeEventListener("pointerup",up); hd.removeEventListener("pointercancel",up); };
    hd.addEventListener("pointermove",move); hd.addEventListener("pointerup",up); hd.addEventListener("pointercancel",up); }); }); }
function paintCorners(){ const poly=$("#cPoly"); if(!poly||!CE) return; poly.setAttribute("points",CE.quad.map(q=>q.join(",")).join(" "));
  document.querySelectorAll("#cornerRoot .hd").forEach(hd=>{ const [x,y]=CE.quad[+hd.dataset.h]; hd.style.left=x*100+"%"; hd.style.top=y*100+"%"; }); }
async function cornerAction(b,a){ if(!CE) return; const p=CE.p;
  if(a==="cAuto"){ const c=document.createElement("canvas"); const bm=await decode(await getImg(OID(p.id))); const k=Math.min(1,1200/Math.max(CE.w,CE.h)); c.width=CE.w*k; c.height=CE.h*k; c.getContext("2d").drawImage(bm,0,0,c.width,c.height);
    const q=KImage.findPage(c); if(q){ CE.quad=q; paintCorners(); } else toast("Nem találtam egyértelmű lapszélt; igazítsd kézzel."); return; }
  if(a==="cFull"){ CE.quad=[[0,0],[1,0],[1,1],[0,1]]; paintCorners(); return; }
  const url=CE.url, wasDone=p.status==="done";
  if(a==="cApply"||a==="cOrig"){ busy(true); try{
      if(a==="cOrig") await restoreOriginal(p);
      else{ const full=CE.quad.every(([x,y],i)=>Math.abs(x-[0,1,1,0][i])<0.005&&Math.abs(y-[0,0,1,1][i])<0.005); await processPage(p,full?null:CE.quad); }
      save(b,true); } finally{ busy(false); } }
  CE=null; URL.revokeObjectURL(url); renderCorners(); await renderEditor(); render();
  if((a==="cApply"||a==="cOrig")&&wasDone&&!p.edited&&await ask("Megváltozott az oldal képe. Kiolvassam újra?","Újraolvasás",false)) runOcr(b,[p.id]); }

/* ---------- események ---------- */
document.addEventListener("submit",e=>{ if(e.target.id!=="newBook") return; e.preventDefault();
  const b=newBook($("#nbTitle").value.trim(),$("#nbAuthor").value.trim()); S.books.push(b); save(b,true); S.cur=b.id; S.view="book"; render(); scrollTo(0,0); });
document.addEventListener("keydown",e=>{ if(e.key==="Enter"&&e.target.matches(".book")) e.target.click();
  if(e.key==="Escape"&&CE){ const u=CE.url; CE=null; URL.revokeObjectURL(u); renderCorners(); return; }
  if(e.key==="Escape"&&S.edit){S.edit=null;renderEditor();render();} });
document.addEventListener("input",e=>{ const b=book(); if(!b) return; const t=e.target;
  if(t.id==="bTitle"){b.title=t.value;save(b);} else if(t.id==="bAuthor"){b.author=t.value;save(b);}
  else if(t.dataset.chtitle){ const c=b.chapters.find(c=>c.id===t.dataset.chtitle); if(c){c.title=t.value;save(b);} } });
document.addEventListener("change",async e=>{ const t=e.target; const b=book();
  if(t.id==="importZip"&&t.files[0]){ try{ const nb=await importBackup(t.files[0]); S.cur=nb.id; S.view="book"; render(); toast("Betöltve: "+nb.title);}catch{ toast("Ez nem Kötészet-mentés, vagy sérült a fájl."); } t.value=""; return; }
  if(!b) return;
  if(t.dataset.add&&t.files&&t.files.length){ const files=[...t.files]; t.value=""; await addFiles(b,t.dataset.add,files); }
  if(t.dataset.replace&&t.files&&t.files[0]){ const p=allPages(b).find(x=>x.id===t.dataset.replace), f=t.files[0]; t.value=""; if(p){ await replacePhoto(b,p,f); renderEditor(); render(); } }
  if(t.dataset.opt){ b.opts[t.dataset.opt]=t.checked; save(b); }
  if(t.id==="edRole"&&S.edit){ const p=allPages(b).find(x=>x.id===S.edit.pageId); if(p){ p.role=t.value; p.roleManual=true; save(b); paintThumb(p); renderEditor(); } } });

async function makeFile(b,kind,onProg){ const base=fileBase(b);
  if(kind==="epub") return {name:base+".epub",blob:await buildEpub(b)};
  if(kind==="tpdf") return {name:base+" (szöveg).pdf",blob:await buildTextPdf(b)};
  if(kind==="txt") return {name:base+".txt",blob:buildTxt(b)};
  if(kind==="md") return {name:base+".md",blob:new Blob([buildMd(b)],{type:"text/markdown"})};
  if(kind==="pkg"){ const r=await buildPackage(b,onProg); return {name:base+" - projektcsomag.zip",blob:r.blob,missing:r.missing}; }
  if(kind==="ipdf"){ const r=await buildImagePdf(b,onProg); return {name:base+".pdf",blob:r.blob,missing:r.missing}; } }

document.addEventListener("click",async e=>{ const el=e.target.closest("[data-act]"); if(!el) return; const a=el.dataset.act; const b=book();
  const swap=(arr,i,j)=>{[arr[i],arr[j]]=[arr[j],arr[i]];};
  try{ switch(a){
  case "open": S.cur=el.dataset.id; S.view="book"; render(); scrollTo(0,0); break;
  case "home": S.cur=null; render(); break;
  case "back": S.view="book"; render(); scrollTo(0,0); break;
  case "toFinish": S.view="finish"; render(); scrollTo(0,0); break;
  case "sample": await makeSample(); break;
  case "install": if(S.installEvt){ S.installEvt.prompt(); try{ await S.installEvt.userChoice; }catch{} S.installEvt=null; render(); } break;
  case "update": if(S.updateReady){ reloading=true; S.updateReady.postMessage("skipWaiting"); } break;
  case "ocr": runOcr(b); break;
  case "ocrAll": { const all=allPages(b).filter(p=>!noOcr(b,p)), ids=all.filter(p=>!p.edited).map(p=>p.id), ed=all.length-ids.length;
    if(!ids.length){ toast("Minden oldalt kézzel javítottál, ezeket nem olvasom újra."); break; }
    if(!await ask(`Újraolvasom mind a ${ids.length} oldalt a javított szűrővel?${ed?` A ${ed} kézzel javított oldalt kihagyom.`:""} A kézzel beállított oldalszerepek megmaradnak.`,"Újraolvasás",false)) break;
    runOcr(b,ids); break; }
  case "stop": ocr.stop=true; el.disabled=true; el.textContent="Leállítás…"; break;
  case "chAdd": b.chapters.push({id:uid(),title:`${b.chapters.length+1}. fejezet`,pages:[]}); save(b,true); render(); break;
  case "chUp": case "chDown": { const i=b.chapters.findIndex(c=>c.id===el.dataset.id); swap(b.chapters,i,a==="chUp"?i-1:i+1); save(b,true); render(); break; }
  case "chDel": { const c=b.chapters.find(c=>c.id===el.dataset.id); if(!c) break;
    if(!await ask(`Törlöd a „${c.title}” fejezetet és ${c.pages.length} oldalát?`,"Törlés")) break;
    for(const p of c.pages){ await delPage(p); if(b.cover===p.id) b.cover=null; } b.chapters=b.chapters.filter(x=>x!==c);
    if(!b.chapters.length) b.chapters.push({id:uid(),title:"1. fejezet",pages:[]}); save(b,true); render(); break; }
  case "bookDel": if(!await ask(`Véglegesen törlöd a „${b.title}” könyvet a képeivel és a szövegével együtt?`,"Törlés")) break;
    for(const p of allPages(b)) await delPage(p); await delBookRec(b.id); S.books=S.books.filter(x=>x!==b); S.cur=null; render(); toast("A könyv törölve."); break;
  case "mk": case "save": { const kind=el.dataset.kind;
    if(kind!=="ipdf"&&kind!=="pkg"&&!bookContent(b).length){ toast("Még nincs kiolvasott szöveg. Előbb nyomd meg a Kiolvasás gombot."); break; }
    el.disabled=true; const old=el.textContent; el.textContent="Készül…"; busy(true);
    try{ const pid=kind==="pkg"?"#pkgProg":"#pdfProg"; const prog=(i,n)=>{ const pp=$(pid); if(pp) pp.textContent=`${i+1}/${n}. oldal…`; };
      const f=await makeFile(b,kind,prog); const pp=$(pid); if(pp) pp.textContent="";
      const r=await deliver(f.name,f.blob,el.dataset.how); toast(deliveredMsg(r,f.name)+(f.missing?` (${f.missing} oldal képe hiányzott)`:""),6000);
      if(a==="save"&&r!=="cancel"){ b.saved=b.saved||{}; b.saved[{ipdf:"pdf",epub:"epub",pkg:"pkg"}[kind]||kind]=true; save(b,true); render(); } }
    catch(err){ console.error(err); toast(err&&err.message&&err.message!=="empty"?err.message:"Nem sikerült elkészíteni a fájlt.",6000); }
    finally{ busy(false); el.disabled=false; el.textContent=old; } break; }
  case "finish": { const sv=b.saved||{}; const miss=[!sv.pdf&&"a képes PDF-et",!sv.pkg&&"a projektcsomagot"].filter(Boolean);
    const msg=miss.length?`Még nem mentetted el ${miss.join(" és ")}. Ha most törlöd a képeket, ${!sv.pkg?"újrafotózás nélkül nem tudod újra elkészíteni a képes változatot":"a képes PDF elveszik"}. Biztosan törlöd?`:"Törlöd a képeket a telefonról? A szöveg megmarad, az EPUB később is elkészíthető, a projektcsomagból pedig minden.";
    if(!await ask(msg,"Képek törlése")) break;
    const cb=await coverBlob(b); if(cb&&!b.coverData){ try{ b.coverData=await blobToDataUrl((await scaleTo(cb,900,0.8)).blob); }catch{} }
    let n=0; for(const p of allPages(b)){ if(await getImg(p.id)){ n++; } await delPage(p); }
    b.status="done"; save(b,true); S.view="book"; render(); toast(`Lezárva. ${n} kép törölve, a szöveg megmaradt.`); break; }
  case "backup": el.disabled=true; busy(true); try{ const r=await deliver(`${fileBase(b)} - koteszet mentes.zip`,await buildBackup(b)); toast(deliveredMsg(r,"biztonsági mentés")); } finally{ busy(false); el.disabled=false; } break;
  case "edit": S.edit={chId:el.dataset.ch,pageId:el.dataset.page}; renderEditor(); break;
  case "enhAll": { const list=[]; for(const p of allPages(b)) if(!p.enh&&await getImg(p.id)) list.push(p);
    if(!list.length){ toast("Nincs javítatlan oldal."); break; }
    if(!await ask(`Lefuttatom a képjavítást ${list.length} oldalon? Az eredeti fotók a lezárásig megmaradnak, oldalanként visszaállíthatók. A javított oldalakat utána érdemes újraolvasni.`,"Javítás",false)) break;
    busy(true); try{ for(let i=0;i<list.length;i++){ toast(`${i+1}/${list.length}. oldal javítása…`,60000); try{ await processPage(list[i]); }catch(e){ console.warn(e); } paintThumb(list[i]); } }
    finally{ busy(false); } save(b,true); render(); toast("Kész. Most a „Minden oldal újraolvasása” gombbal frissítheted a szöveget.",7000); break; }
  case "cApply": case "cAuto": case "cFull": case "cOrig": case "cCancel": await cornerAction(b,a); break;
  case "edClose": S.edit=null; renderEditor(); render(); break;
  case "edPrev": case "edNext": case "edLeft": case "edRight": case "edDel": case "edOcr": case "edRot": case "edCover": case "edCorners": {
    const ch=b.chapters.find(c=>c.id===S.edit.chId); const i=ch.pages.findIndex(p=>p.id===S.edit.pageId); const p=ch.pages[i];
    if(a==="edPrev"&&i>0) S.edit.pageId=ch.pages[i-1].id;
    if(a==="edNext"&&i<ch.pages.length-1) S.edit.pageId=ch.pages[i+1].id;
    if(a==="edLeft"&&i>0){swap(ch.pages,i,i-1); save(b);}
    if(a==="edRight"&&i<ch.pages.length-1){swap(ch.pages,i,i+1); save(b);}
    if(a==="edCover"){ b.cover=b.cover===p.id?null:p.id; b.coverData=null; save(b); }
    if(a==="edCorners"){ await openCorners(b,p); break; }
    if(a==="edRot"){ el.disabled=true; const d=await rotatePage(p); if(d){ p.w=d.w; p.h=d.h; } p.lines=null; save(b);
      if(p.status==="done"&&await ask("Elforgattad a képet. Kiolvassam újra az oldalt?","Újraolvasás",false)) runOcr(b,[p.id]); }
    if(a==="edOcr"){ runOcr(b,[p.id]); }
    if(a==="edDel"){ if(!await ask("Törlöd ezt az oldalt?","Törlés")) break; await delPage(p); if(b.cover===p.id) b.cover=null; ch.pages.splice(i,1); save(b,true);
      if(!ch.pages.length){S.edit=null; renderEditor(); render(); break;} S.edit.pageId=ch.pages[Math.min(i,ch.pages.length-1)].id; }
    renderEditor(); render(); break; }
  } }catch(err){ console.error(err); toast("Valami nem sikerült: "+(err&&err.message||"ismeretlen hiba"),7000); } });

document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible"&&busyCount>0) keepAwake(true); });
addEventListener("pagehide",()=>{ for(const b of S.books){ if(saveTimers.has(b.id)){ clearTimeout(saveTimers.get(b.id)); putBookNow(b).catch(()=>{}); } } });

/* ---------- telepítés és frissítés ---------- */
let reloading=false;
addEventListener("beforeinstallprompt",e=>{ e.preventDefault(); S.installEvt=e; if(!S.edit) render(); });
addEventListener("appinstalled",()=>{ S.installEvt=null; render(); toast("A Kötészet telepítve. Mostantól a kezdőképernyőről indíthatod."); });
if("serviceWorker" in navigator){
  navigator.serviceWorker.register("sw.js").then(reg=>{
    const mark=w=>{ if(w&&navigator.serviceWorker.controller){ S.updateReady=w; if(!S.edit&&!ocr.running) render(); } };
    if(reg.waiting) mark(reg.waiting);
    reg.addEventListener("updatefound",()=>{ const w=reg.installing; if(w) w.addEventListener("statechange",()=>{ if(w.state==="installed") mark(w); }); });
    setInterval(()=>reg.update().catch(()=>{}),60*60*1000);
  }).catch(e=>console.warn("SW",e));
  navigator.serviceWorker.addEventListener("controllerchange",()=>{ if(reloading) location.reload(); });
}

/* ---------- indítás ---------- */
(async()=>{
  try{ await withTimeout(idb(),6000); S.books=(await withTimeout(getAllBooks(),8000)).map(fixBook); }
  catch(e){ console.warn(e); S.storageOk=false; idbBroken=true; S.books=[]; }
  render();
})();
