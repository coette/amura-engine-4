import { FilesetResolver, HandLandmarker } from "./vendor/mediapipe/vision_bundle.mjs";

const WIDTH = 360;
const SLICE_FRACTIONS = [0.18, 0.32, 0.46, 0.60, 0.74];
const SECTION_COUNT = 7;
let landmarker = null;
let landmarkerPromise = null;

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function median(v){if(!v.length)return 0;const s=v.slice().sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])*0.5;}
function quantile(v,q){if(!v.length)return 0;const s=v.slice().sort((a,b)=>a-b),i=clamp(q,0,1)*(s.length-1),a=Math.floor(i),b=Math.ceil(i);if(a===b)return s[a];const t=i-a;return s[a]*(1-t)+s[b]*t;}
function robust(v,floor){const c=median(v),d=v.map(x=>Math.abs(x-c));return{center:c,sigma:Math.max(floor,median(d)*1.4826)};}
function ycbcr(r,g,b){return{y:.299*r+.587*g+.114*b,cb:128-.168736*r-.331264*g+.5*b,cr:128+.5*r-.418688*g-.081312*b};}
function modelFrom(ys,cbs,crs,f={}){if(ys.length<60)return null;return{y:robust(ys,f.y||14),cb:robust(cbs,f.cb||5),cr:robust(crs,f.cr||5)};}
function skin(r,g,b,m,loose=false){const c=ycbcr(r,g,b);if(c.y<14||c.y>250)return false;const cb=(c.cb-m.cb.center)/m.cb.sigma,cr=(c.cr-m.cr.center)/m.cr.sigma,y=(c.y-m.y.center)/m.y.sigma;return cb*cb+cr*cr<=(loose?13.5:10.5)&&Math.abs(y)<=(loose?5:4.2);}
function fitAxis(points,preferred){if(!points||points.length<2)return null;const mean={x:points.reduce((s,p)=>s+p.x,0)/points.length,y:points.reduce((s,p)=>s+p.y,0)/points.length};let xx=0,xy=0,yy=0;for(const p of points){const dx=p.x-mean.x,dy=p.y-mean.y;xx+=dx*dx;xy+=dx*dy;yy+=dy*dy;}const a=.5*Math.atan2(2*xy,xx-yy);let d={x:Math.cos(a),y:Math.sin(a)};if(preferred&&d.x*preferred.x+d.y*preferred.y<0)d={x:-d.x,y:-d.y};return{mean,direction:d};}
function angle(d){return d?Math.atan2(d.y,d.x)*180/Math.PI:null;}
function local(x,y,g){const dx=x-g.origin.x,dy=y-g.origin.y;return{t:dx*g.elbow.x+dy*g.elbow.y,u:dx*g.perpendicular.x+dy*g.perpendicular.y};}
function point(g,t,u=0){return{x:g.origin.x+g.elbow.x*t+g.perpendicular.x*u,y:g.origin.y+g.elbow.y*t+g.perpendicular.y*u};}

async function imageLandmarker(){
  if(landmarker)return landmarker;
  if(landmarkerPromise)return landmarkerPromise;
  landmarkerPromise=(async()=>{
    const files=await FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm");
    const opts=delegate=>({baseOptions:{modelAssetPath:"./models/hand_landmarker.task",delegate},runningMode:"IMAGE",numHands:1,minHandDetectionConfidence:.5,minHandPresenceConfidence:.5,minTrackingConfidence:.5});
    try{landmarker=await HandLandmarker.createFromOptions(files,opts("GPU"));}
    catch(e){console.warn("R14 IMAGE GPU no disponible; CPU",e);landmarker=await HandLandmarker.createFromOptions(files,opts("CPU"));}
    return landmarker;
  })().catch(e=>{landmarkerPromise=null;throw e;});
  return landmarkerPromise;
}

function provisionalModel(data,p0){const {width,height}=data,px=data.data,s=width,ys=[],cbs=[],crs=[];const x0=clamp(Math.round(p0.x-s*.11),0,width-1),x1=clamp(Math.round(p0.x-s*.018),0,width-1),y0=clamp(Math.round(p0.y-s*.052),0,height-1),y1=clamp(Math.round(p0.y+s*.052),0,height-1);for(let y=y0;y<=y1;y+=2)for(let x=x0;x<=x1;x+=2){const i=(y*width+x)*4,c=ycbcr(px[i],px[i+1],px[i+2]);if(c.y<18||c.y>245)continue;ys.push(c.y);cbs.push(c.cb);crs.push(c.cr);}return modelFrom(ys,cbs,crs,{y:18,cb:6.5,cr:6.5});}

