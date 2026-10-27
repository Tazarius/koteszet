/* Kötészet – képjavítás a feltöltött oldalfotókon: lapkeresés, perspektíva-javítás,
   papírfehérítés, homály- és csillogásjelzés. Csak canvas, külső könyvtár nélkül. */
"use strict";
(function(G){
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
function canvasOf(w,h){ const c=document.createElement("canvas"); c.width=w; c.height=h; return c; }
function ctx2d(c){ return c.getContext("2d",{willReadFrequently:true}); }
function drawScaled(src,max){ const sw=src.width, sh=src.height, k=Math.min(1,max/Math.max(sw,sh));
  const c=canvasOf(Math.max(1,Math.round(sw*k)),Math.max(1,Math.round(sh*k))); ctx2d(c).drawImage(src,0,0,c.width,c.height); return {c,k}; }
function grayOf(img){ const d=img.data, g=new Float32Array(img.width*img.height);
  for(let i=0,j=0;i<d.length;i+=4,j++) g[j]=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]; return g; }
function boxBlur(a,w,h,r){ const t=new Float32Array(a.length), o=new Float32Array(a.length);
  for(let y=0;y<h;y++){ let s=0,n=0; for(let x=-r;x<w+r;x++){ if(x+r<w&&x+r>=0){s+=a[y*w+x+r];n++;} if(x-r-1>=0){s-=a[y*w+x-r-1];n--;} if(x>=0&&x<w) t[y*w+x]=s/n; } }
  for(let x=0;x<w;x++){ let s=0,n=0; for(let y=-r;y<h+r;y++){ if(y+r<h&&y+r>=0){s+=t[(y+r)*w+x];n++;} if(y-r-1>=0){s-=t[(y-r-1)*w+x];n--;} if(y>=0&&y<h) o[y*w+x]=s/n; } }
  return o; }
function otsu(vals){ const hist=new Float64Array(256); let n=0; for(const v of vals){ hist[clamp(v|0,0,255)]++; n++; }
  let sum=0; for(let i=0;i<256;i++) sum+=i*hist[i]; let sB=0,wB=0,best=0,thr=0;
  for(let t=0;t<256;t++){ wB+=hist[t]; if(!wB) continue; const wF=n-wB; if(!wF) break; sB+=t*hist[t];
    const mB=sB/wB, mF=(sum-sB)/wF, v=wB*wF*(mB-mF)*(mB-mF); if(v>best){best=v;thr=t;} } return thr; }
const median=a=>{ const s=Array.from(a).sort((x,y)=>x-y); return s[s.length>>1]||0; };

/* A lap négy sarka a fotón (bal-fent, jobb-fent, jobb-lent, bal-lent), 0..1 arányban.
   A háttér a kép szélén lévő szín; a lap a középpontot tartalmazó, attól eltérő nagy folt. */
function findPage(src,dbg){ const {c}=drawScaled(src,360), w=c.width, h=c.height;
  const img=ctx2d(c).getImageData(0,0,w,h), d=img.data;
  const ch=[0,1,2].map(k=>{ const a=new Float32Array(w*h); for(let i=0;i<w*h;i++) a[i]=d[i*4+k]; return boxBlur(a,w,h,3); });
  // háttérszín: a képszél pixelei közül az a csoport, amelyik távolabb esik a kép közepének színétől
  // (ha a lap kilóg a képből, a szél egy része papír)
  const band=Math.max(2,Math.round(Math.min(w,h)*0.03)), edge=[], mid=[[],[],[]];
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const i=y*w+x;
    if(x<band||y<band||x>=w-band||y>=h-band) edge.push(i);
    else if(x>w*0.3&&x<w*0.7&&y>h*0.3&&y<h*0.7) for(let k=0;k<3;k++) mid[k].push(ch[k][i]); }
  const cm=mid.map(median), col=i=>[ch[0][i],ch[1][i],ch[2][i]], dd=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
  let c1=col(edge[0]), c2=cm.slice();
  for(let it=0;it<6;it++){ const s1=[0,0,0,0], s2=[0,0,0,0];
    for(const i of edge){ const p=col(i), t=dd(p,c1)<=dd(p,c2)?s1:s2; t[0]+=p[0]; t[1]+=p[1]; t[2]+=p[2]; t[3]++; }
    if(s1[3]) c1=[s1[0]/s1[3],s1[1]/s1[3],s1[2]/s1[3]]; if(s2[3]) c2=[s2[0]/s2[3],s2[1]/s2[3],s2[2]/s2[3]]; }
  const n1=edge.filter(i=>dd(col(i),c1)<=dd(col(i),c2)).length;
  const bg=(n1>edge.length*0.15&&dd(c1,cm)>=dd(c2,cm))||n1>edge.length*0.85?c1:c2;
  const dist=new Float32Array(w*h); for(let i=0;i<w*h;i++){ const a=ch[0][i]-bg[0], b=ch[1][i]-bg[1], e=ch[2][i]-bg[2]; dist[i]=Math.min(255,Math.sqrt(a*a+b*b+e*e)); }
  const thr=Math.max(18,otsu(dist)*0.8);
  let m=new Uint8Array(w*h); for(let i=0;i<w*h;i++) m[i]=dist[i]>thr?1:0;
  // a kép szélétől induló sötét sáv (a könyv fekete táblája, árnyék) nem a lap része
  const lum=i=>0.3*ch[0][i]+0.59*ch[1][i]+0.11*ch[2][i], paperL=Math.max(lum(0),0.3*cm[0]+0.59*cm[1]+0.11*cm[2]);
  const darkLim=Math.min(0.55*paperL,0.8*(0.3*bg[0]+0.59*bg[1]+0.11*bg[2]));
  const seen=new Uint8Array(w*h), fs=[];
  for(const i of edge) if(lum(i)<darkLim&&!seen[i]){ seen[i]=1; fs.push(i); }
  while(fs.length){ const q=fs.pop(); m[q]=0; const x=q%w, y=(q/w)|0;
    for(const r of [x>0?q-1:-1,x<w-1?q+1:-1,y>0?q-w:-1,y<h-1?q+w:-1]) if(r>=0&&!seen[r]&&lum(r)<darkLim){ seen[r]=1; fs.push(r); } }
  // a középponthoz legközelebbi nagy foltot választjuk
  const lab=new Int32Array(w*h).fill(-1), comps=[]; const st=[];
  for(let i=0;i<w*h;i++){ if(!m[i]||lab[i]>=0) continue; const id=comps.length; let n=0,sx=0,sy=0; lab[i]=id; st.push(i);
    while(st.length){ const q=st.pop(), x=q%w, y=(q/w)|0; n++; sx+=x; sy+=y;
      if(x>0&&m[q-1]&&lab[q-1]<0){lab[q-1]=id;st.push(q-1);} if(x<w-1&&m[q+1]&&lab[q+1]<0){lab[q+1]=id;st.push(q+1);}
      if(y>0&&m[q-w]&&lab[q-w]<0){lab[q-w]=id;st.push(q-w);} if(y<h-1&&m[q+w]&&lab[q+w]<0){lab[q+w]=id;st.push(q+w);} }
    comps.push({id,n,cx:sx/n,cy:sy/n}); }
  if(!comps.length) return null;
  const score=o=>o.n*(1-0.8*Math.hypot(o.cx/w-0.5,o.cy/h-0.5));
  const best=comps.reduce((a,b)=>score(b)>score(a)?b:a);
  if(dbg){ dbg.w=w; dbg.h=h; dbg.lab=lab; dbg.best=best.id; dbg.bg=bg; dbg.thr=thr; dbg.dist=dist; }
  if(best.n<w*h*0.15) return null;   // nincs elég nagy lap: nem nyúlunk hozzá
  // a folt négy oldalára egyenest illesztünk (soronként a bal/jobb, oszloponként a felső/alsó szélpont),
  // a kiugrókat (sarkok, a gerinc, a kép széle) elhagyva; a sarkok az egyenesek metszéspontjai
  const L=[],R=[],T=[],B=[]; const minX=new Int32Array(h).fill(-1), maxX=new Int32Array(h).fill(-1), minY=new Int32Array(w).fill(-1), maxY=new Int32Array(w).fill(-1);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){ if(lab[y*w+x]!==best.id) continue;
    if(minX[y]<0) minX[y]=x; maxX[y]=x; if(minY[x]<0) minY[x]=y; maxY[x]=y; }
  for(let y=0;y<h;y++) if(minX[y]>=0){ L.push([y,minX[y]]); R.push([y,maxX[y]]); }
  for(let x=0;x<w;x++) if(minY[x]>=0){ T.push([x,minY[x]]); B.push([x,maxY[x]]); }
  const fit=pts=>{ // v = a*t + b, robusztusan: középső 70%, majd a kiugrók elhagyása
    if(pts.length<6) return null; const n=pts.length; let P=pts.slice(Math.floor(n*0.15),Math.ceil(n*0.85)); let a=0,b=0;
    for(let it=0;it<4;it++){ const m=P.length; if(m<4) break; let st=0,sv=0,stt=0,stv=0; for(const [t,v] of P){ st+=t; sv+=v; stt+=t*t; stv+=t*v; }
      const den=m*stt-st*st; a=den?(m*stv-st*sv)/den:0; b=(sv-a*st)/m;
      const res=P.map(([t,v])=>Math.abs(v-(a*t+b))); const lim=Math.max(1.5,median(res)*2.5); P=P.filter((p,i)=>res[i]<=lim); }
    return [a,b]; };
  // az egyenest kifelé toljuk, hogy a lap ívelt széle (a gerinc felé) se vágódjon le
  const outer=(pts,f,side)=>{ if(!f) return null; const n=pts.length, P=pts.slice(Math.floor(n*0.05),Math.ceil(n*0.95));
    const r=P.map(([t,v])=>v-(f[0]*t+f[1])).sort((x,y)=>x-y); const q=side<0?r[Math.floor(r.length*0.04)]:r[Math.floor(r.length*0.96)];
    const lim=0.03*(side<0||side>0?Math.max(w,h):0); return [f[0],f[1]+clamp(q,-lim,lim)]; };
  const fl=outer(L,fit(L),-1), fr=outer(R,fit(R),1), ft=outer(T,fit(T),-1), fb=outer(B,fit(B),1); if(!fl||!fr||!ft||!fb) return null;
  // x = al*y + bl  és  y = at*x + bt metszése
  const cross=([ax,bx],[ay,by])=>{ const y=(ay*bx+by)/(1-ay*ax); return [ax*y+bx,y]; };
  let q=[cross(fl,ft),cross(fr,ft),cross(fr,fb),cross(fl,fb)].map(([x,y])=>[clamp(x/w,0,1),clamp(y/h,0,1)]);
  // józansági próba: a lap egy enyhén torzult téglalap; ha nagyon nem az, a folt befoglaló téglalapja marad
  if(!plausible(q,w/h)){ let x0=w,x1=0,y0=h,y1=0; for(let y=0;y<h;y++) if(minX[y]>=0){ y0=Math.min(y0,y); y1=Math.max(y1,y); x0=Math.min(x0,minX[y]); x1=Math.max(x1,maxX[y]); }
    q=[[x0/w,y0/h],[x1/w,y0/h],[x1/w,y1/h],[x0/w,y1/h]]; }
  const area=Math.abs(polyArea(q));
  if(area<0.15||area>0.97) return null;   // túl kicsi: gyanús; szinte az egész kép: nincs mit levágni
  return q; }
