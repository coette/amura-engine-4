const SLICE_FRACTIONS=[0.18,0.32,0.46,0.60,0.74];
function median(v){if(!v.length)return 0;const s=v.slice().sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])*0.5;}
function local(x,y,g){const dx=x-g.origin.x,dy=y-g.origin.y;return{t:dx*g.elbow.x+dy*g.elbow.y,u:dx*g.perpendicular.x+dy*g.perpendicular.y};}
function fitAxis(points,preferred){if(!points||points.length<2)return null;const mean={x:points.reduce((s,p)=>s+p.x,0)/points.length,y:points.reduce((s,p)=>s+p.y,0)/points.length};let xx=0,xy=0,yy=0;for(const p of points){const dx=p.x-mean.x,dy=p.y-mean.y;xx+=dx*dx;xy+=dx*dy;yy+=dy*dy;}const a=.5*Math.atan2(2*xy,xx-yy);let d={x:Math.cos(a),y:Math.sin(a)};if(preferred&&d.x*preferred.x+d.y*preferred.y<0)d={x:-d.x,y:-d.y};return{mean,direction:d};}
function angle(d){return d?Math.atan2(d.y,d.x)*180/Math.PI:null;}

export function computeFinalFromGeometry(mask,width,height,g){
  if(!g)return{centers:[],metric:null};
  const half=g.roiEnd*.065,buckets=SLICE_FRACTIONS.map(()=>({x:[],y:[]}));
  for(let y=0;y<height;y+=2)for(let x=0;x<width;x+=2){
    if(!mask[y*width+x])continue;
    const q=local(x+.5,y+.5,g);
    for(let i=0;i<SLICE_FRACTIONS.length;i++){
      if(Math.abs(q.t-g.roiEnd*SLICE_FRACTIONS[i])>half)continue;
      buckets[i].x.push(x+.5);buckets[i].y.push(y+.5);break;
    }
  }
  const centers=buckets.map((b,i)=>b.x.length<10?null:{x:median(b.x),y:median(b.y),fraction:SLICE_FRACTIONS[i]}).filter(Boolean);
  if(centers.length!==5)return{centers,metric:null};
  const good=centers.slice(1),ax=fitAxis(good,g.elbow);if(!ax)return{centers,metric:null};
  const pr=good.map(p=>(p.x-ax.mean.x)*ax.direction.x+(p.y-ax.mean.y)*ax.direction.y),lo=Math.min(...pr),hi=Math.max(...pr);
  const start={x:ax.mean.x+ax.direction.x*lo,y:ax.mean.y+ax.direction.y*lo},end={x:ax.mean.x+ax.direction.x*hi,y:ax.mean.y+ax.direction.y*hi};
  return{centers,metric:{start,end,midpoint:{x:(start.x+end.x)/2,y:(start.y+end.y)/2},angle:angle(ax.direction)}};
}
