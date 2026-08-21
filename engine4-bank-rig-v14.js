import {
  ACESFilmicToneMapping,
  AmbientLight,
  CapsuleGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer
} from "./vendor/three/three.module.js";
import { GLTFLoader } from "./vendor/three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "./vendor/three/addons/loaders/DRACOLoader.js";
import { buildWristFrame, imageSpaceLandmarks } from "./wrist-frame.js?v=e4r1.4";
import { FilesetResolver, HandLandmarker } from "./vendor/mediapipe/vision_bundle.mjs";

const REVISION = "R1.4";
const MODEL_URL = "./models/A1-Irontide-AR-pretty-mobile.glb?v=e4r1.4";
const MODEL_CONFIG_URL = "./models/A1-Irontide-AR-pretty-mobile.json?v=e4r1.4";
const WRIST_WIDTH_MM = 62;
const WRIST_THICKNESS_MM = 44;
const WRIST_LENGTH_MM = 150;
const FOV_DIAGONAL_DEG = 73;
const P0_BY_TARGET = new Map([
  [0,[169.20,250.24]], [30,[195.84,273.28]], [60,[162.73,268.84]],
  [90,[127.80,288.00]], [135,[140.04,282.88]], [150,[148.68,271.36]],
  [165,[147.24,281.60]], [180,[120.96,277.12]]
]);
const DEFAULT_MODEL_CONFIG = {
  asset: "A1-Irontide-AR-pretty-mobile.glb",
  scaleToMillimeters: 1000,
  rootNode: "AMURA_AR_ROOT",
  contactNode: "AMURA_CASEBACK_CONTACT"
};

let overlay = null;
let renderer = null;
let scene = null;
let camera = null;
let wristRig = null;
let watchAnchor = null;
let watchModel = null;
let wristMesh = null;
let wristMaterial = null;
let modelPromise = null;
let modelConfig = DEFAULT_MODEL_CONFIG;
let contactOffset = new Vector3();
let wristMode = 1;
let appliedMode = -1;
let lastSignature = "";
let timer = 0;
let lastGeometry = null;
let bankLandmarker = null;
let bankLandmarkerPromise = null;
const bankFrameCache = new Map();
const bankFramePending = new Map();

const tmpX = new Vector3();
const tmpY = new Vector3();
const tmpZ = new Vector3();
const zAxis = new Vector3(0,0,1);
const qScreen = new Quaternion();
const orientationMatrix = new Matrix4();

function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function quantile(values,q){if(!values.length)return 0;const s=values.slice().sort((a,b)=>a-b),i=clamp(q,0,1)*(s.length-1),lo=Math.floor(i),hi=Math.ceil(i);if(lo===hi)return s[lo];const t=i-lo;return s[lo]*(1-t)+s[hi]*t;}
function parseTarget(){const text=document.getElementById("engine4BankPose")?.textContent||"";const m=text.match(/(0|30|60|90|135|150|165|180)\s*°/);return m?Number(m[1]):null;}
function bankActive(){const root=document.getElementById("engine4BankRoot");return document.body.dataset.amuraMode==="bank" && Boolean(root) && !root.hidden;}
function orange(r,g,b,a){return a>120&&r>225&&g>105&&g<200&&b<115;}
function cyanish(r,g,b,a){return a>80&&g>105&&b>105&&(g-r)>18&&(b-r)>15;}
function wrapAngle(radians){let a=radians;while(a>Math.PI)a-=Math.PI*2;while(a<-Math.PI)a+=Math.PI*2;return a;}