function plausible(q,aspect){ const P=q.map(([x,y])=>[x*aspect,y]);
  for(let i=0;i<4;i++){ const a=P[(i+3)%4], b=P[i], c=P[(i+1)%4]; const u=[a[0]-b[0],a[1]-b[1]], v=[c[0]-b[0],c[1]-b[1]];
    const cos=(u[0]*v[0]+u[1]*v[1])/(Math.hypot(...u)*Math.hypot(...v)||1); if(Math.abs(cos)>Math.sin(12*Math.PI/180)) return false; }
  const len=(i,j)=>Math.hypot(P[i][0]-P[j][0],P[i][1]-P[j][1]);
  const r1=len(0,1)/len(3,2), r2=len(0,3)/len(1,2); return r1>0.87&&r1<1.15&&r2>0.87&&r2<1.15; }
function polyArea(q){ let s=0; for(let i=0;i<4;i++){ const [x1,y1]=q[i], [x2,y2]=q[(i+1)%4]; s+=x1*y2-x2*y1; } return s/2; }

/* Perspektíva: homográfia a cél téglalapról a forrás négyszögre */
function homography(src,dst){ // dst[i] → src[i]
  const A=[], b=[];
  for(let i=0;i<4;i++){ const [x,y]=dst[i], [u,v]=src[i];
    A.push([x,y,1,0,0,0,-u*x,-u*y]); b.push(u); A.push([0,0,0,x,y,1,-v*x,-v*y]); b.push(v); }
  for(let i=0;i<8;i++){ let p=i; for(let r=i+1;r<8;r++) if(Math.abs(A[r][i])>Math.abs(A[p][i])) p=r;
    [A[i],A[p]]=[A[p],A[i]]; [b[i],b[p]]=[b[p],b[i]];
    for(let r=0;r<8;r++){ if(r===i) continue; const f=A[r][i]/A[i][i]; for(let k=i;k<8;k++) A[r][k]-=f*A[i][k]; b[r]-=f*b[i]; } }
  const h=b.map((v,i)=>v/A[i][i]); h.push(1); return h; }
