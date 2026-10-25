import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const base='https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/';
const destination=path.resolve('apps/web/public/vision');
await mkdir(destination,{recursive:true});
async function download(name){
 if(!/^[a-zA-Z0-9_.-]+$/.test(name))throw new Error('Unexpected asset path');
 const response=await fetch(base+name,{signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw new Error(`Failed downloading ${name}: ${response.status}`);
 const bytes=Buffer.from(await response.arrayBuffer());await writeFile(path.join(destination,name),bytes);
 return {file:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}
if(process.argv.includes('--fixture-only')) {
 const fixture=await fetch('https://raw.githubusercontent.com/tensorflow/tfjs-models/master/coco-ssd/demo/cat.jpg');
 if(!fixture.ok)throw new Error('Fixture download failed');
 await mkdir('apps/web/checks',{recursive:true});
 await writeFile('apps/web/checks/cat.jpg',Buffer.from(await fixture.arrayBuffer()));
 console.log('Downloaded official COCO-SSD demo fixture.');process.exit(0);
}
const license=await fetch('https://raw.githubusercontent.com/tensorflow/tfjs-models/master/LICENSE');
if(!license.ok)throw new Error('License download failed');
await writeFile(path.join(destination,'LICENSE'),await license.text());
if(process.argv.includes('--license-only')){console.log('Saved detector Apache-2.0 license.');process.exit(0);}
const model=await download('model.json');
const {readFile}=await import('node:fs/promises');
const manifest=JSON.parse(await readFile(path.join(destination,'model.json'),'utf8'));
const assets=[model];
for(const name of [...new Set(manifest.weightsManifest.flatMap(group=>group.paths))])assets.push(await download(name));
await writeFile(path.join(destination,'provenance.json'),JSON.stringify({source:base,model:'COCO-SSD lite_mobilenet_v2',license:'Apache-2.0',code:'https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd',assets},null,2)+'\n');
console.log(`Vendored ${assets.length} detector files (${(assets.reduce((sum,item)=>sum+item.bytes,0)/1e6).toFixed(1)} MB).`);
