import React,{useCallback,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createTwin,type Twin} from '@little-brain/core';
import {useBrain} from '../src/useBrain';
import {loadDetector,detectFrame} from '../src/camera/detector';
import {trackObjects,summarizeObservations,type CameraObject} from '../src/camera/tracker';
function Check(){
 const [twin,setTwin]=useState(()=>createTwin('Camera check'));
 const [objects,setObjects]=useState<CameraObject[]>([]);const [state,setState]=useState('Ready');
 const update=useCallback((_id:string,fn:(t:Twin)=>Twin)=>setTwin(fn),[]);
 const brain=useBrain(twin,update,{endpoint:'',token:'',showThoughts:true,reducedMotion:true,chatWidth:360},()=>{});
 useEffect(()=>brain.updateVisualContext(objects.length?summarizeObservations(objects, objects[0]?.seenAt):'',objects.map(object=>object.id)),[objects,brain.updateVisualContext]);
 const detect=async()=>{setState('Detecting fixture…');try{const img=document.querySelector('img')!;await img.decode();const canvas=document.createElement('canvas');canvas.width=480;canvas.height=Math.round(img.naturalHeight/img.naturalWidth*480);canvas.getContext('2d')!.drawImage(img,0,0,canvas.width,canvas.height);const model=await loadDetector();const predictions=await detectFrame(model,canvas);setObjects(trackObjects([],predictions.map(p=>({label:p.class,score:p.score,x:p.bbox[0]/canvas.width,y:p.bbox[1]/canvas.height,width:p.bbox[2]/canvas.width,height:p.bbox[3]/canvas.height}))));setState('Fixture detected. Ready to ask.');}catch(error){setState(String(error));}};
 const answer=twin.messages.filter(message=>message.role==='assistant').map(message=>message.text).join('\n');
 return <main><h1>Camera → context → attention</h1><p>Uses a public sample image. No camera or microphone access. Only detected labels go to OpenAI.</p><img src="./cat.jpg" style={{maxWidth:300}}/><p><button onClick={()=>void detect()}>Detect sample</button> <button disabled={!objects.length||brain.thinking} onClick={()=>void brain.send('Use focus_thought on the detected cat, then tell me in one short sentence which object you see.')}>Ask brain about detected objects</button></p><pre>{state+'\n'+summarizeObservations(objects, objects[0]?.seenAt)}</pre><p role="status">{brain.error||brain.status+' · '+(brain.thinking?'Thinking…':'Ready')}</p><pre>{answer}</pre><p>Attention: {brain.activeThoughtId}</p><h2>{answer.toLowerCase().includes('cat')&&brain.activeThoughtId?.startsWith('vision-')?'PASS — detected object understood and attended to':''}</h2></main>;
}
createRoot(document.getElementById('root')!).render(<Check/>);