function readOrangeAxis(canvas){
  if(!canvas||!canvas.width||!canvas.height)return null;
  let img;try{img=canvas.getContext("2d",{willReadFrequently:true}).getImageData(0,0,canvas.width,canvas.height);}catch(_){return null;}
  const pts=[];
  for(let y=0;y<img.height;y+=2)for(let x=0;x<img.width;x+=2){const i=(y*img.width+x)*4;if(orange(img.data[i],img.data[i+1],img.data[i+2],img.data[i+3]))pts.push({x:x+.5,y:y+.5});}
  if(pts.length<35)return null;
  const mean={x:pts.reduce((s,p)=>s+p.x,0)/pts.length,y:pts.reduce((s,p)=>s+p.y,0)/pts.length};
  let xx=0,xy=0,yy=0;for(const p of pts){const dx=p.x-mean.x,dy=p.y-mean.y;xx+=dx*dx;xy+=dx*dy;yy+=dy*dy;}
  const a=.5*Math.atan2(2*xy,xx-yy);let d={x:Math.cos(a),y:Math.sin(a)};if(d.x>0)d={x:-d.x,y:-d.y};
  const pr=pts.map(p=>(p.x-mean.x)*d.x+(p.y-mean.y)*d.y);const lo=quantile(pr,.08),hi=quantile(pr,.92);
  const start={x:mean.x+d.x*lo,y:mean.y+d.y*lo},end={x:mean.x+d.x*hi,y:mean.y+d.y*hi};
  return{midpoint:{x:(start.x+end.x)*.5,y:(start.y+end.y)*.5},elbowDir:d,start,end,span:hi-lo,img};
}

function measureCloudWidth(axis,canvas){
  const img=axis.img,normal={x:-axis.elbowDir.y,y:axis.elbowDir.x},cross=[];
  const band=clamp(axis.span*.11,8,18);
  for(let y=0;y<img.height;y+=2)for(let x=0;x<img.width;x+=2){
    const dx=x+.5-axis.midpoint.x,dy=y+.5-axis.midpoint.y;
    const along=dx*axis.elbowDir.x+dy*axis.elbowDir.y;if(Math.abs(along)>band)continue;
    const i=(y*img.width+x)*4;if(!cyanish(img.data[i],img.data[i+1],img.data[i+2],img.data[i+3]))continue;
    cross.push(dx*normal.x+dy*normal.y);
  }
  if(cross.length>30){const w=quantile(cross,.94)-quantile(cross,.06);if(Number.isFinite(w)&&w>=18&&w<=180)return w;}
  return clamp(axis.span*.34,34,92);
}

function projectP0(axis,target){
  const p=P0_BY_TARGET.get(target)||[axis.midpoint.x,axis.midpoint.y];
  const dx=p[0]-axis.midpoint.x,dy=p[1]-axis.midpoint.y;
  const t=dx*axis.elbowDir.x+dy*axis.elbowDir.y;
  return{x:axis.midpoint.x+axis.elbowDir.x*t,y:axis.midpoint.y+axis.elbowDir.y*t};
}

function focalFor(w,h){const diag=Math.hypot(w,h),fov=FOV_DIAGONAL_DEG*Math.PI/180;return diag*.5/Math.tan(fov*.5);}
function fovYFor(w,h){const f=focalFor(w,h);return 2*Math.atan(h/(2*f))*180/Math.PI;}
function axisHandAngle(axis){return Math.atan2(axis.elbowDir.y,-axis.elbowDir.x);}
function physicalHand(mp){const raw=String(mp?.handedness?.[0]?.[0]?.categoryName||mp?.handednesses?.[0]?.[0]?.categoryName||"").toLowerCase();return raw==="left"?"left":raw==="right"?"right":"unknown";}

async function getBankLandmarker(){
  if(bankLandmarker)return bankLandmarker;
  if(bankLandmarkerPromise)return bankLandmarkerPromise;
  bankLandmarkerPromise=(async()=>{
    const files=await FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm");
    const opts=delegate=>({baseOptions:{modelAssetPath:"./models/hand_landmarker.task",delegate},runningMode:"IMAGE",numHands:1,minHandDetectionConfidence:.5,minHandPresenceConfidence:.5,minTrackingConfidence:.5});
    try{bankLandmarker=await HandLandmarker.createFromOptions(files,opts("GPU"));}
    catch(_){bankLandmarker=await HandLandmarker.createFromOptions(files,opts("CPU"));}
    return bankLandmarker;
  })().catch(e=>{bankLandmarkerPromise=null;throw e;});
  return bankLandmarkerPromise;
}