function warp(src,quad,maxSide){ const W=src.width, H=src.height; const P=quad.map(([x,y])=>[x*W,y*H]);
  const len=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  let ow=(len(P[0],P[1])+len(P[3],P[2]))/2, oh=(len(P[0],P[3])+len(P[1],P[2]))/2;
  const k=Math.min(1,(maxSide||2400)/Math.max(ow,oh)); ow=Math.round(ow*k); oh=Math.round(oh*k);
  const Hm=homography(P,[[0,0],[ow,0],[ow,oh],[0,oh]]);
  const sd=ctx2d(src).getImageData(0,0,W,H).data, out=canvasOf(ow,oh), oc=ctx2d(out), oi=oc.createImageData(ow,oh), od=oi.data;
  for(let y=0;y<oh;y++){ for(let x=0;x<ow;x++){ const z=Hm[6]*x+Hm[7]*y+1, u=(Hm[0]*x+Hm[1]*y+Hm[2])/z, v=(Hm[3]*x+Hm[4]*y+Hm[5])/z;
      const x0=clamp(Math.floor(u),0,W-2), y0=clamp(Math.floor(v),0,H-2), fx=clamp(u-x0,0,1), fy=clamp(v-y0,0,1);
      const i00=(y0*W+x0)*4, i10=i00+4, i01=i00+W*4, i11=i01+4, o=(y*ow+x)*4;
      for(let c=0;c<3;c++) od[o+c]=(sd[i00+c]*(1-fx)+sd[i10+c]*fx)*(1-fy)+(sd[i01+c]*(1-fx)+sd[i11+c]*fx)*fy;
      od[o+3]=255; } }
  oc.putImageData(oi,0,0); return out; }

