'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
function privateJson(file){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||st.size>32768)throw Error('ARCHIVE_INSTALL_INVALID');return JSON.parse(fs.readFileSync(file,'utf8'))}
/** Prefer an existing manually enrolled config without rewriting it. Otherwise
 * use this Mac's independently enrolled generic Slack installation. */
function archiveInstallation(userData,{home=os.homedir(),read=privateJson,realpath=fs.realpathSync}={}){
 const legacy=path.join(userData,'personal-task-archive.json');
 let legacyConfig;try{legacyConfig=read(legacy)}catch(e){if(e.code!=='ENOENT')throw e}
 if(legacyConfig){const config=legacyConfig;if(![config.nodePath,config.helperPath,config.configPath].every(p=>typeof p==='string'&&path.isAbsolute(p))||!/^T[A-Z0-9]+$/.test(config.accountId??''))throw Error('ARCHIVE_INSTALL_INVALID');const enrolled=read(config.configPath);if(enrolled.provider!=='slack'||enrolled.accountId!==config.accountId)throw Error('ARCHIVE_INSTALL_INVALID');return config}
 const base=path.join(home,'Library/Application Support/PersonalTaskArchive'),state=path.join(base,'slack');
 let install;try{install=read(path.join(state,'installation.json'))}catch(e){if(e.code==='ENOENT')return null;throw e}
 const configPath=path.join(state,'config.json'),config=read(configPath);
 if(userData!==path.join(home,'Library/Application Support/Slack Inbox')||install.schema!==1||install.provider!=='slack'||install.configPath!==configPath||config.provider!=='slack'||install.deviceId!==config.deviceId||!/^T[A-Z0-9]+$/.test(config.accountId??'')||!path.isAbsolute(install.nodePath??'')||path.dirname(install.release??'')!==path.join(base,'releases')||! /^[0-9a-f]{64}$/.test(path.basename(install.release)))throw Error('ARCHIVE_INSTALL_INVALID');
 const helperPath=path.join(install.release,'scripts/archive-intent-helper.mjs');if(realpath(helperPath)!==helperPath)throw Error('ARCHIVE_INSTALL_INVALID');
 return {nodePath:install.nodePath,helperPath,configPath,accountId:config.accountId};
}
module.exports={archiveInstallation};