function previewGeometry(data,p0){
  if(!p0)return null;const {width,height}=data,px=data.data,s=width,m=provisionalModel(data,p0);if(!m)return null;
  const distances=[.08,.17,.26,.35,.44,.53].map(f=>s*f),half=Math.max(4,Math.round(s*.022)),search=s*.19,sections=[];let predicted=p0.y;
  for(const distance of distances){const cx=p0.x-distance;if(cx<2||cx>=width-2)continue;const ys=[],x0=clamp(Math.round(cx-half),0,width-1),x1=clamp(Math.round(cx+half),0,width-1),y0=clamp(Math.round(predicted-search),0,height-1),y1=clamp(Math.round(predicted+search),0,height-1);for(let y=y0;y<=y1;y++){let hits=0,tested=0;for(let x=x0;x<=x1;x+=2){const i=(y*width+x)*4;tested++;if(skin(px[i],px[i+1],px[i+2],m,true))hits++;}if(tested&&hits/tested>=.42)ys.push(y+.5);}if(ys.length<s*.045)continue;const lo=quantile(ys,.06),hi=quantile(ys,.94),cy=median(ys);if(hi-lo<s*.055||hi-lo>s*.38)continue;sections.push({center:{x:cx,y:cy},width:hi-lo,distance});predicted=cy;}
  if(sections.length<3)return null;const ax=fitAxis(sections.map(s=>s.center),{x:-1,y:0});if(!ax||ax.direction.x>-.10)return null;const body=clamp(median(sections.map(s=>s.width*.5)),s*.055,s*.19),far=Math.max(...sections.map(s=>s.distance)),end=clamp(far+s*.055,s*.38,s*.62),elbow=ax.direction;
  return{origin:{x:p0.x,y:p0.y},elbow,perpendicular:{x:-elbow.y,y:elbow.x},roiStart:0,roiEnd:end,roiHalfWidth:body*1.35,seedStart:s*.08,seedEnd:Math.min(end*.60,s*.30),seedHalfWidth:body*.55};
}

function learnModel(data,g){const {width,height}=data,px=data.data,ys=[],cbs=[],crs=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++){const q=local(x+.5,y+.5,g);if(q.t<g.seedStart||q.t>g.seedEnd||Math.abs(q.u)>g.seedHalfWidth)continue;const i=(y*width+x)*4,c=ycbcr(px[i],px[i+1],px[i+2]);if(c.y<18||c.y>245)continue;ys.push(c.y);cbs.push(c.cb);crs.push(c.cr);}return modelFrom(ys,cbs,crs,{y:16,cb:5.5,cr:5.5});}

function segment(data,g,m,p0){const {width,height}=data,px=data.data,mask=new Uint8Array(width*height),points=[],half=g.roiHalfWidth*1.65,start=g.roiStart-g.roiEnd*.05,end=g.roiEnd*1.08,p0t=p0?local(p0.x,p0.y,g).t:null;for(let y=0;y<height;y++)for(let x=0;x<width;x++){const q=local(x+.5,y+.5,g);if(q.t<start||q.t>end||Math.abs(q.u)>half)continue;if(Number.isFinite(p0t)&&q.t<p0t)continue;const i=(y*width+x)*4;if(!skin(px[i],px[i+1],px[i+2],m,false))continue;mask[y*width+x]=1;points.push({x:x+.5,y:y+.5,t:q.t,u:q.u});}return{mask,points};}

function cloudPca(mask,width,height,g){const pts=[];for(let y=0;y<height;y+=2)for(let x=0;x<width;x+=2)if(mask[y*width+x])pts.push({x:x+.5,y:y+.5});if(pts.length<120)return{geometry:null,pixelCount:pts.length,angle:null};const ax=fitAxis(pts,g.elbow);if(!ax)return{geometry:null,pixelCount:pts.length,angle:null};const pr=pts.map(p=>(p.x-ax.mean.x)*ax.direction.x+(p.y-ax.mean.y)*ax.direction.y),a=quantile(pr,.03),b=quantile(pr,.97),span=b-a;if(!Number.isFinite(span)||span<36)return{geometry:null,pixelCount:pts.length,angle:null};return{geometry:{...g,origin:{x:ax.mean.x+ax.direction.x*a,y:ax.mean.y+ax.direction.y*a},elbow:ax.direction,perpendicular:{x:-ax.direction.y,y:ax.direction.x},roiStart:0,roiEnd:span},pixelCount:pts.length,angle:angle(ax.direction)};}