function requestBankFrame(bank,target){
  if(bankFrameCache.has(target)||bankFramePending.has(target))return;
  const copy=document.createElement("canvas");copy.width=bank.width;copy.height=bank.height;copy.getContext("2d").drawImage(bank,0,0);
  const promise=(async()=>{
    const lm=await getBankLandmarker();
    const mp=lm.detect(copy);
    const landmarks=mp?.landmarks?.[0];
    if(!landmarks||landmarks.length<18)throw new Error("MediaPipe IMAGE sin mano");
    const points=imageSpaceLandmarks(landmarks,copy.width,copy.height);
    const frame=buildWristFrame(points,physicalHand(mp));
    if(!frame?.xAxis||!frame?.yAxis||!frame?.zAxis)throw new Error("Marco IMAGE 3D inválido");
    bankFrameCache.set(target,frame);
  })().catch(e=>{console.warn("R1.4 banco orientación",e);bankFrameCache.set(target,null);}).finally(()=>bankFramePending.delete(target));
  bankFramePending.set(target,promise);
}

function orientationFromBankFrame(axis,frame){
  if(!frame?.xAxis||!frame?.yAxis||!frame?.zAxis)return null;

  tmpX.set(frame.xAxis.x,-frame.xAxis.y,-frame.xAxis.z).normalize();
  tmpY.set(frame.yAxis.x,-frame.yAxis.y,-frame.yAxis.z).normalize();
  tmpZ.set(frame.zAxis.x,-frame.zAxis.y,-frame.zAxis.z).normalize();

  const projected=Math.hypot(tmpX.x,tmpX.y);
  if(!Number.isFinite(projected)||projected<.06)return null;
  const currentAngle=Math.atan2(tmpX.y,tmpX.x);
  const desiredAngle=axisHandAngle(axis);
  const delta=wrapAngle(desiredAngle-currentAngle);
  qScreen.setFromAxisAngle(zAxis,delta);
  tmpX.applyQuaternion(qScreen).normalize();
  tmpY.applyQuaternion(qScreen).normalize();
  tmpZ.applyQuaternion(qScreen).normalize();
  orientationMatrix.makeBasis(tmpX,tmpY,tmpZ);
  return new Quaternion().setFromRotationMatrix(orientationMatrix).normalize();
}

function fallbackOrientation(axis,target){
  const x=new Vector3(-axis.elbowDir.x,axis.elbowDir.y,0).normalize();
  const z=new Vector3(0,0,1);
  const y=new Vector3().crossVectors(z,x).normalize();
  const rollQ=new Quaternion().setFromAxisAngle(x,(target||0)*Math.PI/180);
  y.applyQuaternion(rollQ).normalize();z.applyQuaternion(rollQ).normalize();
  const m=new Matrix4().makeBasis(x,y,z);
  return new Quaternion().setFromRotationMatrix(m).normalize();
}

function applyAppearance(){
  if(!wristMesh||!wristMaterial)return;
  wristMesh.visible=wristMode!==0;
  if(appliedMode===wristMode)return;
  if(wristMode===1){wristMaterial.colorWrite=true;wristMaterial.transparent=true;wristMaterial.opacity=.30;wristMaterial.depthWrite=false;}
  else if(wristMode===2){wristMaterial.colorWrite=true;wristMaterial.transparent=false;wristMaterial.opacity=1;wristMaterial.depthWrite=true;}
  else if(wristMode===3){wristMaterial.colorWrite=false;wristMaterial.transparent=false;wristMaterial.opacity=1;wristMaterial.depthWrite=true;}
  wristMaterial.depthTest=true;wristMaterial.needsUpdate=true;appliedMode=wristMode;
}