/* Papírfehérítés: a megvilágítás egyenetlenségét kiegyenlíti (a papír „fényességtérképe” alapján),
   majd a papírt közel fehérre, a festéket sötétebbre húzza. A színek megmaradnak. */
function whiten(c){ const w=c.width, h=c.height, x=ctx2d(c), im=x.getImageData(0,0,w,h), d=im.data;
  const S=16, bw=Math.ceil(w/S), bh=Math.ceil(h/S), g=grayOf(im);
  // blokkonként a világos (papír) szint: a blokk 90. percentilise
  const bgs=new Float32Array(bw*bh);
  for(let by=0;by<bh;by++) for(let bx=0;bx<bw;bx++){ const v=[];
    for(let y=by*S;y<Math.min(h,by*S+S);y+=2) for(let xx=bx*S;xx<Math.min(w,bx*S+S);xx+=2) v.push(g[y*w+xx]);
    v.sort((a,b)=>a-b); bgs[by*bw+bx]=v[Math.floor(v.length*0.9)]||255; }
  const paper=median(bgs);
  // a sötét (rajz, fekete borító) blokkok nem húzhatják le a térképet: helyettük a papírszint
  for(let i=0;i<bgs.length;i++) if(bgs[i]<paper*0.75) bgs[i]=paper;
  const sm=boxBlur(boxBlur(bgs,bw,bh,2),bw,bh,2);
  const T=248;
  // fekete pont: a sötét pixelek alsó része
  const hs=new Uint32Array(256); for(let i=0;i<g.length;i+=3) hs[clamp(g[i]|0,0,255)]++;
  let acc=0, black=0; const tot=Math.ceil(g.length/3); for(;black<255;black++){ acc+=hs[black]; if(acc>tot*0.005) break; }
  black=Math.min(black,90);
  for(let y=0;y<h;y++){ const fy=clamp((y+0.5)/S-0.5,0,bh-1), y0=Math.floor(fy), y1=Math.min(bh-1,y0+1), ty=fy-y0;
    for(let xx=0;xx<w;xx++){ const fx=clamp((xx+0.5)/S-0.5,0,bw-1), x0=Math.floor(fx), x1=Math.min(bw-1,x0+1), tx=fx-x0;
      const bg=(sm[y0*bw+x0]*(1-tx)+sm[y0*bw+x1]*tx)*(1-ty)+(sm[y1*bw+x0]*(1-tx)+sm[y1*bw+x1]*tx)*ty;
      const gain=clamp(paper/Math.max(1,bg),0.85,1.5), o=(y*w+xx)*4;
      for(let k=0;k<3;k++){ let v=d[o+k]*gain; v=(v-black)*T/Math.max(1,paper-black); d[o+k]=clamp(v,0,255); } } }
  x.putImageData(im,0,0); return c; }

