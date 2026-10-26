/* Kötészet – a kiolvasott szöveg tisztítása.
   Böngészőben globális függvények, Node-ban (teszteléshez) module.exports. */
"use strict";
(function(G){
const LETTER=/\p{L}/u;
const DASH=/^[-–—]+$/;
const ONE_LETTER=/^[aAsSéÉ]$/;
const NUM=/^[(\[]?\d[\d.,:;/–-]*[)\].,;:]?$/;

/* Szó jellegű-e: többségében betű, legfeljebb a végén/elején írásjel. */
function wordlike(t){ const core=t.replace(/^[„"'(«»\[]+|[.,;:!?…"”'»)\]-]+$/g,"");
  if(!core) return false;
  if(core.length===1) return ONE_LETTER.test(core);
  let L=0; for(const ch of core) if(LETTER.test(ch)) L++;
  if(L/core.length<0.8) return false;
  if(/\p{Ll}\p{Lu}/u.test(core)&&!/-/.test(core)) return false; // „TáK”, „kÁCA”: kevert kis- és nagybetű
  return true; }

const median=a=>{ if(!a.length) return 0; const s=a.slice().sort((x,y)=>x-y); return s[s.length>>1]; };

/* Tesseract eredményéből (blocks) a valódi szövegsorok: a minta és a képek „kiolvasott” szemetét kiszűri.
   Vissza: {text, lines:[{t,x0,y0,x1,y1}], conf, words} */
function cleanOcr(data,opt={}){ const STRONG=opt.strong??75, WEAK=opt.weak??30;
  const raw=[];
  for(const bl of data.blocks||[]) for(const pa of bl.paragraphs||[]) for(const ln of pa.lines||[]){
    const ws=(ln.words||[]).filter(w=>(w.text||w.t||"").trim()).map(w=>({t:(w.text??w.t).trim(),c:w.confidence??w.c,b:w.bbox??w.b}));
    if(ws.length) raw.push(ws); }
  const out=[];
  for(const ws of raw){
    const strong=ws.map(w=>w.c>=STRONG&&wordlike(w.t));
    // a sort vízszintes hézagoknál szakaszokra bontjuk (szöveg a kép mellett)
    const hts=ws.filter((w,i)=>strong[i]).map(w=>w.b.y1-w.b.y0).filter(h=>h>0); const lh=median(hts)||median(ws.map(w=>w.b.y1-w.b.y0))||20;
    const groups=[]; let g=[0];
    for(let i=1;i<ws.length;i++){ if(ws[i].b.x0-ws[i-1].b.x1>2.2*lh){ groups.push(g); g=[]; } g.push(i); } groups.push(g);
    for(const gr of groups){
      const si=gr.filter(i=>strong[i]); if(!si.length) continue;
      let a=si[0], z=si[si.length-1];
      // a szakaszon belül is többségben legyenek a jó szavak
      const span=gr.filter(i=>i>=a&&i<=z); const good=span.filter(i=>strong[i]).length;
      const letters=si.reduce((s,i)=>s+ws[i].t.length,0);
      if(good/span.length<0.6) continue;
      if(si.length===1&&letters<4) continue;           // magányos rövid „szó” a mintából
      // a szakasz szélén: gyengébb, de szó jellegű szomszéd szóközön belül; gondolatjel csak szorosan a szó előtt/után,
      // egyetlen jelként (a felismerés ezeknél bizonytalan, a minta vonalai pedig „——”-nek látszanak)
      const gapL=i=>ws[i+1].b.x0-ws[i].b.x1, isD=i=>/^[-–—]$/.test(ws[i].t)&&ws[i].b.y1-ws[i].b.y0<0.45*lh;
      const sgaps=[]; for(let i=a;i<z;i++) if(strong[i]&&strong[i+1]) sgaps.push(gapL(i));
      const sp=Math.max(median(sgaps)||0.6*lh,0.4*lh);  // szóköz szélessége ebben a sorban
      // szám csak biztos felismeréssel; egyjegyű csak másik szám mellett (a mintából sok „4”, „1” jön)
      const isN=i=>i>=0&&i<ws.length&&NUM.test(ws[i].t)&&ws[i].c>=85;
      const fits=(i,inner)=>wordlike(ws[i].t)?ws[i].c>=WEAK:isN(i)&&(ws[i].t.replace(/\D/g,"").length>1||isN(inner));
      const okL=i=>isD(i)?gapL(i)<1.3*sp:(fits(i,i+1)&&gapL(i)<1.6*sp);
      const okR=i=>isD(i)?gapL(i-1)<1.3*sp:(fits(i,i-1)&&gapL(i-1)<1.6*sp);
      while(a>gr[0]&&okL(a-1)&&!(isD(a)&&DASH.test(ws[a-1].t))) a--;
      while(z<gr[gr.length-1]&&okR(z+1)&&!(isD(z)&&DASH.test(ws[z+1].t))) z++;
      const keep=ws.slice(a,z+1);
      if(si.length<3&&keep.length<gr.length*0.5) continue; // pár jó szó sok szemét között
      out.push({ws:keep,x0:Math.min(...keep.map(w=>w.b.x0)),x1:Math.max(...keep.map(w=>w.b.x1)),
        y0:Math.min(...keep.map(w=>w.b.y0)),y1:Math.max(...keep.map(w=>w.b.y1))}); } }
  const segs=dropCaptions(out.map(l=>Object.assign(l,{t:l.ws.map(w=>w.t).join(" "),n:l.ws.length})));
  const rows=mergeRows(segs);
  const lines=rows.map(l=>({t:l.ws.map(w=>w.t).join(" "),x0:l.x0,y0:l.y0,x1:l.x1,y1:l.y1,n:l.ws.length}));
  const kept=rows.flatMap(r=>r.ws), words=kept.length;
  const conf=words?Math.round(kept.reduce((t,w)=>t+w.c,0)/words):0;
  // csupa nagybetűs feliratok (képaláírások, tábla) → valószínűleg képes oldal
  const caps=lines.length>0&&lines.every(l=>{ const L=l.t.replace(/[^\p{L}]/gu,""); return L===L.toUpperCase(); });
  // sok töredéksor: rossz fotó vagy kép melletti szöveg, érdemes átnézni
  const frag=lines.length>=6&&lines.filter(l=>l.n<=2).length/lines.length>0.35;
  return {text:paragraphText(lines),lines:lines.map(({t,x0,y0,x1,y1})=>({t,x0,y0,x1,y1})),conf,words,caps,frag}; }

/* A Tesseract egy nyomtatott sort néha több darabban (vagy kétszer) ad vissza: az egy magasságban álló
   darabokat sorrá fűzzük, az egymást takaró szavak közül a biztosabbat tartjuk meg. */
function mergeRows(segs){ const rows=[];
  for(const s of segs.slice().sort((p,q)=>(p.y0+p.y1)/2-(q.y0+q.y1)/2)){ const yc=(s.y0+s.y1)/2, h=s.y1-s.y0;
    // csak ha a két darab fedi egymást, vagy szorosan egymás mellett áll (ferde fotónál a szomszéd sorok is közel esnek)
    const r=rows.find(r=>{ const rh=r.y1-r.y0, dy=Math.abs((r.y0+r.y1)/2-yc); if(dy>0.35*Math.min(h,rh)) return false;
      const gap=Math.max(s.x0-r.x1,r.x0-s.x1); return gap<2.5*Math.min(h,rh); });
    if(r){ r.parts.push(s); r.x0=Math.min(r.x0,s.x0); r.x1=Math.max(r.x1,s.x1); } else rows.push({y0:s.y0,y1:s.y1,x0:s.x0,x1:s.x1,parts:[s]}); }
  return rows.map(r=>{ let ws=r.parts.flatMap((p,k)=>p.ws.map(w=>Object.assign(w,{part:k}))).sort((a,b)=>a.b.x0-b.b.x0); const keep=[];
    for(const w of ws){ const prev=keep[keep.length-1];
      const ov=prev?Math.min(w.b.x1,prev.b.x1)-Math.max(w.b.x0,prev.b.x0):0;
      if(prev&&prev.part!==w.part&&ov>0.5*Math.min(w.b.x1-w.b.x0,prev.b.x1-prev.b.x0)){ const sc=x=>(wordlike(x.t)?100:0)+x.c; if(sc(w)>sc(prev)) keep[keep.length-1]=w; continue; }
      keep.push(w); }
    return {ws:keep,x0:Math.min(...keep.map(w=>w.b.x0)),x1:Math.max(...keep.map(w=>w.b.x1)),y0:Math.min(...keep.map(w=>w.b.y0)),y1:Math.max(...keep.map(w=>w.b.y1))}; })
    .sort((p,q)=>(p.y0+p.y1)-(q.y0+q.y1)||p.x0-q.x0); }

/* Képaláírás: rövid, csupa nagybetűs sor a szövegoszlopon kívül vagy annak szélén (pl. „HÁZI ZUGPÓK”).
   A szövegoszlop közepére igazított nagybetűs sor (fejezetcím) megmarad. */
function dropCaptions(lines){ const body=lines.filter(l=>l.n>=4); if(body.length<3) return lines;
  const left=median(body.map(l=>l.x0)), right=median(body.map(l=>l.x1)), mid=(left+right)/2, w=right-left;
  return lines.filter(l=>{ const letters=l.t.replace(/[^\p{L}]/gu,""); if(l.n>4||letters.length<3||letters!==letters.toUpperCase()) return true;
    return Math.abs((l.x0+l.x1)/2-mid)<0.12*w; }); }

/* Bekezdéshatár: behúzás, mondatvégű rövid sor, nagy sorköz vagy párbeszéd. */
function paragraphText(lines){ if(!lines.length) return "";
  const body=lines.filter(l=>l.n>=4); const ref=body.length?body:lines;
  const lh=median(ref.map(l=>l.y1-l.y0))||20;
  const left=median(ref.map(l=>l.x0)), right=median(ref.map(l=>l.x1)), width=right-left;
  const gaps=[]; for(let i=1;i<lines.length;i++) gaps.push(lines[i].y0-lines[i-1].y1);
  const gap=median(gaps.filter(g=>g>0))||lh*0.4;
  let s=lines[0].t;
  for(let i=1;i<lines.length;i++){ const p=lines[i-1], l=lines[i];
    const indent=l.x0-left>0.9*lh&&l.x0-left<6*lh;
    const shortEnd=/[.!?…:]["”»)]?$/.test(p.t)&&(p.x1<right-2.5*lh||width<=0);
    const bigGap=l.y0-p.y1>Math.max(gap*1.9,lh*0.9);
    const dialog=/^[-–—]/.test(l.t)&&/[.!?…:]["”»)]?$/.test(p.t);
    s+=(indent||shortEnd||bigGap||dialog)?"\n\n":"\n"; s+=l.t; }
  return s; }

/* Párbeszédjel: sor eleji vagy szóközök közti kötőjel → nagykötőjel */
function fixDashes(s){ s=s.replace(/—/g,"–").replace(/(^|\n)[ \t]*(?:[-–][ \t]*){2,}(?=\S)/g,"$1– ");
  return s.replace(/(^|\n)[ \t]*-(?:[ \t]+|(?=\p{Lu}))/gu,"$1– ").replace(/ -(?=\s|[,.;:!?])/g," –"); }

/* Élőfej, élőláb: az oldalak első/utolsó sorai közül azok, amelyek sok oldalon ismétlődnek. */
const normLine=t=>t.toLowerCase().replace(/\s+([0-9]+|[ivxlc]+\.?)\s*$/,"").replace(/^\s*[0-9]+/,"").replace(/[^a-zà-žőű ]/g,"").replace(/\s+/g," ").trim();
function repeatedLines(texts){ const cnt=new Map(); let n=0;
  for(const t of texts){ const ls=t.split("\n").map(x=>x.trim()).filter(Boolean); if(ls.length<3) continue; n++;
    const seen=new Set(); for(const l of [ls[0],ls[1],ls[ls.length-1]]){ const k=normLine(l); if(k.length<3||seen.has(k)) continue; seen.add(k); cnt.set(k,(cnt.get(k)||0)+1); } }
  const out=new Set(); for(const [k,c] of cnt) if(c>=3&&c>=n*0.25) out.add(k); return out; }
function dropRepeated(t,rep){ if(!rep.size) return t; const ls=t.split("\n"); const idx=ls.map((l,i)=>[l,i]).filter(([l])=>l.trim());
  const kill=new Set(); const cand=[idx[0],idx[1],idx[idx.length-1]].filter(Boolean);
  for(const [l,i] of cand) if(rep.has(normLine(l))) kill.add(i);
  return ls.filter((_,i)=>!kill.has(i)).join("\n").replace(/^\s*\n+/,""); }

const api={cleanOcr,paragraphText,fixDashes,repeatedLines,dropRepeated,wordlike};
if(typeof module!=="undefined"&&module.exports) module.exports=api; else Object.assign(G,api);
})(typeof globalThis!=="undefined"?globalThis:this);