function ensureUi(){
  const root=document.getElementById("engine4BankRoot");if(!root)return false;
  if(!document.getElementById("engine4BankRigStyle")){
    const s=document.createElement("style");s.id="engine4BankRigStyle";s.textContent=`
      #engine4BankThree{position:absolute;z-index:3;pointer-events:none;background:transparent}
      #engine4BankModes{position:absolute;left:10px;right:10px;bottom:142px;z-index:8;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
      #engine4BankModes button{min-height:42px;padding:0 4px;border:1px solid rgba(255,255,255,.38);border-radius:999px;background:rgba(5,10,17,.9);color:rgba(255,255,255,.74);font:800 10px/1 Arial,sans-serif}
      #engine4BankModes button.on{background:rgba(0,133,164,.94);color:#fff;border-color:#fff}
      #engine4BankRigState{position:absolute;left:10px;right:10px;bottom:188px;z-index:8;text-align:center;color:#fff;font:800 10px/1.2 Arial,sans-serif;text-shadow:0 1px 4px #000;pointer-events:none}
    `;document.head.appendChild(s);
  }
  if(!overlay){overlay=document.createElement("canvas");overlay.id="engine4BankThree";document.getElementById("engine4BankStage")?.appendChild(overlay);}
  if(!document.getElementById("engine4BankModes")){
    const state=document.createElement("div");state.id="engine4BankRigState";state.textContent="R1.4 · ESPERANDO FOTO";root.appendChild(state);
    const modes=document.createElement("div");modes.id="engine4BankModes";
    ["OCULTA","TRANSP.","SÓLIDA","OCLUSIÓN"].forEach((label,mode)=>{const b=document.createElement("button");b.type="button";b.dataset.mode=String(mode);b.textContent=label;b.classList.toggle("on",mode===wristMode);b.onclick=()=>{wristMode=mode;modes.querySelectorAll("button").forEach(x=>x.classList.toggle("on",Number(x.dataset.mode)===wristMode));applyAppearance();render();};modes.appendChild(b);});root.appendChild(modes);
  }
  return true;
}

async function loadModel(){
  if(watchModel)return watchModel;if(modelPromise)return modelPromise;
  modelPromise=(async()=>{
    try{const r=await fetch(MODEL_CONFIG_URL,{cache:"no-store"});if(r.ok)modelConfig={...DEFAULT_MODEL_CONFIG,...await r.json()};}catch(_){}
    const loader=new GLTFLoader(),draco=new DRACOLoader();draco.setDecoderPath("./vendor/three/draco/");draco.setDecoderConfig({type:"wasm"});loader.setDRACOLoader(draco);
    const gltf=await loader.loadAsync(MODEL_URL);watchModel=gltf.scene;watchModel.scale.setScalar(Number(modelConfig.scaleToMillimeters)||1000);watchModel.rotateX(Math.PI);
    wristRig=new Group();wristRig.name="AMURA_ENGINE4_BANK_WRIST_WATCH_RIG";watchAnchor=new Group();watchAnchor.add(watchModel);wristRig.add(watchAnchor);
    wristMaterial=new MeshBasicMaterial({color:0x8d6cff,transparent:true,opacity:.30,depthTest:true,depthWrite:false});
    wristMesh=new Mesh(new CapsuleGeometry(1,2,8,20),wristMaterial);wristMesh.scale.set(WRIST_WIDTH_MM/2,WRIST_LENGTH_MM/4,WRIST_THICKNESS_MM/2);wristMesh.position.set(0,0,WRIST_THICKNESS_MM/2);wristMesh.rotation.set(0,0,Math.PI/2);wristMesh.renderOrder=-1000;wristRig.add(wristMesh);scene.add(wristRig);
    wristRig.updateMatrixWorld(true);const contact=watchModel.getObjectByName(modelConfig.contactNode);if(contact){const w=new Vector3();contact.getWorldPosition(w);contactOffset=watchAnchor.worldToLocal(w.clone());watchAnchor.position.copy(contactOffset).multiplyScalar(-1);}applyAppearance();draco.dispose();return watchModel;
  })().catch(e=>{console.error("R1.4 banco: GLB",e);document.getElementById("engine4BankRigState")&&(document.getElementById("engine4BankRigState").textContent="R1.4 · ERROR GLB");throw e;});
  return modelPromise;
}