/* Élesség: a legerősebb élek átlagos Laplace-értéke (szövegnél a betűszélek) ~1000 px szélesen */
function sharpness(src){ const {c}=drawScaled(src,1000), w=c.width, h=c.height, g=grayOf(ctx2d(c).getImageData(0,0,w,h)), v=[];
  for(let y=1;y<h-1;y+=1) for(let x=1;x<w-1;x+=1){ const i=y*w+x; v.push(Math.abs(4*g[i]-g[i-1]-g[i+1]-g[i-w]-g[i+w])); }
  v.sort((a,b)=>b-a); const top=v.slice(0,Math.max(1,Math.floor(v.length*0.01))); return top.reduce((s,a)=>s+a,0)/top.length; }
/* Csillogás: a lapon belüli kiégett (szinte tiszta fehér) foltok aránya, a javítás ELŐTTI képen */
function glare(src,quad){ const {c}=drawScaled(src,500), w=c.width, h=c.height, d=ctx2d(c).getImageData(0,0,w,h).data;
  const [qx0,qy0,qx1,qy1]=quad?[Math.max(quad[0][0],quad[3][0]),Math.max(quad[0][1],quad[1][1]),Math.min(quad[1][0],quad[2][0]),Math.min(quad[2][1],quad[3][1])]:[0.05,0.05,0.95,0.95];
  let n=0,hot=0; for(let y=Math.floor(qy0*h);y<qy1*h;y++) for(let x=Math.floor(qx0*w);x<qx1*w;x++){ const i=(y*w+x)*4; n++; if(d[i]>=250&&d[i+1]>=250&&d[i+2]>=250) hot++; }
  return n?hot/n:0; }

/* Teljes javítás egy (már dekódolt) képre. quad: kézi sarkok, vagy null → automatikus. */
function enhance(bmp,opts={}){ const src=canvasOf(bmp.width,bmp.height); ctx2d(src).drawImage(bmp,0,0);
  const quad=opts.quad!==undefined?opts.quad:findPage(src);
  const gl=glare(src,quad);
  let out=quad?warp(src,quad,opts.maxSide||2400):src;
  if(opts.whiten!==false) whiten(out);
  const sharp=sharpness(out);
  return {canvas:out,quad,sharp,glare:gl}; }

const api={findPage,warp,whiten,sharpness,glare,enhance,homography};
Object.assign(G,{KImage:api});
})(typeof globalThis!=="undefined"?globalThis:this);
