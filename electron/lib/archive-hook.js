'use strict';
const {spawnSync}=require('node:child_process');
/** Compatible with Electron33: SQLite/key handling stays in the pinned Node24 helper.
 * Install only around explicit archive/unarchive user IPC, never remote sync or watchers. */
module.exports=function createArchiveHook({nodePath,helperPath,configPath,accountId,baseRevision,onError,getWebContents,expectedDocumentURL,spawn=spawnSync}){
 if(![nodePath,helperPath,configPath].every(p=>typeof p==='string'&&p.startsWith('/'))||(typeof baseRevision!=='function'||typeof onError!=='function'||typeof getWebContents!=='function'||typeof expectedDocumentURL!=='string'||!expectedDocumentURL.startsWith('file://')||!/^T[A-Z0-9]+$/.test(accountId??'')))throw Error('ARCHIVE_UI_HOOK_CONFIGURATION');
 const call=(mode,input)=>{const r=spawn(nodePath,[helperPath,configPath,mode],{input:JSON.stringify(input),encoding:'utf8',stdio:['pipe','pipe','ignore'],timeout:15000,maxBuffer:16384});let out;try{out=JSON.parse(r.stdout)}catch{};if(r.status!==0||!out||out.error)throw Error('ARCHIVE_UI_CAPTURE_UNAVAILABLE');return out};
 return {run(event,store,command,keys){
  const expected=getWebContents();
  if(!expected||expected.isDestroyed()||event?.sender!==expected||event.senderFrame!==expected.mainFrame||event.senderFrame.url!==expectedDocumentURL)throw Error('ARCHIVE_UI_SENDER_REJECTED');
  if(!['item:archive','item:unarchive'].includes(command)||!Array.isArray(keys)||keys.some(k=>typeof k!=='string'||! /^[CDG][A-Z0-9]+:(?:dm|ch|channel|[0-9]{1,20}\.[0-9]{6})$/.test(k)))throw Error('ARCHIVE_UI_HOOK_ARGUMENTS');
  const method=command==='item:archive'?'archive':'unarchive';
  if(store.meta?.teamId!==accountId)throw Error('ARCHIVE_UI_ACCOUNT_REJECTED');
  if(keys.length>100){onError({code:'ARCHIVE_UI_CAPTURE_BATCH_TOO_LARGE'});return store[method](keys)}
  const original=store.mutate,envelopes=[];
  store.mutate=function(fn){return original.call(this,data=>{
   if(data.meta?.teamId!==accountId)throw Error('ARCHIVE_UI_ACCOUNT_REJECTED');
   fn(data);
   for(const id of keys){const item=data.items[id];if(!item)continue;try{const envelope=call('begin',{nativeId:id,field:'archivedTs',value:item.archivedTs,baseRevision:baseRevision(id,'archivedTs')});envelopes.push(envelope)}catch{onError({code:'ARCHIVE_UI_CAPTURE_FAILED'})}}
  })};
  let result;try{result=store[method](keys)}finally{store.mutate=original}
  // The original locked write has completed. Failed confirmation stays reserved for recovery;
  // it must not undo a user's local action or trigger extra Slack provider writes.
  for(const envelope of envelopes){try{call('confirm',{operationId:envelope.operation.operationId})}catch{onError({code:'ARCHIVE_UI_READBACK_PENDING'})}}
  return result;
 }};
};