function ensureRenderer(rect){
  if(!overlay)return false;
  if(!renderer){scene=new Scene();camera=new PerspectiveCamera(50,1,1,20000);camera.position.set(0,0,0);camera.lookAt(0,0,-1);scene.add(new HemisphereLight(0xe8efff,0x24182f,2.25));scene.add(new AmbientLight(0xffffff,.85));const k=new DirectionalLight(0xffffff,3.2);k.position.set(-280,420,780);scene.add(k);const r=new DirectionalLight(0xa992ff,1.8);r.position.set(420,-160,520);scene.add(r);renderer=new WebGLRenderer({canvas:overlay,alpha:true,antialias:true,powerPreference:"high-performance",premultipliedAlpha:true});renderer.setPixelRatio(1);renderer.setClearColor(0x000000,0);renderer.outputColorSpace=SRGBColorSpace;renderer.toneMapping=ACESFilmicToneMapping;renderer.toneMappingExposure=1.18;loadModel().catch(()=>{});}
  const w=Math.max(1,Math.round(rect.width)),h=Math.max(1,Math.round(rect.height));renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();overlay.style.left=`${rect.left}px`;overlay.style.top=`${rect.top}px`;overlay.style.width=`${rect.width}px`;overlay.style.height=`${rect.height}px`;return true;
}

function render(){if(renderer&&scene&&camera){applyAppearance();renderer.render(scene,camera);}}

function updateBankRig(){
  if(!bankActive()){if(overlay)overlay.style.display="none";return;}
  if(!ensureUi())return;
  const bank=document.getElementById("engine4BankCanvas"),target=parseTarget();if(!bank||target===null)return;
  const rect=bank.getBoundingClientRect();if(rect.width<20||rect.height<20)return;overlay.style.display="block";if(!ensureRenderer(rect))return;
  const axis=readOrangeAxis(bank);if(!axis){if(wristRig)wristRig.visible=false;render();return;}
  const widthPx=measureCloudWidth(axis,bank),f=focalFor(bank.width,bank.height),depth=clamp(f*WRIST_WIDTH_MM/Math.max(1,widthPx),180,1200),anchor=projectP0(axis,target);
  const sig=`${target}:${Math.round(axis.midpoint.x)}:${Math.round(axis.midpoint.y)}:${Math.round(axis.span)}:${Math.round(widthPx)}`;
  camera.fov=fovYFor(bank.width,bank.height);camera.aspect=rect.width/rect.height;camera.updateProjectionMatrix();
  requestBankFrame(bank,target);
  const frame=bankFrameCache.get(target);
  const frameReady=bankFrameCache.has(target);
  const mpQ=frame?orientationFromBankFrame(axis,frame):null;
  const state=document.getElementById("engine4BankRigState");
  if(!frameReady){
    if(wristRig)wristRig.visible=false;
    if(state)state.textContent=`R1.4 · ${target}° · CALCULANDO ORIENTACIÓN IMAGE 3D`;
    render();
    return;
  }
  const orientation=mpQ||fallbackOrientation(axis,target);
  if(wristRig){
    wristRig.position.set((anchor.x-bank.width*.5)*depth/f,-(anchor.y-bank.height*.5)*depth/f,-depth);
    wristRig.quaternion.copy(orientation);wristRig.visible=true;lastGeometry={target,depth,widthPx,anchor,axis,orientationSource:mpQ?"IMAGE 3D":"fallback grados"};
  }
  if(state)state.textContent=`R1.4 · ${target}° · ORIENTACIÓN ${mpQ?"IMAGE 3D = CÁMARA":"FALLBACK"}`;
  lastSignature=sig;render();
}

function tick(){updateBankRig();}
function start(){ensureUi();timer=window.setInterval(tick,120);window.addEventListener("resize",tick);window.addEventListener("pagehide",()=>{if(timer)clearInterval(timer);},{once:true});}
start();

window.AmuraEngine4BankRig={revision:REVISION,get state(){return{active:bankActive(),wristMode,lastSignature,lastGeometry};}};