function sectionPca(mask,width,height,g){
  const pts=[];
  for(let y=0;y<height;y+=2)for(let x=0;x<width;x+=2){
    if(!mask[y*width+x])continue;
    const p={x:x+.5,y:y+.5};
    const q=local(p.x,p.y,g);
    pts.push({...p,t:q.t});
  }
  if(pts.length<120)return{geometry:null,pixelCount:pts.length,angle:null,centers:[]};
  const ts=pts.map(p=>p.t),lo=quantile(ts,.08),hi=quantile(ts,.92),spanT=hi-lo;
  if(!Number.isFinite(spanT)||spanT<36)return{geometry:null,pixelCount:pts.length,angle:null,centers:[]};
  const centers=[];
  for(let i=0;i<SECTION_COUNT;i++){
    const a=lo+spanT*i/SECTION_COUNT,b=lo+spanT*(i+1)/SECTION_COUNT;
    const bin=pts.filter(p=>p.t>=a&&(i===SECTION_COUNT-1?p.t<=b:p.t<b));
    if(bin.length<18)continue;
    centers.push({x:median(bin.map(p=>p.x)),y:median(bin.map(p=>p.y)),count:bin.length,index:i});
  }
  if(centers.length<5)return{geometry:null,pixelCount:pts.length,angle:null,centers};
  const ax=fitAxis(centers,g.elbow);
  if(!ax)return{geometry:null,pixelCount:pts.length,angle:null,centers};
  const pr=centers.map(p=>(p.x-ax.mean.x)*ax.direction.x+(p.y-ax.mean.y)*ax.direction.y),a=Math.min(...pr),b=Math.max(...pr),span=b-a;
  if(!Number.isFinite(span)||span<30)return{geometry:null,pixelCount:pts.length,angle:null,centers};
  return{
    geometry:{...g,origin:{x:ax.mean.x+ax.direction.x*a,y:ax.mean.y+ax.direction.y*a},elbow:ax.direction,perpendicular:{x:-ax.direction.y,y:ax.direction.x},roiStart:0,roiEnd:span},
    pixelCount:pts.length,
    angle:angle(ax.direction),
    centers
  };
}

function finalAxis(mask,width,height,g){const half=g.roiEnd*.065,buckets=SLICE_FRACTIONS.map(()=>({x:[],y:[]}));for(let y=0;y<height;y+=2)for(let x=0;x<width;x+=2){if(!mask[y*width+x])continue;const q=local(x+.5,y+.5,g);for(let i=0;i<SLICE_FRACTIONS.length;i++){if(Math.abs(q.t-g.roiEnd*SLICE_FRACTIONS[i])>half)continue;buckets[i].x.push(x+.5);buckets[i].y.push(y+.5);break;}}const centers=buckets.map((b,i)=>b.x.length<10?null:{x:median(b.x),y:median(b.y),fraction:SLICE_FRACTIONS[i]}).filter(Boolean);if(centers.length!==5)return{centers,metric:null};const good=centers.slice(1),ax=fitAxis(good,g.elbow);if(!ax)return{centers,metric:null};const pr=good.map(p=>(p.x-ax.mean.x)*ax.direction.x+(p.y-ax.mean.y)*ax.direction.y),lo=Math.min(...pr),hi=Math.max(...pr),start={x:ax.mean.x+ax.direction.x*lo,y:ax.mean.y+ax.direction.y*lo},end={x:ax.mean.x+ax.direction.x*hi,y:ax.mean.y+ax.direction.y*hi};return{centers,metric:{start,end,midpoint:{x:(start.x+end.x)/2,y:(start.y+end.y)/2},angle:angle(ax.direction)}};}

function fallbackP0(item){if(item.p0)return{x:item.p0[0],y:item.p0[1],source:"R12 guardado"};const r=item.live.roi*Math.PI/180,d={x:Math.cos(r),y:Math.sin(r)};return{x:item.finalMid[0]-d.x*75,y:item.finalMid[1]-d.y*75,source:"estimado R12"};}

export function analysisPoint(g,t,u=0){return point(g,t,u);}
export function directionAngle(d){return angle(d);}
export function axisErrorDegrees(a,b){if(!Number.isFinite(a)||!Number.isFinite(b))return null;const d=Math.abs(a-b)%180;return Math.min(d,180-d);}

export async function analyzeBankImage(image,item,tokenIsCurrent=()=>true){
  const canvas=document.createElement("canvas"),height=Math.max(1,Math.round(WIDTH*image.naturalHeight/image.naturalWidth));canvas.width=WIDTH;canvas.height=height;const ctx=canvas.getContext("2d",{willReadFrequently:true});ctx.drawImage(image,0,0,WIDTH,height);const clean=ctx.getImageData(0,0,WIDTH,height);
  let mp=null,mpError=null,p0=null,p0Source="";
  try{const lm=await imageLandmarker();if(!tokenIsCurrent())return null;mp=lm.detect(canvas);const wrist=mp?.landmarks?.[0]?.[0];if(wrist){p0={x:wrist.x*WIDTH,y:wrist.y*height};p0Source="MediaPipe IMAGE";}}catch(e){mpError=e;console.error("R14 IMAGE",e);}
  if(!tokenIsCurrent())return null;
  let geometry=p0?previewGeometry(clean,p0):null;
  if(!geometry){const fb=fallbackP0(item);p0={x:fb.x,y:fb.y};p0Source=fb.source;geometry=previewGeometry(clean,p0);}
  if(!geometry)throw new Error("No se ha podido inicializar el antebrazo");
  const model=learnModel(clean,geometry);if(!model)throw new Error("No se ha podido aprender la piel");
  const s=segment(clean,geometry,model,p0);
  const pca=cloudPca(s.mask,WIDTH,height,geometry);
  const sections=sectionPca(s.mask,WIDTH,height,geometry);
  const final=pca.geometry?finalAxis(s.mask,WIDTH,height,pca.geometry):{centers:[],metric:null};
  return{width:WIDTH,height,clean,mp,mpError,p0,p0Source,geometry,mask:s.mask,pca,sections,final};
}
