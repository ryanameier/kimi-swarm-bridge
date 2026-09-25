import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listWorkspaceFiles, type FileTransferConfig } from './file-transfer.js';
import { runToolHandler } from './index.js';

/**
 * MCP App: an in-chat panel for moving files between the user and the hosted
 * Kimi workspace without code execution. Uploads go straight from the browser
 * to a signed upload link (the host proxies only small tool calls); downloads
 * use the host's ui/download-file when advertised, otherwise ui/open-link.
 */

export const FILE_PANEL_URI = 'ui://kimi-swarm/file-panel';
const MIME = 'text/html;profile=mcp-app';

const PANEL_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kimi files</title>
<style>
:root{--bg:#fff;--fg:#1f1f1f;--muted:#6b6b6b;--line:#e3e3e3;--accent:#2f6fde;--ok:#1a7f37;--err:#c62828;--chip:#f4f4f4}
@media (prefers-color-scheme:dark){:root{--bg:#1f1f1f;--fg:#ececec;--muted:#a0a0a0;--line:#3a3a3a;--accent:#7aa7ff;--ok:#56d364;--err:#ff7b72;--chip:#2a2a2a}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
main{padding:12px}h2{font-size:13px;font-weight:600;margin:14px 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
#drop{border:1.5px dashed var(--line);border-radius:10px;padding:16px;text-align:center;cursor:pointer}
#drop.over{border-color:var(--accent)}#drop b{color:var(--accent)}
.row{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}
.row .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{color:var(--muted);font-size:12px;white-space:nowrap}
button{font:inherit;border:1px solid var(--line);background:var(--chip);color:var(--fg);border-radius:6px;padding:3px 10px;cursor:pointer}
button:hover{border-color:var(--accent)}progress{width:90px}
.ok{color:var(--ok)}.err{color:var(--err)}#status{min-height:1.2em;font-size:12px;color:var(--muted)}
</style></head><body><main>
<div id="drop" tabindex="0" role="button" aria-label="Drop files here or choose files to upload to Kimi"><b>Drop files here</b> to give them to Kimi, or click to choose
<input id="pick" type="file" multiple hidden></div>
<div id="uploads"></div>
<h2>Kimi workspace <button id="refresh" title="Refresh">Refresh</button></h2>
<div id="files"><div class="meta">Loading…</div></div>
<div id="status"></div>
</main><script>
(()=>{
let nextId=1;const pending=new Map();let host={};
const post=(m)=>window.parent.postMessage(Object.assign({jsonrpc:'2.0'},m),'*');
const request=(method,params)=>new Promise((res,rej)=>{const id=nextId++;pending.set(id,{res,rej});post({id,method,params});});
const notify=(method,params)=>post({method,params:params||{}});
const $=(id)=>document.getElementById(id);
const status=(t,cls)=>{const s=$('status');s.textContent=t||'';s.className=cls||''};
const fmt=(n)=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';
const resize=()=>notify('ui/notifications/size-changed',{height:document.documentElement.scrollHeight});
new ResizeObserver(resize).observe(document.body);
async function callTool(name,args){
  const r=await request('tools/call',{name,arguments:args||{}});
  if(r.isError)throw new Error((r.content&&r.content[0]&&r.content[0].text)||'Tool failed');
  if(r.structuredContent)return r.structuredContent;
  return JSON.parse(r.content[0].text);
}
window.addEventListener('message',(e)=>{
  const m=e.data;if(!m||m.jsonrpc!=='2.0')return;
  if(m.id!==undefined&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);return;}
  if(m.method==='ui/notifications/tool-result'&&m.params){const sc=m.params.structuredContent;if(sc&&sc.items)render(sc.items);}
});
function render(items){
  const box=$('files');box.innerHTML='';
  if(!items.length){box.innerHTML='<div class="meta">No files yet.</div>';return}
  for(const f of items){
    const row=document.createElement('div');row.className='row';
    const name=document.createElement('span');name.className='name';name.textContent=f.path.replace(/^\/workspace\//,'');name.title=f.path;
    const meta=document.createElement('span');meta.className='meta';meta.textContent=fmt(f.sizeBytes);
    const btn=document.createElement('button');btn.textContent='Download';btn.onclick=()=>download(f.path,btn);
    row.append(name,meta,btn);box.append(row);
  }
}
async function refresh(){try{const r=await callTool('kimi_list_files',{dir:'/workspace'});render(r.items)}catch(e){status(e.message,'err')}}
async function download(path,btn){
  btn.disabled=true;status('Preparing download…');
  try{
    const link=(await callTool('kimi_create_download_links',{paths:[path]})).files[0];
    if(host.downloadFile){
      // Hand the host the bytes inline; hosts may refuse to fetch third-party links themselves.
      const res=await fetch(link.downloadUrl);
      if(!res.ok)throw new Error('Download failed: HTTP '+res.status);
      const buf=new Uint8Array(await res.arrayBuffer());
      let bin='';for(let i=0;i<buf.length;i+=32768)bin+=String.fromCharCode.apply(null,buf.subarray(i,i+32768));
      const mimeType=res.headers.get('content-type')||'application/octet-stream';
      const r=await request('ui/download-file',{contents:[{type:'resource',resource:{uri:'file:///'+encodeURIComponent(link.name),mimeType,blob:btoa(bin)}}]});
      if(r&&r.isError){
        if(host.openLinks){await request('ui/open-link',{url:link.downloadUrl});status('Opened download link for '+link.name+' (inline download was declined: '+JSON.stringify(r).slice(0,160)+')','ok');}
        else status('The host declined the download: '+JSON.stringify(r).slice(0,200),'err');
      }else status('Downloaded '+link.name+' (SHA-256 '+link.sha256.slice(0,12)+'…)','ok');
    }else if(host.openLinks){
      await request('ui/open-link',{url:link.downloadUrl});status('Opened download for '+link.name,'ok');
    }else{
      const a=document.createElement('a');a.href=link.downloadUrl;a.textContent=link.name;a.target='_blank';status('');$('status').append('Download: ',a);
    }
  }catch(e){status(e.message,'err')}finally{btn.disabled=false}
}
async function sha256(file){const d=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return[...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('')}
async function upload(file){
  const row=document.createElement('div');row.className='row';
  const name=document.createElement('span');name.className='name';name.textContent=file.name;
  const bar=document.createElement('progress');bar.max=1;bar.value=0;
  const meta=document.createElement('span');meta.className='meta';meta.textContent=fmt(file.size);
  const cancel=document.createElement('button');cancel.textContent='Cancel';
  row.append(name,bar,meta,cancel);$('uploads').append(row);
  try{
    const digest=await sha256(file);
    const link=(await callTool('kimi_create_upload_links',{files:[{filename:file.name,sha256:digest,sizeBytes:file.size}]})).uploads[0];
    const result=await new Promise((res,rej)=>{
      const x=new XMLHttpRequest();x.open('PUT',link.uploadUrl);
      x.upload.onprogress=(e)=>{if(e.lengthComputable)bar.value=e.loaded/e.total};
      x.onload=()=>x.status===201?res(JSON.parse(x.responseText)):rej(new Error((()=>{try{return JSON.parse(x.responseText).error}catch{return 'HTTP '+x.status}})()));
      x.onerror=()=>rej(new Error('Network error (is the upload domain allowed?)'));x.onabort=()=>rej(new Error('Cancelled'));
      cancel.onclick=()=>x.abort();x.send(file);
    });
    bar.value=1;cancel.remove();meta.className='meta ok';meta.textContent='Uploaded ✓ '+result.path;
    return result;
  }catch(e){cancel.remove();meta.className='meta err';meta.textContent=e.message;return null}
}
async function handle(files){
  const done=[];for(const f of files){const r=await upload(f);if(r)done.push(r)}
  if(done.length){
    const text='Files uploaded to the Kimi workspace:\n'+done.map(r=>'- '+r.path+' ('+r.sizeBytes+' bytes, sha256 '+r.sha256+')').join('\n');
    if(host.updateModelContext){request('ui/update-model-context',{content:[{type:'text',text}]}).catch(()=>{})}
    refresh();
  }
}
const drop=$('drop'),pick=$('pick');
drop.onclick=()=>{
  let opened=false;const mark=()=>{opened=true};
  window.addEventListener('blur',mark,{once:true});pick.addEventListener('cancel',mark,{once:true});
  pick.click();
  setTimeout(()=>{window.removeEventListener('blur',mark);if(!opened&&!pick.files.length)status('This app window cannot open a file picker here. Drag files onto the box instead.','err')},1500);
};drop.onkeydown=(e)=>{if(e.key==='Enter'||e.key===' ')pick.click()};
pick.onchange=()=>{handle([...pick.files]);pick.value=''};
drop.ondragover=(e)=>{e.preventDefault();drop.classList.add('over')};drop.ondragleave=()=>drop.classList.remove('over');
drop.ondrop=(e)=>{e.preventDefault();drop.classList.remove('over');handle([...e.dataTransfer.files])};
$('refresh').onclick=refresh;
request('ui/initialize',{appInfo:{name:'kimi-file-panel',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'})
  .then((r)=>{host=(r&&r.hostCapabilities)||{};notify('ui/notifications/initialized');refresh()})
  .catch((e)=>status('Panel could not connect to the host: '+e.message,'err'));
})();
</script></body></html>`;

export function registerFilePanel(server: McpServer, config: FileTransferConfig): void {
  const origin = new URL(config.publicBaseUrl).origin;
  const uiMeta = { ui: { csp: { connectDomains: [origin] }, prefersBorder: true } };

  server.registerResource(
    'kimi_file_panel',
    FILE_PANEL_URI,
    { title: 'Kimi file panel', description: 'Upload files to and download files from the Kimi workspace.', mimeType: MIME, _meta: uiMeta },
    async () => ({ contents: [{ uri: FILE_PANEL_URI, mimeType: MIME, text: PANEL_HTML, _meta: uiMeta }] }),
  );

  server.registerTool(
    'kimi_file_panel',
    {
      title: 'Open Kimi File Panel',
      description: 'Show an interactive panel in the conversation where the user can pick files from their device to upload into the Kimi workspace (/workspace/inputs), see the workspace files, and download Kimi deliverables. Use it when the user wants to hand files to Kimi or collect results and code execution cannot transfer the bytes, or when the user asks for an upload or download button. The panel verifies SHA-256 for every upload and reports uploaded paths back to the conversation.',
      inputSchema: {
        dir: z.string().optional().describe('Workspace directory to list initially, absolute or relative to /workspace. Defaults to the whole workspace.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: FILE_PANEL_URI } },
    },
    async (input) => {
      const result = await runToolHandler(() => listWorkspaceFiles(config, input.dir));
      if (result.isError) return result;
      const listing = JSON.parse(result.content[0].text) as Awaited<ReturnType<typeof listWorkspaceFiles>>;
      return {
        content: [{ type: 'text' as const, text: `Opened the Kimi file panel. ${listing.items.length} file(s) in ${listing.root}.` }],
        structuredContent: listing as unknown as Record<string, unknown>,
      };
    },
  );
}
