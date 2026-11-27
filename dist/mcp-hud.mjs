#!/usr/bin/env node
import{createRequire}from"node:module";import path from"node:path";import{chmodSync,closeSync,constants,copyFileSync,existsSync,fchmodSync,fstatSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,readSync,readdirSync,realpathSync,renameSync,rmSync,statSync,writeFileSync}from"node:fs";import{createHash,randomBytes}from"node:crypto";import os from"node:os";import{fileURLToPath,pathToFileURL}from"node:url";import{execFileSync}from"node:child_process";var UNSAFE_OBJECT_KEYS=new Set([`__proto__`,`constructor`,`prototype`]);function isPlainObject(value){return typeof value==`object`&&!!value&&!Array.isArray(value)}function isFiniteNum(value){return typeof value==`number`&&Number.isFinite(value)}function nonEmptyStr(value){if(typeof value!=`string`)return;let trimmed=value.trim();return trimmed.length>0?trimmed:void 0}function parseIsoTimestampSec(raw){if(typeof raw!=`string`||raw.length===0)return null;let ms=Date.parse(raw);return Number.isFinite(ms)?ms/1e3:null}function getErrCode(err){return err&&typeof err==`object`&&`code`in err&&typeof err.code==`string`?err.code:void 0}function selectNewestFirst(items,maxCount){return(maxCount===void 0?items.slice():maxCount<=0?[]:items.slice(-maxCount)).reverse()}function formatRelativeAge(deltaMs){let sec=Math.max(0,Math.floor(deltaMs/1e3));if(sec<60)return`${sec}s ago`;let min=Math.floor(sec/60);if(min<60)return`${min}m ago`;let hr=Math.floor(min/60);return hr<24?`${hr}h ago`:`${Math.floor(hr/24)}d ago`}function formatSurfaceBadge(surface){return surface===`cli`?`CLI`:surface===`ide`?`IDE`:`APP`}var TEMP_SUFFIX_RANDOM_BYTES=8,DEFAULT_MAX_REGULAR_JSON_BYTES=524288,REGULAR_JSON_CHUNK_BYTES=65536,STRICT_UTF8_DECODER=new TextDecoder(`utf-8`,{fatal:!0});function decodeStrictUtf8(buf){return STRICT_UTF8_DECODER.decode(buf)}function makeTempSuffix(){return`${process.pid}.${Date.now()}.${randomBytes(TEMP_SUFFIX_RANDOM_BYTES).toString(`hex`)}`}function readFdRange(fd,startOffset,length){let safeLen=Math.max(0,length);if(safeLen===0)return Buffer.alloc(0);let buf=Buffer.allocUnsafe(safeLen),readPos=0;for(;readPos<safeLen;){let bytesRead=readSync(fd,buf,readPos,safeLen-readPos,startOffset+readPos);if(bytesRead<=0)break;readPos+=bytesRead}return readPos<safeLen?buf.subarray(0,readPos):buf}function lstatIfPresentSync(filePath){try{return lstatSync(filePath)}catch(err){let code=getErrCode(err);if(code===`ENOENT`||code===`ENOTDIR`)return null;throw err}}function statIfPresentSync(filePath){try{return statSync(filePath)}catch(err){let code=getErrCode(err);if(code===`ENOENT`||code===`ENOTDIR`)return null;throw err}}function hasExcessivePosixMode(st){return process.platform!==`win32`&&!!(st.mode&63)}function readJsonObjectFromOpenFd(fd,maxBytes,requirePrivate){let fdStat=fstatSync(fd);if(!fdStat.isFile()||fdStat.size>maxBytes||requirePrivate&&hasExcessivePosixMode(fdStat))return null;let chunks=[],totalBytes=0,chunkBuf=Buffer.allocUnsafe(Math.min(Math.max(fdStat.size+1,1024),REGULAR_JSON_CHUNK_BYTES));for(;;){let bytesRead=readSync(fd,chunkBuf,0,chunkBuf.length,null);if(bytesRead<=0)break;if(totalBytes+=bytesRead,totalBytes>maxBytes)return null;chunks.push(Buffer.from(chunkBuf.subarray(0,bytesRead)))}let parsed=JSON.parse(decodeStrictUtf8(Buffer.concat(chunks,totalBytes)));return isPlainObject(parsed)?parsed:null}function readBoundedJsonInternal(filePath,maxBytes,followSymlinks,requirePrivate){let preStat;try{preStat=followSymlinks?statIfPresentSync(filePath):lstatIfPresentSync(filePath)}catch{return null}if(preStat===null||!followSymlinks&&preStat.isSymbolicLink()||!preStat.isFile()||preStat.size>maxBytes||requirePrivate&&hasExcessivePosixMode(preStat))return null;let flags=constants.O_RDONLY;process.platform!==`win32`&&(!followSymlinks&&typeof constants.O_NOFOLLOW==`number`&&(flags|=constants.O_NOFOLLOW),typeof constants.O_NONBLOCK==`number`&&(flags|=constants.O_NONBLOCK));let fd;try{return fd=openSync(filePath,flags),readJsonObjectFromOpenFd(fd,maxBytes,requirePrivate)}catch{return null}finally{if(fd!==void 0)try{closeSync(fd)}catch{}}}function readRegularJsonObjectSync(filePath,maxBytes=DEFAULT_MAX_REGULAR_JSON_BYTES,options){return readBoundedJsonInternal(filePath,maxBytes,!1,options?.requirePrivateMode===!0)}function readBoundedJsonObjectSync(filePath,maxBytes=DEFAULT_MAX_REGULAR_JSON_BYTES){return readBoundedJsonInternal(filePath,maxBytes,!0,!1)}function writeTempAtomicSync(filePath,writer,tempSuffix=makeTempSuffix()){mkdirSync(path.dirname(filePath),{recursive:!0});let tmpPath=`${filePath}.tmp.${tempSuffix}`,created=!1,markCreated=()=>{created=!0};try{writer(tmpPath,markCreated),renameSync(tmpPath,filePath)}catch(err){if(created)try{rmSync(tmpPath,{force:!0})}catch{}throw err}}function writeBufferAtomicSync(filePath,content,mode,tempSuffix){writeTempAtomicSync(filePath,(tmpPath,markCreated)=>{let flags=constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL;process.platform!==`win32`&&typeof constants.O_NOFOLLOW==`number`&&(flags|=constants.O_NOFOLLOW);let fd;try{fd=openSync(tmpPath,flags,mode??438),markCreated(),writeFileSync(fd,content),mode!==void 0&&process.platform!==`win32`&&fchmodSync(fd,mode)}finally{if(fd!==void 0)try{closeSync(fd)}catch{}}},tempSuffix)}function getHomeDir(env=process.env){return process.platform===`win32`?nonEmptyStr(env.USERPROFILE)??nonEmptyStr(env.HOME)??os.homedir():nonEmptyStr(env.HOME)??nonEmptyStr(env.USERPROFILE)??os.homedir()}function expandHome(inputPath,env=process.env){return inputPath===`~`?getHomeDir(env):inputPath.startsWith(`~/`)||inputPath.startsWith(`~\\`)?path.join(getHomeDir(env),inputPath.slice(2)):inputPath}function resolveCliHome(cliHome,env=process.env){let explicit=nonEmptyStr(cliHome);if(explicit!==void 0)return path.resolve(expandHome(explicit,env));let rawBase=nonEmptyStr(env.GEMINI_CLI_HOME),root=rawBase===void 0?getHomeDir(env):path.resolve(expandHome(rawBase,env));return path.join(root,`.gemini`,`antigravity-cli`)}function resolveProfileRoots(cliHomeOpt,geminiRootOpt,env=process.env){let cliHome=resolveCliHome(cliHomeOpt,env),explicitGemini=nonEmptyStr(geminiRootOpt);if(explicitGemini!==void 0)return{cliHome,geminiRoot:path.resolve(expandHome(explicitGemini,env))};if(nonEmptyStr(cliHomeOpt)!==void 0)return{cliHome,geminiRoot:path.basename(cliHome)===`antigravity-cli`?path.dirname(cliHome):path.join(cliHome,`.gemini`)};let envGemini=nonEmptyStr(env.GEMINI_HOME);if(envGemini!==void 0)return{cliHome,geminiRoot:path.resolve(expandHome(envGemini,env))};let envCli=nonEmptyStr(env.GEMINI_CLI_HOME);return envCli===void 0?{cliHome,geminiRoot:path.join(getHomeDir(env),`.gemini`)}:{cliHome,geminiRoot:path.join(path.resolve(expandHome(envCli,env)),`.gemini`)}}function toComparePath(p){return process.platform===`win32`||process.platform===`darwin`?path.resolve(p).toLowerCase():path.resolve(p)}function realpathExistingPrefixSync(dirPath){let resolved=path.resolve(dirPath),tail=[],cur=resolved;for(;;)try{let real=realpathSync(cur);return tail.length>0?path.join(real,...tail):real}catch{let parent=path.dirname(cur);if(parent===cur)return resolved;tail.unshift(path.basename(cur)),cur=parent}}function isMainEntry(metaUrl){let argv1=process.argv[1];if(!argv1)return!1;try{return realpathSync(argv1)===realpathSync(fileURLToPath(metaUrl))}catch{return!1}}new Int32Array(new SharedArrayBuffer(4));function isPidAlive(pid){if(!Number.isInteger(pid)||pid<=0)return!1;try{return process.kill(pid,0),!0}catch(err){return getErrCode(err)===`EPERM`}}var ESC_CHAR$1=`\x1B`,BEL_CHAR=`\x07`,C1_DCS_CHAR=``,C1_SOS_CHAR=``,C1_CSI_CHAR=``,C1_ST_CHAR=``,C1_OSC_CHAR=``,C1_PM_CHAR=``,C1_APC_CHAR=``,OSC_TERMINATOR=`(?:${BEL_CHAR}|${ESC_CHAR$1}\\\\|${C1_ST_CHAR}|$)`,STRING_TERMINATOR=`(?:${ESC_CHAR$1}\\\\|${C1_ST_CHAR}|$)`,TERMINAL_ESCAPE_RE=RegExp(`(?:${ESC_CHAR$1}(?:\\[[0-?]*[ -/]*[@-~]?|\\][\\s\\S]*?${OSC_TERMINATOR}|[PX^_][\\s\\S]*?${STRING_TERMINATOR}|[@-Z\\\\-_])|${C1_CSI_CHAR}[0-?]*[ -/]*[@-~]?|${C1_OSC_CHAR}[\\s\\S]*?${OSC_TERMINATOR}|${`[${C1_DCS_CHAR}${C1_SOS_CHAR}${C1_PM_CHAR}${C1_APC_CHAR}]`}[\\s\\S]*?${STRING_TERMINATOR})`,`g`);function isBidiFormatControl(code){return code===1564||code===8206||code===8207||code>=8234&&code<=8238||code>=8294&&code<=8303}function sanitizeTerminalText(text){let stripped=text.replace(TERMINAL_ESCAPE_RE,``),out=``,prevSpace=!1;for(let i=0;i<stripped.length;i+=1){let code=stripped.charCodeAt(i);code===9||code===10||code===13||code===8232||code===8233?prevSpace||=(out+=` `,!0):code<=31||code>=127&&code<=159||isBidiFormatControl(code)||(out+=stripped[i]??``,prevSpace=code===32)}return out}function sanitizeTerminalLabel(text){return sanitizeTerminalText(text).trim()}var SAFE_SESSION_ID_RE=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;function sanitizeSessionId(raw){if(typeof raw!=`string`)return null;let trimmed=raw.trim();return trimmed.length===0||trimmed.includes(`..`)||UNSAFE_OBJECT_KEYS.has(trimmed)?null:SAFE_SESSION_ID_RE.test(trimmed)?trimmed:null}function resolveConversationId(data){return sanitizeSessionId(nonEmptyStr(data.conversation_id)??nonEmptyStr(data.session_id))}function isDescendantOrSame(rootPath,targetPath){let rel=path.relative(rootPath,targetPath);return rel!==`..`&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel)}function isStrictDescendant(rootPath,targetPath){return path.relative(rootPath,targetPath)!==``&&isDescendantOrSame(rootPath,targetPath)}function lstatOutcome(p){try{return{kind:`ok`,stat:lstatSync(p)}}catch(err){return err&&typeof err==`object`&&`code`in err&&err.code===`ENOENT`?{kind:`missing`}:{kind:`error`}}}function realpathIfExists(p){try{return realpathSync(p)}catch{return null}}function isDirectoryAt(p){try{return statSync(p).isDirectory()}catch{return!1}}function isRegularFileAt(p){try{return statSync(p).isFile()}catch{return!1}}function checkExistingSegment(stat,curPath,realRoot,isLast){if(stat.isSymbolicLink()){let realCur=realpathIfExists(curPath);return realCur===null||!isStrictDescendant(realRoot,realCur)?!1:isLast?isRegularFileAt(realCur):isDirectoryAt(realCur)}return isLast?stat.isFile():stat.isDirectory()}function verifySegmentsInsideRealRoot(resolvedRoot,realRoot,resolvedCandidate){let rel=path.relative(resolvedRoot,resolvedCandidate);if(rel===``||rel===`..`||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))return!1;let segments=rel.split(path.sep),cur=resolvedRoot;for(let i=0;i<segments.length;i+=1){let seg=segments[i];if(seg===void 0)return!1;cur=path.join(cur,seg);let outcome=lstatOutcome(cur);if(outcome.kind===`error`)return!1;if(outcome.kind===`missing`)return!0;if(!checkExistingSegment(outcome.stat,cur,realRoot,i===segments.length-1))return!1}let finalReal=realpathIfExists(resolvedCandidate);return finalReal!==null&&isStrictDescendant(realRoot,finalReal)&&isRegularFileAt(finalReal)}function resolveCanonicalParent(parentDir){let resolvedParent=path.resolve(parentDir),missingSegments=[],cur=resolvedParent;for(;;){let outcome=lstatOutcome(cur);if(outcome.kind===`error`)return null;if(outcome.kind===`ok`){let realBase=realpathIfExists(cur);return realBase===null||!isDirectoryAt(realBase)?null:{logical:resolvedParent,real:path.join(realBase,...missingSegments)}}let parent=path.dirname(cur);if(parent===cur)return null;missingSegments.unshift(path.basename(cur)),cur=parent}}function resolveTrustedSubdir(parentDir,subSegments){let base=resolveCanonicalParent(parentDir);if(base===null)return null;let logicalCur=base.logical,expectedRealCur=base.real;for(let seg of subSegments){if(logicalCur=path.resolve(logicalCur,seg),expectedRealCur=path.join(expectedRealCur,seg),!isStrictDescendant(base.logical,logicalCur))return null;let outcome=lstatOutcome(logicalCur);if(outcome.kind===`error`)return null;if(outcome.kind===`ok`){if(outcome.stat.isSymbolicLink()||!outcome.stat.isDirectory())return null;let actualReal=realpathIfExists(logicalCur);if(actualReal===null||actualReal!==expectedRealCur)return null}}return{logical:logicalCur,real:expectedRealCur}}function resolveTrustedCliDir(cliHome,subDir){let trusted=resolveTrustedSubdir(cliHome,[subDir]);return trusted===null||!existsSync(trusted.logical)?null:trusted.logical}function resolveCliSubdirFile(cliHome,subDir,...segments){let trusted=resolveTrustedSubdir(cliHome,[subDir]);if(trusted===null)return null;let candidate=path.resolve(trusted.logical,...segments);return verifySegmentsInsideRealRoot(trusted.logical,trusted.real,candidate)?candidate:null}function resolveSafeSkillFile(cliHome,rawSkillFile,workspaceDir){if(!existsSync(rawSkillFile))return null;let resolvedCandidate=path.resolve(rawSkillFile),rootInputs=[cliHome,path.dirname(cliHome)],ws=nonEmptyStr(workspaceDir);ws!==void 0&&rootInputs.push(ws);for(let rawRoot of rootInputs){if(!existsSync(rawRoot))continue;let root=resolveCanonicalParent(rawRoot);if(root!==null&&(verifySegmentsInsideRealRoot(root.logical,root.real,resolvedCandidate)||verifySegmentsInsideRealRoot(root.real,root.real,resolvedCandidate)))return resolvedCandidate}return null}var MAX_ANCESTOR_HOPS=8,POSIX_PS_TIMEOUT_MS=300,WIN32_PS_TIMEOUT_MS=800,SHELL_AND_NODE_WRAPPERS=new Set([`sh`,`bash`,`zsh`,`fish`,`dash`,`ksh`,`csh`,`tcsh`,`cmd`,`cmd.exe`,`powershell`,`powershell.exe`,`pwsh`,`pwsh.exe`,`node`,`node.exe`]);function normalizeExeName(raw){let trimmed=raw.trim();if(trimmed.length===0)return``;let base=path.win32.basename(trimmed).toLowerCase();return base.startsWith(`-`)?base.slice(1):base}function isAgyBinaryName(exe){return exe===`agy`||exe===`agy.exe`}function splitShellTokens(cmdline){let tokens=[],cur=``,quote=``,escaped=!1;for(let i=0;i<cmdline.length;i+=1){let ch=cmdline[i];if(ch!==void 0){if(escaped)cur+=ch,escaped=!1;else{if(ch===`\\`&&quote!==`'`){let next=cmdline[i+1];if(next===` `||next===`	`||next===`"`||next===`'`||next===`\\`){escaped=!0;continue}}(ch===`"`||ch===`'`)&&(quote===``||quote===ch)?quote=quote===``?ch:``:/\s/.test(ch)&&quote===``?cur.length>0&&(tokens.push(cur),cur=``):cur+=ch}}}return cur.length>0&&tokens.push(cur),tokens}function extractAgyTokens(tokens,comm=``){let commExe=normalizeExeName(comm),argvExe=normalizeExeName(tokens[0]??``);if(SHELL_AND_NODE_WRAPPERS.has(commExe)||SHELL_AND_NODE_WRAPPERS.has(argvExe)||!isAgyBinaryName(commExe)&&!isAgyBinaryName(argvExe))return null;let hasBypass=tokens.includes(`--dangerously-skip-permissions`),cliMode=``;for(let i=0;i<tokens.length;i+=1){let tok=tokens[i];if(tok!==void 0){if(tok.startsWith(`--mode=`))cliMode=tok.slice(7);else if(tok===`--mode`){let next=tokens[i+1];next!==void 0&&(cliMode=next)}}}return{bypass:hasBypass,cliMode}}function parseLinuxProcStat(raw){let openIdx=raw.indexOf(`(`),closeIdx=raw.lastIndexOf(`)`);if(openIdx===-1||closeIdx<=openIdx)return null;let comm=raw.slice(openIdx+1,closeIdx),ppidRaw=raw.slice(closeIdx+1).trim().split(/\s+/)[1];return ppidRaw===void 0||!/^\d+$/.test(ppidRaw)?null:{comm,ppid:Number.parseInt(ppidRaw,10)}}function readPosixPsSample(pid){let output=``;try{output=execFileSync(`ps`,[`-o`,`ppid=,args=`,`-p`,String(pid)],{encoding:`utf8`,timeout:POSIX_PS_TIMEOUT_MS,stdio:[`ignore`,`pipe`,`ignore`]}).trim()}catch{return null}if(output.length===0)return null;let match=/^\s*(\d+)\s*(.*)$/s.exec(output);return{pid,ppid:match?.[1]===void 0?0:Number.parseInt(match[1],10),comm:``,args:match?.[2]??``}}function readLinuxProcSample(pid){try{let parsed=parseLinuxProcStat(readFileSync(`/proc/${pid}/stat`,`utf8`));if(parsed!==null){let tokens=[],args=``;try{let rawParts=readFileSync(`/proc/${pid}/cmdline`).toString(`utf8`).split(`\0`);for(;rawParts.length>0&&rawParts[rawParts.length-1]===``;)rawParts.pop();tokens=rawParts,args=tokens.join(` `)}catch{}return{pid,ppid:parsed.ppid,comm:parsed.comm,args,tokens}}}catch{}return readPosixPsSample(pid)}function readWin32AncestorsViaPowerShell(startPid){if(!Number.isInteger(startPid)||startPid<=1)return null;let script=`$p=${startPid};$r=@();for($i=0;$i -lt ${MAX_ANCESTOR_HOPS} -and $p -gt 1;$i++){$x=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue;if(-not $x){break};$r+=[pscustomobject]@{pid=[int]$x.ProcessId;ppid=[int]$x.ParentProcessId;comm=[string]$x.Name;args=[string]$x.CommandLine};$p=[int]$x.ParentProcessId};$r|ConvertTo-Json -Compress`,stdout=``;try{stdout=execFileSync(`powershell.exe`,[`-NoProfile`,`-NonInteractive`,`-Command`,script],{encoding:`utf8`,timeout:WIN32_PS_TIMEOUT_MS,stdio:[`ignore`,`pipe`,`ignore`]}).trim()}catch{return null}if(stdout.length===0)return[];let parsed;try{parsed=JSON.parse(stdout)}catch{return null}let list=Array.isArray(parsed)?parsed:isPlainObject(parsed)?[parsed]:[],samples=[];for(let item of list){if(!isPlainObject(item))continue;let pid=isFiniteNum(item.pid)?Math.trunc(item.pid):0,ppid=isFiniteNum(item.ppid)?Math.trunc(item.ppid):0;pid<=0||samples.push({pid,ppid,comm:typeof item.comm==`string`?item.comm:``,args:typeof item.args==`string`?item.args:``})}return samples}function matchSample(sample){let extracted=extractAgyTokens(sample.tokens??splitShellTokens(sample.args),sample.comm);return extracted===null?null:{agyPid:sample.pid,bypass:extracted.bypass,cliMode:extracted.cliMode}}function walkAncestors(options){let platform=options.platform??process.platform,startPid=options.startPid??process.ppid;if(!Number.isInteger(startPid)||startPid<=1)return{agyPid:null,bypass:!1,cliMode:``};if(platform===`win32`){let samples=(options.readWin32Ancestors??readWin32AncestorsViaPowerShell)(startPid);if(!samples)return{agyPid:null,bypass:!1,cliMode:``};let limit=Math.min(samples.length,MAX_ANCESTOR_HOPS);for(let i=0;i<limit;i+=1){let sample=samples[i];if(!sample)continue;let matched=matchSample(sample);if(matched!==null)return matched}return{agyPid:null,bypass:!1,cliMode:``}}let reader=options.readProc??(platform===`linux`?readLinuxProcSample:readPosixPsSample),pid=startPid,visited=new Set;for(let hop=0;hop<MAX_ANCESTOR_HOPS&&!(pid<=1||visited.has(pid));hop+=1){visited.add(pid);let sample=reader(pid);if(sample===null)break;let matched=matchSample(sample);if(matched!==null)return matched;pid=sample.ppid}return{agyPid:null,bypass:!1,cliMode:``}}function findAncestorAgyPid(options={}){let checkAlive=options.isAlive??isPidAlive,found=walkAncestors(options);return found.agyPid!==null&&checkAlive(found.agyPid)?found.agyPid:null}var MAX_TARGET_LEN=20,SKILL_HEAD_MAX_BYTES=512,SKILL_PATH_RE=/^(.*?\/skills\/([^/]+))\/(?:SKILL\.md$|references\/)/,INVOKED_SKILL_RE=/<SKILL>The user has explicitly invoked the \(([^)\n]+)\) skill/g,USER_REQ_RE=/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/,FRONTMATTER_NAME_RE=/^name:\s*['"]?([^'"\n]+)['"]?\s*$/m,SLASH_CMD_NAME_RE=/^[a-z0-9_-]+$/,RUNNING_STEP_STATUSES=new Set([`RUNNING`,`PENDING`,`IN_PROGRESS`,`GENERATING`,`WAITING`]),BUILTIN_SLASH_CMDS=new Set(`agent.agents.boost.branch.browser.clear.compact.config.context.conversation.cost.credits.diff.effort.exit.feedback.fork.goal.grill-me.help.hooks.init.keybindings.learn.login.logout.mcp.model.models.open.permissions.plan.plugin.plugins.quit.quota.remote-control.rename.resume.review.rewind.schedule.settings.skills.statusline.swarm.switch.tasks.teamwork.undo.usage.vim`.split(`.`)),FILE_TOOL_NAMES=new Set([`read_file`,`view_file`,`write_file`,`edit_file`,`replace_file_content`,`multi_replace_file_content`,`view_file_outline`,`view_code_item`]);function sanitizeFullTarget(text){return sanitizeTerminalLabel(text)}function unwrapArg(val){if(typeof val==`string`){let stripped=val.trim();if(stripped.length>=2&&stripped.startsWith(`"`)&&stripped.endsWith(`"`))try{let decoded=JSON.parse(stripped);if(typeof decoded==`string`)return decoded}catch{return stripped.slice(1,-1)}return val}return val==null?``:typeof val==`number`||typeof val==`boolean`||typeof val==`bigint`?String(val):JSON.stringify(val)}function shortenTarget(text,maxLen=MAX_TARGET_LEN){let clean=sanitizeTerminalText(text).replaceAll(`\\`,`/`).trim();if(clean.length===0)return``;if(clean.includes(`/`)){let parts=clean.replace(/\/+$/,``).split(`/`),tail=parts[parts.length-1];tail!==void 0&&tail.length>0&&(clean=tail)}return clean.length<=maxLen?clean:`${clean.slice(0,maxLen-1)}…`}function cleanMcpServerName(raw){let clean=sanitizeTerminalLabel(raw),idx=clean.lastIndexOf(`_`);if(idx>0){let prefix=clean.slice(0,idx),suffix=clean.slice(idx+1);if(prefix===suffix||prefix.endsWith(`-${suffix}`))return prefix}return clean}function listMcpServers(cliHome){let mcpDir=resolveTrustedCliDir(cliHome,`mcp`);if(mcpDir===null)return[];try{return readdirSync(mcpDir,{withFileTypes:!0}).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()).map(entry=>entry.name).sort((a,b)=>b.length-a.length)}catch{return[]}}function buildMcpToolPair(rawServer,rawSubtool){let srv=cleanMcpServerName(rawServer),sub=sanitizeTerminalLabel(rawSubtool);return srv.length>0&&sub.length>0?[srv,sub]:null}function parseMcpTool(toolName,args,mcpServers=[]){if((toolName===`call_mcp_tool`||toolName===`list_resources`||toolName===`read_resource`)&&args){let rawSrv=unwrapArg(args.ServerName??args.server_name),rawSub=sanitizeTerminalLabel(unwrapArg(args.ToolName??args.tool_name??args.Uri??toolName));return buildMcpToolPair(rawSrv,rawSub.length>0?rawSub:toolName)}if(toolName.startsWith(`mcp:`)){let parts=toolName.split(`:`,3);if(parts.length===3&&parts[1]&&parts[2]!==void 0)return buildMcpToolPair(parts[1],parts[2])}if(toolName.startsWith(`mcp__`)){let parts=toolName.split(`__`,3);if(parts.length===3&&parts[1]&&parts[2]!==void 0)return buildMcpToolPair(parts[1],parts[2])}if(toolName.startsWith(`mcp_`)){let rest=toolName.slice(4);for(let srv of mcpServers)if(rest.startsWith(`${srv}_`)&&rest.length>srv.length+1)return buildMcpToolPair(srv,rest.slice(srv.length+1));let idx=rest.indexOf(`_`);if(idx>0&&idx+1<rest.length)return buildMcpToolPair(rest.slice(0,idx),rest.slice(idx+1))}return null}function readFileHeadUtf8(filePath,maxBytes){let fd=openSync(filePath,`r`);try{let buf=Buffer.allocUnsafe(maxBytes),bytesRead=readSync(fd,buf,0,maxBytes,0);return bytesRead>0?buf.subarray(0,bytesRead).toString(`utf8`):``}finally{closeSync(fd)}}function resolveSkillName(pathStr,cliHome,workspaceDir){let match=SKILL_PATH_RE.exec(pathStr.replaceAll(`\\`,`/`));if(!match?.[1]||!match[2])return null;let skillDir=match[1],folderName=sanitizeTerminalLabel(match[2]),fallback=folderName.length>0?folderName:null;if(cliHome===void 0)return fallback;let safeSkillFile=resolveSafeSkillFile(cliHome,path.join(skillDir,`SKILL.md`),workspaceDir);if(safeSkillFile===null)return fallback;try{let head=readFileHeadUtf8(safeSkillFile,SKILL_HEAD_MAX_BYTES);if(head.startsWith(`---`)){let endIdx=head.indexOf(`
---`,3),block=endIdx===-1?head:head.slice(0,endIdx),nameMatch=FRONTMATTER_NAME_RE.exec(block);if(nameMatch?.[1]){let cleanName=sanitizeTerminalLabel(nameMatch[1]);if(cleanName.length>0)return cleanName}}}catch{}return fallback}function extractToolTarget(name,args){if(!args)return``;if(FILE_TOOL_NAMES.has(name))for(let key of[`Path`,`AbsolutePath`,`TargetFile`,`path`]){let val=unwrapArg(args[key]);if(val.length>0)return val}if(name===`run_command`){let cmd=unwrapArg(args.CommandLine??args.command),summary=unwrapArg(args.toolSummary);if(cmd.includes(`
`)&&summary.length>0)return summary;let firstLine=cmd.split(/\r?\n/,1)[0]??``;return firstLine.length>0?firstLine:summary}if(name===`search_web`)return unwrapArg(args.query);if(name===`invoke_subagent`||name===`define_subagent`)return unwrapArg(args.Role??args.TypeName??args.Name);if(name.startsWith(`mcp`)||name===`call_mcp_tool`||name===`read_resource`)for(let key of[`toolSummary`,`Path`,`path`,`url`,`Uri`,`query`]){let val=unwrapArg(args[key]);if(val.length>0)return val}return``}function extractUserInputSkills(content){let found=[];INVOKED_SKILL_RE.lastIndex=0;let match=INVOKED_SKILL_RE.exec(content);for(;match!==null;){if(match[1]){let cleaned=sanitizeTerminalLabel(match[1]);cleaned.length>0&&found.push(cleaned)}match=INVOKED_SKILL_RE.exec(content)}let body=(USER_REQ_RE.exec(content)?.[1]??content).trim();if(body.startsWith(`/`)){let cmd=(body.slice(1).split(/\s+/,1)[0]??``).trim().toLowerCase();cmd.length>0&&!BUILTIN_SLASH_CMDS.has(cmd)&&SLASH_CMD_NAME_RE.test(cmd)&&found.push(cmd)}return found}var HASH_CHUNK_BYTES=65536,SAMPLE_WINDOW_BYTES=8192;function hashSampledSlices(endOffset,readSlice){let hash=createHash(`sha256`);hash.update(`len:${endOffset}|`);let midStart=Math.max(0,Math.floor((endOffset-SAMPLE_WINDOW_BYTES)/2)),tailStart=Math.max(0,endOffset-SAMPLE_WINDOW_BYTES);return hash.update(readSlice(0,Math.min(SAMPLE_WINDOW_BYTES,endOffset))),hash.update(`|`),hash.update(readSlice(midStart,Math.min(SAMPLE_WINDOW_BYTES,endOffset-midStart))),hash.update(`|`),hash.update(readSlice(tailStart,Math.min(SAMPLE_WINDOW_BYTES,endOffset-tailStart))),`sample:${hash.digest(`hex`).slice(0,24)}`}function computeFullFdRangeHash(fd,endOffset){if(endOffset<=0)return{digest:`empty`,fullHash:null};let hash=createHash(`sha256`),buf=Buffer.allocUnsafe(Math.min(endOffset,HASH_CHUNK_BYTES)),pos=0;for(;pos<endOffset;){let toRead=Math.min(buf.length,endOffset-pos),bytesRead=readSync(fd,buf,0,toRead,pos);if(bytesRead<=0)break;hash.update(bytesRead===buf.length?buf:buf.subarray(0,bytesRead)),pos+=bytesRead}return{digest:`full:${hash.copy().digest(`hex`).slice(0,24)}`,fullHash:hash}}function computeFdRangeFingerprint(fd,endOffset){return endOffset<=0?{digest:`empty`,fullHash:null}:endOffset>524288?{digest:hashSampledSlices(endOffset,(off,len)=>readFdRange(fd,off,len)),fullHash:null}:computeFullFdRangeHash(fd,endOffset)}function readCombinedRange(fd,startOffset,chunkBuf,offset,length){if(length<=0)return Buffer.alloc(0);if(offset>=startOffset){let rel=offset-startOffset;return chunkBuf.subarray(rel,Math.min(chunkBuf.length,rel+length))}let end=offset+length;if(end<=startOffset)return readFdRange(fd,offset,length);let headPart=readFdRange(fd,offset,startOffset-offset),tailPart=chunkBuf.subarray(0,Math.min(chunkBuf.length,end-startOffset));return Buffer.concat([headPart,tailPart])}function computeFullParsedRangeHash(fd,startOffset,chunkBuf,endOffset,prefixHash){if(endOffset<=0)return`empty`;if(startOffset===0)return`full:${createHash(`sha256`).update(chunkBuf.subarray(0,endOffset)).digest(`hex`).slice(0,24)}`;if(prefixHash!==null)return`full:${prefixHash.copy().update(chunkBuf.subarray(0,Math.max(0,endOffset-startOffset))).digest(`hex`).slice(0,24)}`;let base=computeFullFdRangeHash(fd,startOffset).fullHash??createHash(`sha256`);return base.update(chunkBuf.subarray(0,Math.max(0,endOffset-startOffset))),`full:${base.digest(`hex`).slice(0,24)}`}function computeParsedRangeFingerprint(fd,startOffset,chunkBuf,endOffset,prefixHash){return endOffset<=0?`empty`:endOffset>524288?hashSampledSlices(endOffset,(off,len)=>readCombinedRange(fd,startOffset,chunkBuf,off,len)):computeFullParsedRangeHash(fd,startOffset,chunkBuf,endOffset,prefixHash)}function computeFileContentHash(filePath){let fd;try{fd=openSync(filePath,`r`)}catch{return``}try{let st=fstatSync(fd,{bigint:!0});if(!st.isFile())return``;let size=Number(st.size),{digest}=computeFdRangeFingerprint(fd,size);return size<=524288?digest:`${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${digest}`}catch{return``}finally{closeSync(fd)}}var TAIL_READ_BYTES=16384,MAX_AGENT_LABEL_LEN=28,WORKING_STATES=new Set([``,`RUNNING`,`WORKING`,`INITIALIZING`,`MERGING`,`PENDING`,`IN_PROGRESS`,`EXECUTING`]),WAITING_STATES=new Set([`WAITING`,`IDLE`,`PAUSED`,`SLEEPING`]);function classifyStatus(rawStatus){let status=typeof rawStatus==`string`?rawStatus.trim().toUpperCase():``;return WORKING_STATES.has(status)?`working`:WAITING_STATES.has(status)?`waiting`:`done`}function cleanAgentLabel(rawName,rawRole,rawType=``){let strip=val=>typeof val==`string`?sanitizeTerminalText(val.trim().split(/\r?\n/,1)[0]??``).trim().replace(/^[` ]+|[` ]+$/g,``):``,name=strip(rawName),role=strip(rawRole),agentType=strip(rawType),chosen;return chosen=role.length>0&&role.length<=MAX_AGENT_LABEL_LEN?role:name.length>0&&name.length<=MAX_AGENT_LABEL_LEN?name:role.length>0?role:name.length>0?name:agentType.length>0?agentType:`subagent`,chosen.length>MAX_AGENT_LABEL_LEN?`${chosen.slice(0,27).trimEnd()}…`:chosen}function readTailLines(filePath,maxBytes=TAIL_READ_BYTES){let rawBuf,start=0;try{let fd=openSync(filePath,`r`);try{let size=fstatSync(fd).size;if(size<=0)return[];start=Math.max(0,size-maxBytes);let len=size-start;rawBuf=Buffer.allocUnsafe(len);let readPos=0;for(;readPos<len;){let bytesRead=readSync(fd,rawBuf,readPos,len-readPos,start+readPos);if(bytesRead<=0)break;readPos+=bytesRead}readPos<len&&(rawBuf=rawBuf.subarray(0,readPos))}finally{closeSync(fd)}}catch{return[]}let lines=rawBuf.toString(`utf8`).split(/\r?\n/);return start>0&&lines.length>0&&(lines=lines.slice(1)),lines.filter(line=>line.trim().length>0)}function transcriptTurnEnded(lines){let results=[];for(let i=lines.length-1;i>=0;--i){let raw=lines[i];if(raw===void 0)continue;let step;try{step=JSON.parse(raw)}catch{return!1}if(!isPlainObject(step))return!1;if(step.type===`GENERIC`){results.unshift(step);continue}if(step.type!==`PLANNER_RESPONSE`)return!1;let calls=Array.isArray(step.tool_calls)?step.tool_calls:[];if(calls.length===0)return results.length===0;let waitIdx=calls.findIndex(tc=>isPlainObject(tc)&&tc.name===`swarm_wait`);if(waitIdx<0||results.length<calls.length)return!1;let waitResult=results[waitIdx];return(waitResult&&typeof waitResult.status==`string`?waitResult.status.toUpperCase():``)===`DONE`}return!1}function memberSwarmState(cliHome,member){let convId=sanitizeSessionId(nonEmptyStr(member.conversation_id));if(convId!==null){let tpath=resolveCliSubdirFile(cliHome,`brain`,convId,`.system_generated`,`logs`,`transcript.jsonl`);if(tpath!==null&&existsSync(tpath)){let tail=readTailLines(tpath);if(tail.length>0)return transcriptTurnEnded(tail)?`waiting`:`working`}}let wakeMode=typeof member.wake_mode==`string`?member.wake_mode.trim().toLowerCase():``;return wakeMode===`mentions`||wakeMode===`anything`?`waiting`:`working`}function loadSwarmEntries(cliHome,data){let convId=resolveConversationId(data);if(convId===null)return null;let rosterPath=resolveCliSubdirFile(cliHome,`brain`,convId,`.system_generated`,`swarm`,`members.json`);if(rosterPath===null||!existsSync(rosterPath))return null;let roster;try{roster=JSON.parse(readFileSync(rosterPath,`utf8`))}catch{return null}if(!isPlainObject(roster)||!isPlainObject(roster.members))return null;let entries=[];for(let[name,member]of Object.entries(roster.members)){if(!isPlainObject(member))continue;let cleanName=sanitizeTerminalLabel(name),role=typeof member.role==`string`?sanitizeTerminalLabel(member.role).toLowerCase():``;if(cleanName.length===0||cleanName===`coordinator`||role===`coordinator`)continue;let isKilled=member.killed===!0,stoppedTs=isKilled?parseIsoTimestampSec(member.killed_at??member.stopped_at):null;entries.push({name:cleanName,type:role.length>0&&role!==`worker`?role:``,model:typeof member.model==`string`?sanitizeTerminalLabel(member.model):``,state:isKilled?`done`:memberSwarmState(cliHome,member),ts:stoppedTs})}return entries}function computeSwarmStateDigest(dataRoot,safeId){let rosterPath=resolveCliSubdirFile(dataRoot,`brain`,safeId,`.system_generated`,`swarm`,`members.json`);if(rosterPath===null)return``;let rosterHash=computeFileContentHash(rosterPath);if(rosterHash.length===0)return``;let parts=[rosterHash],roster=readRegularJsonObjectSync(rosterPath);if(roster!==null&&isPlainObject(roster.members)){let memberNames=Object.keys(roster.members).sort();for(let name of memberNames){let member=roster.members[name];if(!isPlainObject(member))continue;let role=typeof member.role==`string`?member.role.trim().toLowerCase():``;if(name===`coordinator`||role===`coordinator`||member.killed===!0)continue;let memberConvId=sanitizeSessionId(nonEmptyStr(member.conversation_id));if(memberConvId===null)continue;let workerTranscript=resolveCliSubdirFile(dataRoot,`brain`,memberConvId,`.system_generated`,`logs`,`transcript.jsonl`),workerHash=workerTranscript===null?``:computeFileContentHash(workerTranscript);parts.push(`${name}:${memberConvId}:${workerHash}`)}}return createHash(`sha256`).update(parts.join(`\0`)).digest(`hex`).slice(0,24)}function parseStdinSubagents(stdinSubagents){if(!Array.isArray(stdinSubagents))return[];let entries=[];for(let sa of stdinSubagents){if(!isPlainObject(sa))continue;let rawName=typeof sa.name==`string`?sanitizeTerminalLabel(sa.name):``,rawRole=typeof sa.role==`string`?sanitizeTerminalLabel(sa.role):``,rawType=typeof sa.type_name==`string`?sanitizeTerminalLabel(sa.type_name):``,label=cleanAgentLabel(rawName,rawRole,rawType);entries.push({name:label,key:rawName.toLowerCase(),altKey:label.toLowerCase(),type:rawType,model:typeof sa.model==`string`?sanitizeTerminalLabel(sa.model):``,state:classifyStatus(sa.status??sa.state),ts:null})}return entries}function syncSwarmFromStdin(swarmEntries,stdinEntries){let byName=new Map;for(let entry of swarmEntries)byName.set(entry.name.toLowerCase(),entry);for(let sa of stdinEntries){let target=byName.get(sa.key)??byName.get(sa.altKey);target&&target.state!==`done`&&((sa.state===`working`||sa.state===`waiting`)&&(target.state=sa.state),sa.model.length>0&&target.model.length===0&&(target.model=sa.model))}return swarmEntries}function convertActivityAgents(activityAgents){return activityAgents?activityAgents.map(agent=>({name:cleanAgentLabel(agent.name,``,agent.type),type:sanitizeTerminalLabel(agent.type),model:sanitizeTerminalLabel(agent.model),state:agent.running?`working`:`done`,ts:agent.ts})):[]}function collectAgentsSummary(cliHome,data,activityAgents){let swarmEntries=loadSwarmEntries(cliHome,data),stdinEntries=parseStdinSubagents(data.subagents),entries,kind;swarmEntries===null?stdinEntries.length>0?(entries=stdinEntries.map(({name,type,model,state,ts})=>({name,type,model,state,ts})),kind=`agents`):(entries=convertActivityAgents(activityAgents),kind=`agents`):(entries=syncSwarmFromStdin(swarmEntries,stdinEntries),kind=`swarm`);let working=0,waiting=0;for(let entry of entries)entry.state===`working`?working+=1:entry.state===`waiting`&&(waiting+=1);let alive=working+waiting;return{kind,working,waiting,alive,total:kind===`swarm`?alive:entries.length,entries}}var SQLITE_TIMEOUT_MS=50,WAL_COPY_MAX_ATTEMPTS=4,TEMP_FILE_MODE=384,SQLITE_HEADER_BYTES=100,WAL_HEADER_BYTES=32,WAL_TAIL_BYTES=32,requireModule=createRequire(import.meta.url),cachedSqlite;function getSqliteModule(){if(cachedSqlite!==void 0)return cachedSqlite;try{cachedSqlite=requireModule(`node:sqlite`)}catch{cachedSqlite=null}return cachedSqlite}function closeDbQuietly(db){if(db!==null)try{db.close()}catch{}}function makeTempWritable(filePath){if(process.platform!==`win32`)try{chmodSync(filePath,TEMP_FILE_MODE)}catch{}}function readExactHex(fd,offset,length){return readFdRange(fd,offset,length).toString(`hex`)}function captureFileVersion(filePath,headBytes,tailBytes){let lst;try{lst=lstatSync(filePath,{bigint:!0})}catch{return null}if(lst.isSymbolicLink()||!lst.isFile())return null;let fd;try{fd=openSync(filePath,`r`)}catch{return null}try{let st=fstatSync(fd,{bigint:!0});if(!st.isFile()||st.ino!==lst.ino)return null;let sizeNum=Number(st.size),headHex=readExactHex(fd,0,Math.min(sizeNum,headBytes)),tailHex=``;if(tailBytes>0&&sizeNum>0){let tailLen=Math.min(sizeNum,tailBytes);tailHex=readExactHex(fd,Math.max(0,sizeNum-tailLen),tailLen)}return{ino:st.ino,size:st.size,mtimeNs:st.mtimeNs,ctimeNs:st.ctimeNs,headHex,tailHex}}catch{return null}finally{closeSync(fd)}}function captureWalPairSnapshot(dbPath,walPath){return{db:captureFileVersion(dbPath,SQLITE_HEADER_BYTES,0),wal:captureFileVersion(walPath,WAL_HEADER_BYTES,WAL_TAIL_BYTES)}}function isFileVersionEqual(a,b){return a===null||b===null?a===b:a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.headHex===b.headHex&&a.tailHex===b.tailHex}function isWalPairSnapshotEqual(a,b){return isFileVersionEqual(a.db,b.db)&&isFileVersionEqual(a.wal,b.wal)}function isRegularNonSymlinkFile(filePath){let st;try{st=lstatIfPresentSync(filePath)}catch{return!1}return st!==null&&!st.isSymbolicLink()&&st.isFile()}function hasUnsafeSqliteSidecar(dbPath){for(let suffix of[`-wal`,`-shm`]){let st;try{st=lstatIfPresentSync(`${dbPath}${suffix}`)}catch{return!0}if(st!==null&&(st.isSymbolicLink()||!st.isFile()))return!0}return!1}function readSqliteVersionTag(dbPath){if(!isRegularNonSymlinkFile(dbPath)||hasUnsafeSqliteSidecar(dbPath))return``;let pair=captureWalPairSnapshot(dbPath,`${dbPath}-wal`);if(pair.db===null&&pair.wal===null)return``;let fmt=snap=>snap===null?`none`:`${snap.ino}:${snap.size}:${snap.mtimeNs}:${snap.ctimeNs}:${snap.headHex}:${snap.tailHex}`;return createHash(`sha256`).update(`${fmt(pair.db)}|${fmt(pair.wal)}`).digest(`hex`).slice(0,24)}function openImmutableDb(dbPath){let sqlite=getSqliteModule();if(sqlite===null)return null;let uri=`${pathToFileURL(dbPath).href}?immutable=1`,db=null;try{return db=new sqlite.DatabaseSync(uri,{readOnly:!0,timeout:SQLITE_TIMEOUT_MS}),db.prepare(`PRAGMA schema_version`).get(),db}catch{return closeDbQuietly(db),null}}function hasActiveWalFile(dbPath){try{let walStat=lstatIfPresentSync(`${dbPath}-wal`);return walStat!==null&&!walStat.isSymbolicLink()&&walStat.isFile()&&walStat.size>0}catch{return!1}}function readViaTempWalSnapshot(dbPath,reader,options){let sqlite=getSqliteModule();if(sqlite===null)return{status:`failed`};let walPath=`${dbPath}-wal`,maxAttempts=Math.max(1,options?.maxAttempts??WAL_COPY_MAX_ATTEMPTS);for(let attempt=0;attempt<maxAttempts;attempt+=1){let before=captureWalPairSnapshot(dbPath,walPath);if(before.db===null)return{status:`failed`};if(before.wal===null||before.wal.size===0n)return{status:`no-wal`};let tmpDir=``,db=null;try{tmpDir=mkdtempSync(path.join(os.tmpdir(),`agy-hud-rodb-`));let tmpDbPath=path.join(tmpDir,`snapshot.db`),tmpWalPath=`${tmpDbPath}-wal`;if(copyFileSync(dbPath,tmpDbPath),makeTempWritable(tmpDbPath),options?.onAfterMainCopy?.(attempt),copyFileSync(walPath,tmpWalPath),makeTempWritable(tmpWalPath),!isWalPairSnapshotEqual(before,captureWalPairSnapshot(dbPath,walPath)))continue;let tmpDbStat=lstatIfPresentSync(tmpDbPath),tmpWalStat=lstatIfPresentSync(tmpWalPath);if(tmpDbStat===null||tmpWalStat===null||BigInt(tmpDbStat.size)!==before.db.size||BigInt(tmpWalStat.size)!==before.wal.size)continue;return db=new sqlite.DatabaseSync(tmpDbPath,{timeout:SQLITE_TIMEOUT_MS}),db.prepare(`PRAGMA schema_version`).get(),{status:`ok`,value:reader(db)}}catch{}finally{if(closeDbQuietly(db),tmpDir.length>0)try{rmSync(tmpDir,{recursive:!0,force:!0})}catch{}}}return{status:`failed`}}function withReadonlyDb(dbPath,reader,options){if(!isRegularNonSymlinkFile(dbPath)||hasUnsafeSqliteSidecar(dbPath))return null;if(hasActiveWalFile(dbPath)){let snap=readViaTempWalSnapshot(dbPath,reader,options);if(snap.status===`ok`)return snap.value;if(snap.status===`failed`&&hasActiveWalFile(dbPath))return null}let db=openImmutableDb(dbPath);if(db===null)return null;try{return reader(db)}catch{return null}finally{closeDbQuietly(db)}}var SUMMARY_QUERY_LIMIT=100,MAX_SUMMARY_DB_CACHE_ENTRIES=8,summaryDbCache=new Map;function parseWorkspaceUris(raw){if(typeof raw!=`string`||raw.trim().length===0)return[];try{let parsed=JSON.parse(raw);if(!Array.isArray(parsed))return[];let results=[];for(let item of parsed)if(typeof item==`string`&&item.trim().length!==0){if(item.startsWith(`file://`))try{results.push(fileURLToPath(item))}catch{}else results.push(item)}return results}catch{return[]}}function parseSummaryTimestampMs(raw){if(isFiniteNum(raw)&&raw>0)return raw<1e12?raw*1e3:raw;if(typeof raw==`string`&&raw.trim().length>0){let ms=Date.parse(raw);return Number.isFinite(ms)?ms:0}return 0}function loadSummaryDbSnapshot(rootDir){let dbPath=path.join(rootDir,`conversation_summaries.db`);if(!existsSync(dbPath))return null;let versionTag=readSqliteVersionTag(dbPath);if(versionTag.length>0){let hit=summaryDbCache.get(dbPath);if(hit?.versionTag===versionTag)return hit}let loaded=withReadonlyDb(dbPath,db=>{let excluded=[],excludedRows=db.prepare(`SELECT conversation_id FROM conversation_summaries WHERE nesting_depth != 0 OR killed != 0`).all();for(let row of excludedRows){if(!isPlainObject(row)||typeof row.conversation_id!=`string`)continue;let safe=sanitizeSessionId(row.conversation_id);safe!==null&&excluded.push(safe)}let parsedRows=[],rows=db.prepare(`SELECT conversation_id, title, last_modified_time, workspace_uris, source, not_fully_idle, status
         FROM conversation_summaries
         WHERE nesting_depth = 0 AND killed = 0
         ORDER BY last_modified_time DESC
         LIMIT ${SUMMARY_QUERY_LIMIT}`).all();for(let row of rows){if(!isPlainObject(row)||typeof row.conversation_id!=`string`)continue;let safeId=sanitizeSessionId(row.conversation_id);safeId!==null&&parsedRows.push({safeId,source:typeof row.source==`string`?row.source:``,title:typeof row.title==`string`?sanitizeTerminalLabel(row.title):``,summaryMs:parseSummaryTimestampMs(row.last_modified_time),isRunning:row.not_fully_idle===1||row.status===`CASCADE_RUN_STATUS_RUNNING`,workspaces:parseWorkspaceUris(row.workspace_uris)})}return{versionTag,excludedIds:excluded,rows:parsedRows}});if(loaded!==null&&versionTag.length>0){if(!summaryDbCache.has(dbPath)&&summaryDbCache.size>=MAX_SUMMARY_DB_CACHE_ENTRIES){let oldestKey=summaryDbCache.keys().next().value;oldestKey!==void 0&&summaryDbCache.delete(oldestKey)}summaryDbCache.set(dbPath,loaded)}return loaded}function parseSnapshotCostRecord(raw){if(!isPlainObject(raw)||!isFiniteNum(raw.totalUsd)||raw.totalUsd<0)return null;let subagentUsd=raw.subagentUsd===null||raw.subagentUsd===void 0?null:isFiniteNum(raw.subagentUsd)&&raw.subagentUsd>=0?raw.subagentUsd:null;return{totalUsd:raw.totalUsd,subagentUsd,estimated:raw.estimated===!0}}var MAX_MARKER_FUTURE_SKEW_MS=3e5;function resolvePidMarkerPath(cliHome,agyPid){return resolveCliSubdirFile(cliHome,`cache`,`agy_hud_pid_${agyPid}.json`)}function parsePidSwitchSeq(raw){return raw===void 0?0:typeof raw!=`number`||!Number.isSafeInteger(raw)||raw<0||raw>=1e9?null:raw}function normalizeNowMs(nowMs){return isFiniteNum(nowMs)&&nowMs>0?Math.trunc(nowMs):Date.now()}function readActivePidMarker(cliHome,agyPid,nowMs=Date.now()){let markerPath=resolvePidMarkerPath(cliHome,agyPid);if(markerPath===null)return null;let raw=readRegularJsonObjectSync(markerPath);if(raw===null||typeof raw.convId!=`string`||typeof raw.heartbeatAtMs!=`number`)return null;let safeNowMs=normalizeNowMs(nowMs);if(!Number.isSafeInteger(raw.heartbeatAtMs)||raw.heartbeatAtMs<=0||raw.heartbeatAtMs>safeNowMs+3e5)return null;let switchSeq=parsePidSwitchSeq(raw.switchSeq);if(switchSeq===null)return null;let safeId=sanitizeSessionId(raw.convId);return safeId===null?null:{convId:safeId,heartbeatAtMs:raw.heartbeatAtMs,switchSeq}}function resolveLivePidOwners(cliHome,candidates,nowMs,checkAlive){let safeNowMs=normalizeNowMs(nowMs),maxAllowedHeartbeatMs=safeNowMs+MAX_MARKER_FUTURE_SKEW_MS,byConvId=new Map,newestByLivePid=new Map;for(let acc of candidates){if(byConvId.set(acc.convId,acc),acc.surface!==`cli`||acc.envelope===null||acc.envelope.agyPid===null||acc.envelope.heartbeatAtMs>maxAllowedHeartbeatMs)continue;let pid=acc.envelope.agyPid;if(!checkAlive(pid))continue;let cur=newestByLivePid.get(pid),seq=acc.envelope.pidSwitchSeq??0;(!cur||seq>cur.pidSwitchSeq||seq===cur.pidSwitchSeq&&(acc.envelope.heartbeatAtMs===cur.heartbeatAtMs?acc.envelope.updatedAtMs>cur.updatedAtMs:acc.envelope.heartbeatAtMs>cur.heartbeatAtMs))&&newestByLivePid.set(pid,{convId:acc.convId,heartbeatAtMs:acc.envelope.heartbeatAtMs,updatedAtMs:acc.envelope.updatedAtMs,pidSwitchSeq:seq})}for(let[pid,cur]of newestByLivePid){let marker=readActivePidMarker(cliHome,pid,safeNowMs);if(marker===null||marker.convId===cur.convId)continue;let marked=byConvId.get(marker.convId),markerWins=marker.switchSeq>cur.pidSwitchSeq||marker.switchSeq===cur.pidSwitchSeq&&marker.heartbeatAtMs>=cur.heartbeatAtMs;marked&&marked.surface===`cli`&&marked.envelope?.agyPid===pid&&marked.envelope.heartbeatAtMs<=maxAllowedHeartbeatMs&&markerWins&&newestByLivePid.set(pid,{convId:marked.convId,heartbeatAtMs:Math.max(marked.envelope.heartbeatAtMs,marker.heartbeatAtMs),updatedAtMs:marked.envelope.updatedAtMs,pidSwitchSeq:Math.max(marked.envelope.pidSwitchSeq??0,marker.switchSeq)})}let owners=new Map;for(let[pid,info]of newestByLivePid)owners.set(pid,info.convId);return owners}var ENVELOPE_VERSION=1,MAX_ENVELOPE_SUBAGENTS=128;function isExitedCliProcess(surface,envPid,livePid){return surface===`cli`&&envPid!==null&&livePid===null}function isExitedCliSession(session){return isExitedCliProcess(session.surface,session.envelope?.agyPid??null,session.livePid)}function parseEnvelopeSubagents(raw){if(!Array.isArray(raw))return[];let items=[];for(let item of raw){if(items.length>=MAX_ENVELOPE_SUBAGENTS)break;isPlainObject(item)&&items.push(item)}return items}function parseEnvelopeRecord(raw){if(raw.v!==ENVELOPE_VERSION)return null;let convId=typeof raw.convId==`string`?sanitizeSessionId(raw.convId):null;if(convId===null)return null;let agyPid=raw.agyPid===null?null:typeof raw.agyPid==`number`&&Number.isSafeInteger(raw.agyPid)&&raw.agyPid>1?raw.agyPid:null,taskCount=raw.taskCount===null?null:isFiniteNum(raw.taskCount)&&Number.isInteger(raw.taskCount)&&raw.taskCount>=0?raw.taskCount:null,mdDigest=typeof raw.mdDigest==`string`?raw.mdDigest:null,cost=parseSnapshotCostRecord(raw.cost),updatedAtMs=typeof raw.updatedAtMs==`number`&&Number.isSafeInteger(raw.updatedAtMs)&&raw.updatedAtMs>=0?raw.updatedAtMs:0,heartbeatAtMs=typeof raw.heartbeatAtMs==`number`&&Number.isSafeInteger(raw.heartbeatAtMs)&&raw.heartbeatAtMs>=0?raw.heartbeatAtMs:updatedAtMs,pidSwitchSeq=parsePidSwitchSeq(raw.pidSwitchSeq)??0;return{v:ENVELOPE_VERSION,convId,conversationTitle:typeof raw.conversationTitle==`string`?sanitizeTerminalLabel(raw.conversationTitle):``,agyPid,cwd:typeof raw.cwd==`string`?raw.cwd:``,workspaceCurrentDir:typeof raw.workspaceCurrentDir==`string`?raw.workspaceCurrentDir:``,workspaceProjectDir:typeof raw.workspaceProjectDir==`string`?raw.workspaceProjectDir:``,subagents:parseEnvelopeSubagents(raw.subagents),taskCount,...cost===null?{}:{cost},mdDigest,updatedAtMs,heartbeatAtMs,...pidSwitchSeq>0?{pidSwitchSeq}:{}}}var ENVELOPE_FILE_RE=/^agy_hud_snapshot_(.+)\.json$/,ACTIVE_SUBAGENT_STATUSES=new Set([`running`,`working`,`in_progress`,`active`,`waiting`,`pending`,`idle`]);function buildDataRoots(cliHome,geminiRoot){let roots=[{dir:cliHome,surface:`cli`}],appDir=path.join(geminiRoot,`antigravity`);existsSync(appDir)&&roots.push({dir:appDir,surface:`app`});let ideDir=path.join(geminiRoot,`antigravity-ide`);return existsSync(path.join(ideDir,`brain`))&&roots.push({dir:ideDir,surface:`ide`}),roots}function hasPhysicalSessionFiles(rootDir,convId){let brainDir=path.join(rootDir,`brain`,convId),dbFile=path.join(rootDir,`conversations`,`${convId}.db`);return existsSync(brainDir)||existsSync(dbFile)}function canonicalizeWorkspacePath(rawPath){let trimmed=rawPath.trim();return trimmed.length===0?``:realpathExistingPrefixSync(trimmed)}function addWorkspacePath(acc,rawPath){let canon=canonicalizeWorkspacePath(rawPath);if(canon.length===0)return;let key=toComparePath(canon);acc.workspacesSeen.has(key)||(acc.workspacesSeen.add(key),acc.workspaces.push(canon))}function resolvePhysicalOwner(convId,source,originRoot,roots){let cliRoot=roots.find(r=>r.surface===`cli`),appRoot=roots.find(r=>r.surface===`app`),ideRoot=roots.find(r=>r.surface===`ide`),ordered=[],seen=new Set,push=entry=>{entry&&!seen.has(entry.dir)&&(seen.add(entry.dir),ordered.push(entry))};source===`CORTEX_TRAJECTORY_SOURCE_CLI`?(push(cliRoot),push(originRoot),push(appRoot),push(ideRoot)):(push(originRoot),push(appRoot),push(cliRoot),push(ideRoot));for(let candidate of ordered)if(hasPhysicalSessionFiles(candidate.dir,convId))return candidate;return null}function probeTranscriptState(rootDir,convId){let tPath=resolveCliSubdirFile(rootDir,`brain`,convId,`.system_generated`,`logs`,`transcript.jsonl`);if(tPath!==null&&existsSync(tPath)){let st=statIfPresentSync(tPath),mtimeMs=st?.isFile()?st.mtimeMs:0,running=!1,tail=readTailLines(tPath,8192);for(let i=tail.length-1;i>=0;--i){let line=tail[i];if(!line)continue;let step;try{step=JSON.parse(line)}catch{continue}if(!isPlainObject(step)||step.type!==`PLANNER_RESPONSE`)continue;let status=typeof step.status==`string`?step.status.toUpperCase():``;running=RUNNING_STEP_STATUSES.has(status);break}return{mtimeMs,running}}let dbPath=resolveCliSubdirFile(rootDir,`conversations`,`${convId}.db`);if(dbPath!==null&&existsSync(dbPath)){let st=statIfPresentSync(dbPath);return{mtimeMs:st?.isFile()?st.mtimeMs:0,running:!1}}return{mtimeMs:0,running:!1}}function envelopeHasActiveSubagent(envelope){return envelope!==null&&envelope.subagents.some(sa=>{let raw=(sa.status??sa.state??``).trim().toLowerCase();return ACTIVE_SUBAGENT_STATUSES.has(raw)})}function scanSummaryDatabases(roots,candidates,excludedIds){for(let root of roots){let snap=loadSummaryDbSnapshot(root.dir);if(snap!==null){for(let safe of snap.excludedIds)excludedIds.add(safe),candidates.delete(safe);for(let row of snap.rows){if(excludedIds.has(row.safeId))continue;let owner=resolvePhysicalOwner(row.safeId,row.source,root,roots);if(owner===null)continue;let acc=candidates.get(row.safeId);acc?(row.title.length>0&&acc.title.length===0&&(acc.title=titleOrExisting(row.title,acc.title)),row.summaryMs>acc.summaryModifiedMs&&(acc.summaryModifiedMs=row.summaryMs),row.isRunning&&(acc.running=!0)):(acc={convId:row.safeId,surface:owner.surface,dataRoot:owner.dir,title:row.title,workspaces:[],workspacesSeen:new Set,running:row.isRunning,summaryModifiedMs:row.summaryMs,envelope:null},candidates.set(row.safeId,acc));for(let ws of row.workspaces)addWorkspacePath(acc,ws)}}}}function titleOrExisting(nextTitle,currentTitle){return currentTitle.length>0?currentTitle:nextTitle}function scanSnapshotEnvelopes(cliHome,candidates,excludedIds){let cacheDir=resolveTrustedCliDir(cliHome,`cache`);if(cacheDir===null)return;let entries;try{entries=readdirSync(cacheDir)}catch{return}for(let name of entries){if(!ENVELOPE_FILE_RE.test(name))continue;let raw=readRegularJsonObjectSync(path.join(cacheDir,name));if(raw===null)continue;let env=parseEnvelopeRecord(raw);if(env===null||excludedIds.has(env.convId))continue;let acc=candidates.get(env.convId);acc?acc.surface===`cli`&&((!acc.envelope||env.heartbeatAtMs>=acc.envelope.heartbeatAtMs)&&(acc.envelope=env),env.conversationTitle.length>0&&acc.title.length===0&&(acc.title=env.conversationTitle)):(acc={convId:env.convId,surface:`cli`,dataRoot:cliHome,title:env.conversationTitle,workspaces:[],workspacesSeen:new Set,running:!1,summaryModifiedMs:0,envelope:env},candidates.set(env.convId,acc)),acc.surface===`cli`&&(addWorkspacePath(acc,env.workspaceCurrentDir),addWorkspacePath(acc,env.workspaceProjectDir),addWorkspacePath(acc,env.cwd))}}function scanColdBrainDirectories(roots,candidates,excludedIds){for(let root of roots){let brainDir=resolveTrustedCliDir(root.dir,`brain`);if(brainDir===null)continue;let entries;try{entries=readdirSync(brainDir)}catch{continue}for(let name of entries){let safeId=sanitizeSessionId(name);if(safeId===null||candidates.has(safeId)||excludedIds.has(safeId))continue;let hasTranscript=existsSync(path.join(brainDir,safeId,`.system_generated`,`logs`,`transcript.jsonl`)),hasDb=existsSync(path.join(root.dir,`conversations`,`${safeId}.db`));(hasTranscript||hasDb)&&candidates.set(safeId,{convId:safeId,surface:root.surface,dataRoot:root.dir,title:``,workspaces:[],workspacesSeen:new Set,running:!1,summaryModifiedMs:0,envelope:null})}}}function scanColdConversationDbs(roots,candidates,excludedIds){for(let root of roots){let convDir=resolveTrustedCliDir(root.dir,`conversations`);if(convDir===null)continue;let entries;try{entries=readdirSync(convDir)}catch{continue}for(let name of entries){if(!name.endsWith(`.db`))continue;let safeId=sanitizeSessionId(name.slice(0,-3));if(safeId===null||candidates.has(safeId)||excludedIds.has(safeId))continue;let st=lstatIfPresentSync(path.join(convDir,name));st!==null&&!st.isSymbolicLink()&&st.isFile()&&candidates.set(safeId,{convId:safeId,surface:root.surface,dataRoot:root.dir,title:``,workspaces:[],workspacesSeen:new Set,running:!1,summaryModifiedMs:0,envelope:null})}}}function isLiveOrClientSession(s){return s.surface!==`cli`||s.livePid!==null||s.envelope===null||s.envelope.agyPid===null}function compareSessionsDefault(a,b){let liveDiff=+!!isLiveOrClientSession(b)-!!isLiveOrClientSession(a);if(liveDiff!==0)return liveDiff;let runDiff=+!!b.running-!!a.running;if(runDiff!==0)return runDiff;let timeDiff=b.updatedAtMs-a.updatedAtMs;return timeDiff===0?a.convId.localeCompare(b.convId):timeDiff}function discoverSessions(options={}){let env=options.env??process.env,nowMs=options.nowMs??Date.now(),checkAlive=options.isAlive??isPidAlive,{cliHome,geminiRoot}=resolveProfileRoots(options.cliHome,options.geminiRoot,env),roots=buildDataRoots(cliHome,geminiRoot),candidates=new Map,excludedIds=new Set;scanSummaryDatabases(roots,candidates,excludedIds),scanColdBrainDirectories(roots,candidates,excludedIds),scanColdConversationDbs(roots,candidates,excludedIds),scanSnapshotEnvelopes(cliHome,candidates,excludedIds);let livePidOwners=resolveLivePidOwners(cliHome,candidates.values(),nowMs,checkAlive),sessions=[];for(let acc of candidates.values()){let probe=probeTranscriptState(acc.dataRoot,acc.convId),envPid=acc.envelope?.agyPid??null,livePid=envPid!==null&&livePidOwners.get(envPid)===acc.convId?envPid:null,isExitedCli=isExitedCliProcess(acc.surface,envPid,livePid),updatedAtMs=Math.max(acc.envelope?.updatedAtMs??0,probe.mtimeMs,acc.summaryModifiedMs),running=isExitedCli?!1:acc.running||probe.running||livePid!==null&&envelopeHasActiveSubagent(acc.envelope),badge=formatSurfaceBadge(acc.surface),title=acc.title.length>0?acc.title:`${badge} session ${acc.convId.slice(0,8)}`;sessions.push({convId:acc.convId,shortId:acc.convId.slice(0,8),surface:acc.surface,title,workspace:acc.workspaces[0]??``,workspaces:acc.workspaces,dataRoot:acc.dataRoot,running,livePid,hasEnvelope:acc.envelope!==null,envelope:acc.envelope,updatedAtMs,ageLabel:updatedAtMs>0?formatRelativeAge(nowMs-updatedAtMs):`unknown`})}return sessions.sort(compareSessionsDefault)}var MIN_PREFIX_LEN=4,SIBLING_RECENT_WINDOW_MS=864e5,MAX_SIBLING_HINTS=5,SessionResolutionError=class extends Error{code;candidates;constructor(code,message,candidates=[]){super(message),this.name=`SessionResolutionError`,this.code=code,this.candidates=candidates}};function matchesSourceFilter(surface,source){return source===`cli`?surface===`cli`:source!==`app`||surface===`app`||surface===`ide`}function isPathWithin(rootCompare,targetCompare){if(rootCompare.length===0)return!1;if(targetCompare===rootCompare)return!0;let prefix=rootCompare.endsWith(path.sep)?rootCompare:`${rootCompare}${path.sep}`;return targetCompare.startsWith(prefix)}function toSiblingHint(session){return{convId:session.convId,shortId:session.shortId,surface:session.surface,title:session.title,livePid:session.livePid,running:session.running,ageLabel:session.ageLabel}}function resolveTier0Explicit(query,filtered,source){let trimmed=query.trim(),lower=trimmed.toLowerCase(),exact=filtered.find(s=>s.convId===trimmed||s.convId.toLowerCase()===lower);if(exact)return exact;let safeQuery=sanitizeTerminalText(trimmed);if(trimmed.length<MIN_PREFIX_LEN)throw new SessionResolutionError(`invalid-prefix`,`Session prefix "${safeQuery}" must be at least ${MIN_PREFIX_LEN} characters (or pass a full conversation ID).`);let matches=filtered.filter(s=>s.convId.toLowerCase().startsWith(lower));if(matches.length===1&&matches[0])return matches[0];if(matches.length>1){let listed=matches.map(s=>`  - [${formatSurfaceBadge(s.surface)}] ${s.convId} (${s.ageLabel}) "${sanitizeTerminalText(s.title)}"`).join(`
`);throw new SessionResolutionError(`ambiguous`,`Ambiguous session prefix "${safeQuery}" matched ${matches.length} sessions:\n${listed}`,matches)}throw new SessionResolutionError(`not-found`,`No session matching "${safeQuery}" found (source: ${source}). Run "agy-hud snapshot --sessions" to list sessions.`)}function resolveTier2Workspace(filtered,callerCwd,nowMs){let callerCompare=toComparePath(canonicalizeWorkspacePath(callerCwd));if(callerCompare.length===0)return null;let deepestLen=0,matched=[];for(let session of filtered){if(isExitedCliSession(session))continue;let best=0;for(let ws of session.workspaces){let wsCompare=toComparePath(canonicalizeWorkspacePath(ws));isPathWithin(wsCompare,callerCompare)&&wsCompare.length>best&&(best=wsCompare.length)}best>0&&(matched.push({session,depth:best}),best>deepestLen&&(deepestLen=best))}if(deepestLen===0)return null;let deepest=matched.filter(m=>m.depth===deepestLen).map(m=>m.session).sort((a,b)=>{let runDiff=+!!b.running-!!a.running;if(runDiff!==0)return runDiff;let timeDiff=b.updatedAtMs-a.updatedAtMs;return timeDiff===0?a.convId.localeCompare(b.convId):timeDiff}),winner=deepest[0];return winner?{session:winner,siblings:deepest.slice(1).filter(s=>s.livePid!==null||s.running||nowMs-s.updatedAtMs<=SIBLING_RECENT_WINDOW_MS).slice(0,MAX_SIBLING_HINTS).map(toSiblingHint)}:null}function pickNewestFallbackSession(filtered){let eligible=filtered.filter(s=>!isExitedCliSession(s)),pool=eligible.length>0?eligible:filtered,best;for(let candidate of pool)(!best||candidate.updatedAtMs>best.updatedAtMs||candidate.updatedAtMs===best.updatedAtMs&&(candidate.running===best.running?candidate.convId.localeCompare(best.convId)<0:candidate.running))&&(best=candidate);return best}function resolveSession(options={}){let source=options.source??`auto`,nowMs=options.nowMs??Date.now(),checkAlive=options.isAlive??isPidAlive,filtered=discoverSessions(options).filter(s=>matchesSourceFilter(s.surface,source));if(options.session!==void 0)return{session:resolveTier0Explicit(options.session,filtered,source),tier:`explicit`,siblings:[],sessions:filtered};if(filtered.length===0)throw new SessionResolutionError(`no-sessions`,`No Antigravity sessions found (source: ${source}).`);if(source===`auto`||source===`cli`){let callerPid=options.callerAgyPid===void 0?findAncestorAgyPid({isAlive:checkAlive}):options.callerAgyPid;if(callerPid!==null&&checkAlive(callerPid)){let byLivePid=filtered.find(s=>s.surface===`cli`&&s.livePid===callerPid);if(byLivePid)return{session:byLivePid,tier:`pid`,siblings:[],sessions:filtered}}}let tier2=resolveTier2Workspace(filtered,options.cwd??process.cwd(),nowMs);if(tier2!==null)return{session:tier2.session,tier:`workspace`,siblings:tier2.siblings,sessions:filtered};let fallback=pickNewestFallbackSession(filtered);if(!fallback)throw new SessionResolutionError(`no-sessions`,`No Antigravity sessions found (source: ${source}).`);return{session:fallback,tier:`fallback`,siblings:[],sessions:filtered}}var BINARY_1M_TOKENS=1048576,BINARY_2M_TOKENS=2097152,ESC_CHAR=`\x1B`;RegExp(`${ESC_CHAR}(?:\\[[0-9;]*m|\\][\\s\\S]*?(?:|${ESC_CHAR}\\\\))`,`g`);function fmtTokens(count){if(!isFiniteNum(count)||count<0)return``;let val=Math.round(count);return val===1e6||val===BINARY_1M_TOKENS?`1M`:val===2e6||val===BINARY_2M_TOKENS?`2M`:val>=1e6?`${(val/1e6).toFixed(1).replace(/\.0$/,``)}M`:val>=1e4?`${Math.round(val/1e3)}k`:val>=1e3?`${(val/1e3).toFixed(1).replace(/\.0$/,``)}k`:String(val)}var INSPECTOR_RENDER_SCRIPT=`  function pickStr(val, fallback) {
    return typeof val === "string" && val.length > 0 ? val : fallback;
  }
  function safeCount(val) {
    return typeof val === "number" && Number.isFinite(val) && val >= 0 ? Math.trunc(val) : 0;
  }
  function safeArray(val) {
    return Array.isArray(val) ? val : [];
  }
  function safeObjArray(val) {
    return safeArray(val).filter(function (item) {
      return item !== null && typeof item === "object";
    });
  }
  function safeFinite(val) {
    return typeof val === "number" && Number.isFinite(val) ? val : null;
  }
  function esc(val) {
    return String(val == null ? "" : val)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function fmtTok(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return "—";
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return Math.round(n / 1000) + "k";
    return String(n);
  }
  function renderCostPill(d) {
    if (d.costFormatted && typeof d.costFormatted === "object" && typeof d.costFormatted.text === "string" && d.costFormatted.text.length > 0) {
      var preTitle = typeof d.costFormatted.title === "string" ? d.costFormatted.title : "";
      return '<span title="' + esc(preTitle) + '">Cost <strong>' + esc(d.costFormatted.text) + "</strong></span>";
    }
    var c = d.cost;
    if (!c || typeof c !== "object") return "";
    var totalUsd = safeFinite(c.totalUsd);
    if (totalUsd == null || totalUsd < 0) return "";
    var fmtU = function (u) { return u >= 10 ? "$" + u.toFixed(2) : "$" + u.toFixed(3); };
    var rateVal = safeFinite(d.usdToCnyRate);
    var rate = rateVal != null && rateVal > 0 ? rateVal : 7.25;
    var fmtY = function (u) { return "¥" + (Math.round((u * rate + 1e-12) * 100) / 100).toFixed(2); };
    var prefix = c.estimated === true ? "~" : "";
    var cur = d.costCurrency === "cny" || d.costCurrency === "both" ? d.costCurrency : "usd";
    var text = prefix + (cur === "cny" ? fmtY(totalUsd) : cur === "both" ? fmtU(totalUsd) + " / " + fmtY(totalUsd) : fmtU(totalUsd));
    var subUsd = safeFinite(c.subagentUsd);
    var titleParts = ["Session cost: " + prefix + fmtU(totalUsd) + " / " + fmtY(totalUsd)];
    if (subUsd != null && subUsd > 0) titleParts.push("Subagents: " + fmtU(subUsd) + " / " + fmtY(subUsd));
    if (c.estimated === true) titleParts.push("Estimated pricing");
    return '<span title="' + esc(titleParts.join(" · ")) + '">Cost <strong>' + esc(text) + "</strong></span>";
  }
  function toneForCtx(pct) {
    if (pct == null) return "ok";
    return pct >= 85 ? "danger" : pct >= 68 ? "warn" : "ok";
  }
  function toneForCache(pct) {
    if (pct == null) return "ok";
    return pct < 50 ? "danger" : pct < 80 ? "warn" : "ok";
  }
  function shortWorkspace(ws) {
    if (typeof ws !== "string" || ws.length === 0) return "workspace";
    var parts = ws.split(/[\\\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : ws;
  }
  function agentDotClass(agentState) {
    return agentState === "working" ? "pulse" : agentState === "waiting" ? "warn" : "ok";
  }
  function renderGlobalSidebar() {
    var mount = document.getElementById("global-sess-mount");
    if (!mount) return;
    var filters = [
      { id: "auto", label: "All" },
      { id: "app", label: "App" },
      { id: "cli", label: "CLI" }
    ];
    var pillsHtml = filters
      .map(function (f) {
        var on = state.sourceFilter === f.id ? " on" : "";
        return '<button type="button" class="src-pill' + on + '" data-src-filter="' + f.id + '">' + f.label + "</button>";
      })
      .join("");
    var activeId = state.selectedSessionId || (state.snapshot && state.snapshot.convId) || null;
    var rowsHtml =
      state.sessions.length === 0
        ? '<div class="va-row" style="color:var(--text-tertiary)">No local sessions found.</div>'
        : state.sessions
            .map(function (s) {
              var on = s.convId === activeId ? " on" : "";
              return (
                '<button type="button" class="global-sess-item' + on + '" data-pick-session="' + esc(s.convId) + '">' +
                '<div class="global-sess-top"><span class="badge-surf ' + esc(s.surface) + '">' + esc(s.surface) + "</span>" +
                '<span class="global-sess-name" title="' + esc(s.title) + '">' + esc(s.title) + "</span></div>" +
                '<div class="global-sess-sub"><span>' + esc(shortWorkspace(s.workspace)) + "</span>" +
                '<span class="num">' + (s.running ? "Live" : esc(s.ageLabel)) + "</span></div></button>"
              );
            })
            .join("");
    mount.innerHTML =
      '<div class="global-list-hd"><div class="global-list-title"><span>Sessions</span><span class="num">' +
      state.sessions.length + '</span></div><div class="src-pills">' + pillsHtml + "</div></div>" +
      '<div class="global-list-body">' + rowsHtml + "</div>";
  }
  function renderToolTargetItem(target, uri) {
    if (uri) {
      return (
        '<button type="button" class="va-target-btn" data-file-uri="' + esc(uri) +
        '" title="Open in side pane: ' + esc(target) + '">' + FILE_ICO + "<span>" + esc(target) + "</span></button>"
      );
    }
    return '<span class="va-target-text" title="' + esc(target) + '">' + esc(target) + "</span>";
  }
  function renderRunningToolItem(rt) {
    var label = pickStr(rt.target, pickStr(rt.fullTarget, ""));
    var titleText = pickStr(rt.fullTarget, label);
    var tgtHtml = rt.fileUri
      ? '<button type="button" class="va-target-btn va-run-tgt" data-file-uri="' + esc(rt.fileUri) +
        '" title="Open in side pane: ' + esc(titleText) + '">' + FILE_ICO + "<span>" + esc(label) + "</span></button>"
      : '<span class="va-run-tgt" title="' + esc(titleText) + '">' + esc(label) + "</span>";
    return '<div class="va-run-item"><span class="dot warn"></span><span class="va-name">' + esc(rt.disp) +
      "</span>" + tgtHtml + "</div>";
  }
  function renderToolsTab(d) {
    var q = state.query.trim().toLowerCase();
    var runTools = safeObjArray(d.runningTools);
    var completedTools = safeObjArray(d.completedTools);
    var matchedRunning = runTools.filter(function (rt) {
      if (!q) return true;
      if (pickStr(rt.disp, "").toLowerCase().indexOf(q) !== -1) return true;
      if (pickStr(rt.target, "").toLowerCase().indexOf(q) !== -1) return true;
      return pickStr(rt.fullTarget, "").toLowerCase().indexOf(q) !== -1;
    });
    var runHtml = matchedRunning.length === 0
      ? ""
      : '<div class="va-run-banner">' + matchedRunning.map(renderRunningToolItem).join("") + "</div>";
    var maxCnt = 1;
    for (var i = 0; i < completedTools.length; i++) {
      var c = safeCount(completedTools[i].count);
      if (c > maxCnt) maxCnt = c;
    }
    var filtered = completedTools.filter(function (t) {
      if (!q) return true;
      if (pickStr(t.disp, "").toLowerCase().indexOf(q) !== -1) return true;
      if (pickStr(t.latestTarget, "").toLowerCase().indexOf(q) !== -1) return true;
      return safeArray(t.recentTargets).some(function (rt) { return typeof rt === "string" && rt.toLowerCase().indexOf(q) !== -1; });
    });
    var completedCard = filtered.length === 0
      ? (matchedRunning.length > 0 ? "" : '<div class="va-card"><div class="va-row" style="color:var(--text-tertiary)">No matching tools.</div></div>')
      : '<div class="va-card">' + filtered.map(function (t) {
          var disp = pickStr(t.disp, "");
          var cnt = safeCount(t.count);
          var open = state.expandedTool === disp;
          var pct = Math.max(4, Math.min(100, Math.round((cnt / maxCnt) * 100)));
          var targets = safeArray(t.recentTargets).filter(function (p) { return typeof p === "string"; });
          var uris = t.targetUris != null && typeof t.targetUris === "object" ? t.targetUris : {};
          var targetsHtml = open && targets.length > 0
            ? '<div class="va-targets">' + targets.map(function (p) { return renderToolTargetItem(p, pickStr(uris[p], null)); }).join("") + "</div>"
            : "";
          return (
            '<div class="va-row"><div class="va-row-main clickable" data-va-tool="' + esc(disp) + '">' +
            '<span class="va-name">' + esc(disp) + '</span><span class="num" style="color:var(--text-tertiary)">&times;' + cnt + "</span>" +
            '<span class="va-tgt">' + esc(pickStr(t.latestTarget, "—")) + "</span></div>" +
            '<div class="va-bar-bg"><div class="va-bar-fg" style="width:' + pct + '%"></div></div>' + targetsHtml + "</div>"
          );
        }).join("") + "</div>";
    return (
      '<input id="va-search" class="search-input" type="search" placeholder="Filter ' +
      (runTools.length + completedTools.length) + ' tools or file paths…" value="' + esc(state.query) + '">' +
      runHtml + completedCard
    );
  }
  function renderContextTab(d) {
    var mcps = safeObjArray(d.mcps);
    var skills = safeArray(d.skills).filter(function (s) { return typeof s === "string"; });
    var mcpRows = mcps.length === 0
      ? '<div class="va-row" style="color:var(--text-tertiary)">No MCP server calls recorded.</div>'
      : mcps.map(function (m) {
          var subs = safeObjArray(m.subtools)
            .map(function (s) {
              return '<span class="va-chip num">' + esc(pickStr(s.name, "")) + " &times;" + safeCount(s.count) + "</span>";
            }).join("");
          return (
            '<div class="va-row"><div class="va-row-main"><span class="dot" style="background:var(--accent-mcp)"></span>' +
            '<span class="va-name">' + esc(pickStr(m.server, "")) + '</span><span class="va-tgt num">' + safeCount(m.totalCalls) + " calls</span></div>" +
            '<div class="va-chips">' + subs + "</div></div>"
          );
        }).join("");
    var skillChips = skills.length === 0
      ? '<span style="color:var(--text-tertiary)">No skills loaded.</span>'
      : skills.map(function (s, idx) {
          return '<span class="va-chip"><span class="num" style="color:var(--text-tertiary)">' + (idx + 1) + ".</span>" + esc(s) + "</span>";
        }).join("");
    return (
      '<div class="va-card"><div class="va-card-hd"><span>MCP Servers (' + mcps.length + ")</span></div>" + mcpRows + "</div>" +
      '<div class="va-card"><div class="va-card-hd"><span>Loaded Skills (Chronological &middot; ' + skills.length + ")</span></div>" +
      '<div class="va-row"><div class="va-chips">' + skillChips + "</div></div></div>"
    );
  }
  function renderAgentsTab(d) {
    var agents = safeObjArray(d.agents);
    var title = (d.agentsKind === "swarm" ? "Swarm Members" : "Session Subagents") + " (" + agents.length + ")";
    var rows = agents.length === 0
      ? '<div class="va-row" style="color:var(--text-tertiary)">No subagents or swarm workers.</div>'
      : agents.map(function (a) {
          return (
            '<div class="va-row"><div class="va-row-main"><span class="dot ' + agentDotClass(a.state) + '"></span>' +
            '<span class="va-name">' + esc(a.name) + '</span><span class="badge-surf">' + esc(a.type) + "</span>" +
            '<span class="badge-surf">' + esc(a.model) + '</span><span class="va-tgt">' + esc(a.ageLabel) + "</span></div></div>"
          );
        }).join("");
    return '<div class="va-card"><div class="va-card-hd"><span>' + title + "</span></div>" + rows + "</div>";
  }
  function renderOverviewTab(d) {
    var runTools = safeObjArray(d.runningTools);
    var completedTools = safeObjArray(d.completedTools);
    var mcps = safeObjArray(d.mcps);
    var skills = safeArray(d.skills).filter(function (s) { return typeof s === "string"; });
    var agents = safeObjArray(d.agents);
    var runHtml = runTools.length === 0 ? "" :
      '<div class="va-run-banner">' + runTools.map(renderRunningToolItem).join("") + "</div>";
    var hiddenTools = Math.max(0, completedTools.length - 4);
    var hiddenAgents = Math.max(0, agents.length - 4);
    var topTools = completedTools.length === 0
      ? '<div class="va-row" style="color:var(--text-tertiary)">No tool calls yet.</div>'
      : completedTools.slice(0, 4).map(function (t) {
          var recent = safeArray(t.recentTargets);
          var firstTarget = recent.length > 0 ? recent[0] : "";
          var first = pickStr(firstTarget, pickStr(t.fullTarget, ""));
          var uri = first.length > 0 && t.targetUris != null && typeof t.targetUris === "object" ? pickStr(t.targetUris[first], "") : "";
          var attr = uri.length > 0 ? ' data-file-uri="' + esc(uri) + '" class="va-row-main clickable"' : ' class="va-row-main"';
          return '<div class="va-row"><div' + attr + '><span class="dot ok"></span><span class="va-name">' + esc(pickStr(t.disp, "")) +
            '</span><span class="num" style="color:var(--text-tertiary)">&times;' + safeCount(t.count) +
            '</span><span class="va-tgt">' + esc(pickStr(t.latestTarget, "—")) + "</span></div></div>";
        }).join("");
    var mcpChips = mcps.map(function (m) {
      return '<span class="va-chip"><span class="dot" style="background:var(--accent-mcp)"></span><span class="num">' +
        esc(pickStr(m.server, "")) + " (" + safeCount(m.totalCalls) + ")</span></span>";
    }).join("");
    var skillChips = skills.slice(0, 5).map(function (s) { return '<span class="va-chip">' + esc(s) + "</span>"; }).join("");
    var moreSkills = skills.length > 5
      ? '<button type="button" data-va-jump="context" class="va-more-btn">+' + (skills.length - 5) + " more</button>"
      : "";
    var emptyCtx = mcps.length === 0 && skills.length === 0 ? '<span style="color:var(--text-tertiary)">None recorded.</span>' : "";
    var agentRows = agents.length === 0
      ? '<div class="va-row" style="color:var(--text-tertiary)">No subagents spawned in this session.</div>'
      : agents.slice(0, 4).map(function (a) {
          return '<div class="va-row"><div class="va-row-main"><span class="dot ' + agentDotClass(a.state) +
            '"></span><span class="va-name">' + esc(a.name) + '</span><span class="badge-surf">' + esc(a.model) +
            '</span><span class="va-tgt">' + esc(a.ageLabel) + "</span></div></div>";
        }).join("");
    return (
      runHtml +
      '<div class="va-card"><div class="va-card-hd"><span>Top Tools (' + safeCount(d.totalToolCalls) + " calls)</span>" +
      (hiddenTools > 0 ? '<button type="button" data-va-jump="tools" class="action-link">+' + hiddenTools + " more &rarr;</button>" : "") +
      "</div>" + topTools + "</div>" +
      '<div class="va-card"><div class="va-card-hd"><span>Skills (' + skills.length + ") &amp; MCPs (" + mcps.length +
      ')</span><button type="button" data-va-jump="context" class="action-link">Inspect &rarr;</button></div>' +
      '<div class="va-row"><div class="va-chips">' + mcpChips + skillChips + moreSkills + emptyCtx + "</div></div></div>" +
      '<div class="va-card"><div class="va-card-hd"><span>' + (d.agentsKind === "swarm" ? "Swarm Roster" : "Subagents") +
      " (" + agents.length + ")</span>" +
      (hiddenAgents > 0 ? '<button type="button" data-va-jump="agents" class="action-link">+' + hiddenAgents + " more &rarr;</button>" : "") +
      "</div>" + agentRows + "</div>"
    );
  }
  function renderHeader(d) {
    var tel = d.telemetry && typeof d.telemetry === "object" ? d.telemetry : {};
    var ctxPct = safeFinite(tel.ctxPct);
    var tpsVal = safeFinite(tel.tps);
    var ttftVal = safeFinite(tel.ttft);
    var cachePctVal = safeFinite(tel.cachePct);
    var ctxTone = toneForCtx(ctxPct);
    var cacheTone = toneForCache(cachePctVal);
    var barColor = ctxTone === "danger" ? "var(--accent-danger)" : ctxTone === "warn" ? "var(--accent-warn)" : "var(--accent-ok)";
    var activeId = state.selectedSessionId || d.convId;
    var selectHtml = state.sessions.length > 1
      ? '<select id="va-sess-select" class="va-sess-select" aria-label="Select session">' +
        state.sessions.map(function (s) {
          var sel = s.convId === activeId ? " selected" : "";
          return '<option value="' + esc(s.convId) + '"' + sel + ">[" + esc(pickStr(s.surface, "app").toUpperCase()) + "] " + esc(s.title) + "</option>";
        }).join("") + "</select>"
      : "";
    var agentTabLabel = d.agentsKind === "swarm" ? "Swarm" : "Agents";
    var runningCount = safeArray(d.runningTools).length;
    var completedCount = safeArray(d.completedTools).length;
    var skillsCount = safeArray(d.skills).length;
    var mcpsCount = safeArray(d.mcps).length;
    var agentsCount = safeArray(d.agents).length;
    var tabBtn = function (id, label, cnt) {
      var active = state.tab === id;
      var cntHtml = cnt == null ? "" : '<span class="va-cnt">' + safeCount(cnt) + "</span>";
      return '<button type="button" role="tab" aria-selected="' + active + '" data-va-tab="' + id +
        '" class="va-tab ' + (active ? "active" : "") + '">' + label + cntHtml + "</button>";
    };
    return (
      '<div class="va-header"><div class="va-title-row">' +
      '<span class="badge-surf ' + esc(d.surface) + '">' + esc(d.surface) + "</span>" +
      '<h1 class="va-title" title="' + esc(d.title) + '">' + esc(d.title) + "</h1>" +
      '<span class="live-pill"><span class="dot ' + (d.running ? "pulse" : "ok") + '"></span><span>' +
      (d.running ? "Live" : esc(d.ageLabel)) + "</span></span>" +
      '<button type="button" id="va-refresh" class="icon-btn" title="Refresh snapshot" aria-label="Refresh">' + REFRESH_ICO + "</button></div>" +
      selectHtml +
      '<div class="va-ribbon num"><span title="Context window usage"><span class="va-ctx-track"><span class="va-ctx-fill" style="width:' +
      (ctxPct != null ? Math.max(0, Math.min(100, ctxPct)) : 0) + "%;background:" + barColor + '"></span></span><strong>' +
      (ctxPct != null ? ctxPct.toFixed(0) + "%" : "—") + '</strong> <span style="color:var(--text-tertiary)">(' +
      fmtTok(tel.ctxUsed) + "/" + fmtTok(tel.ctxMax) + ")</span></span>" +
      "<span>TPS <strong>" + (tpsVal != null ? tpsVal.toFixed(0) : "—") + "</strong></span>" +
      "<span>TTFT <strong>" + (ttftVal != null ? ttftVal.toFixed(2) + "s" : "—") + "</strong></span>" +
      '<span>Cache <strong style="color:var(--accent-' + cacheTone + ')">' +
      (cachePctVal != null ? cachePctVal.toFixed(0) + "%" : "—") + "</strong></span>" +
      renderCostPill(d) + "</div>" +
      '<nav class="va-tabs" role="tablist">' +
      tabBtn("overview", "Overview", null) +
      tabBtn("tools", "Tools", runningCount + completedCount) +
      tabBtn("context", "Skills &amp; MCP", skillsCount + mcpsCount) +
      tabBtn("agents", agentTabLabel, agentsCount) +
      "</nav></div>"
    );
  }
  function renderMainPanel() {
    var main = document.getElementById("inspector-main");
    if (!main) return;
    var activeEl = document.activeElement;
    var restoreSearch = activeEl && activeEl.id === "va-search";
    var selStart = restoreSearch ? activeEl.selectionStart : null;
    var d = state.snapshot;
    if (!d) {
      var msg = state.errorNote ? esc(state.errorNote) : state.initialized ? "No local Antigravity sessions detected yet." : "Connecting to Antigravity host…";
      main.innerHTML = '<div class="empty-state">' + EMPTY_ICO + "<strong>HUD Inspector</strong><span>" + msg + "</span></div>";
      return;
    }
    var note = state.errorNote ? '<div class="status-note">' + esc(state.errorNote) + "</div>" : "";
    var tabBody = state.tab === "tools" ? renderToolsTab(d)
      : state.tab === "context" ? renderContextTab(d)
      : state.tab === "agents" ? renderAgentsTab(d)
      : renderOverviewTab(d);
    main.innerHTML = renderHeader(d) + '<div class="va-body">' + note + tabBody + "</div>";
    if (restoreSearch) {
      var nextInput = document.getElementById("va-search");
      if (nextInput) {
        nextInput.focus();
        var pos = selStart == null ? state.query.length : selStart;
        nextInput.setSelectionRange(pos, pos);
      }
    }
  }
  function renderAll() {
    renderGlobalSidebar();
    renderMainPanel();
  }`,INSPECTOR_STATE_SCRIPT=`  var MAX_UNSETTLED_HOST_PUSH_ENTRIES = 64;

  function isObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function normalizeSessionId(raw) {
    if (typeof raw !== "string") return null;
    var trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function normalizeSource(raw) {
    return typeof raw === "string" && raw.length > 0 ? raw : "auto";
  }

  function sessionsMayOverlap(a, b) {
    if (a === "" || b === "") return true;
    return a === b || a.indexOf(b) === 0 || b.indexOf(a) === 0;
  }

  function hasOverlappingUnsettledHostPush(source, sessLower) {
    if (state.hostPushOverflow) return true;
    for (var i = 0; i < state.unsettledHostPushes.length; i++) {
      var entry = state.unsettledHostPushes[i];
      if (entry.count > 0 && entry.source === source && sessionsMayOverlap(entry.sessionLower, sessLower)) {
        return true;
      }
    }
    return false;
  }

  function recordHostPushRequest(source, sessionId) {
    var src = normalizeSource(source);
    var sess = normalizeSessionId(sessionId);
    var sessLower = sess ? sess.toLowerCase() : "";
    var overlapping = hasOverlappingUnsettledHostPush(src, sessLower);
    for (var i = 0; i < state.unsettledHostPushes.length; i++) {
      var entry = state.unsettledHostPushes[i];
      if (entry.source === src && entry.sessionLower === sessLower) {
        entry.count += 1;
        return overlapping;
      }
    }
    if (state.unsettledHostPushes.length >= MAX_UNSETTLED_HOST_PUSH_ENTRIES) {
      state.hostPushOverflow = true;
      return true;
    }
    state.unsettledHostPushes.push({ source: src, sessionLower: sessLower, count: 1 });
    return overlapping;
  }

  function decrementHostPushAt(idx) {
    var entry = state.unsettledHostPushes[idx];
    if (!entry) return;
    if (entry.count <= 1) state.unsettledHostPushes.splice(idx, 1);
    else entry.count -= 1;
    if (state.unsettledHostPushes.length === 0) state.hostPushOverflow = false;
  }

  function findNarrowestCoveringPushIndex(src, targetLower) {
    var bestIdx = -1;
    var bestLen = -1;
    for (var i = 0; i < state.unsettledHostPushes.length; i++) {
      var entry = state.unsettledHostPushes[i];
      if (entry.count <= 0 || entry.source !== src) continue;
      var s = entry.sessionLower;
      if (s === "" || targetLower === s || targetLower.indexOf(s) === 0) {
        if (s.length > bestLen) {
          bestLen = s.length;
          bestIdx = i;
        }
      }
    }
    return bestIdx;
  }

  function settleHostPush(pushed) {
    if (state.unsettledHostPushes.length === 0) return;
    if (typeof pushed.error === "string" && pushed.error.length > 0) {
      if (typeof pushed.source !== "string" || pushed.source.length === 0) return;
      if (!Object.prototype.hasOwnProperty.call(pushed, "sessionId")) return;
      if (pushed.sessionId !== null && typeof pushed.sessionId !== "string") return;
      var errSess = normalizeSessionId(pushed.sessionId);
      if (pushed.sessionId !== null && errSess === null) return;
      var errLower = errSess ? errSess.toLowerCase() : "";
      for (var i = 0; i < state.unsettledHostPushes.length; i++) {
        var entry = state.unsettledHostPushes[i];
        if (entry.source === pushed.source && entry.sessionLower === errLower) {
          decrementHostPushAt(i);
          return;
        }
      }
      var coverIdx = findNarrowestCoveringPushIndex(pushed.source, errLower);
      if (coverIdx !== -1) decrementHostPushAt(coverIdx);
      return;
    }
    if (pushed.unchanged === true) {
      if (typeof pushed.source !== "string" || pushed.source.length === 0) return;
      if (
        Object.prototype.hasOwnProperty.call(pushed, "sessionId") &&
        pushed.sessionId !== undefined &&
        pushed.sessionId !== null &&
        (typeof pushed.sessionId !== "string" || normalizeSessionId(pushed.sessionId) === null)
      ) {
        return;
      }
      var unchSess = typeof pushed.sessionId === "string" ? normalizeSessionId(pushed.sessionId) : null;
      var unchLower = unchSess ? unchSess.toLowerCase() : "";
      var unchIdx = findNarrowestCoveringPushIndex(pushed.source, unchLower);
      if (unchIdx !== -1) decrementHostPushAt(unchIdx);
      return;
    }
    var src = normalizeSource(pushed.source);
    if (pushed.snapshot === null) {
      for (var j = 0; j < state.unsettledHostPushes.length; j++) {
        var autoEntry = state.unsettledHostPushes[j];
        if (autoEntry.source === src && autoEntry.sessionLower === "") {
          decrementHostPushAt(j);
          return;
        }
      }
      return;
    }
    if (!isObj(pushed.snapshot) || typeof pushed.snapshot.convId !== "string") return;
    var narrowIdx = findNarrowestCoveringPushIndex(src, pushed.snapshot.convId.toLowerCase());
    if (narrowIdx !== -1) decrementHostPushAt(narrowIdx);
  }

  function matchesCurrentSelection(data) {
    if (!isObj(data)) return false;
    if (typeof data.error === "string" && data.error.length > 0) {
      if (typeof data.source !== "string" || data.source !== state.sourceFilter) return false;
      if (!Object.prototype.hasOwnProperty.call(data, "sessionId")) return false;
      if (data.sessionId !== null && typeof data.sessionId !== "string") return false;
      var errSess = normalizeSessionId(data.sessionId);
      if (data.sessionId !== null && errSess === null) return false;
      return state.selectedSessionId
        ? errSess !== null && errSess.toLowerCase() === state.selectedSessionId.toLowerCase()
        : errSess === null;
    }
    if (data.unchanged === true) {
      return data.source === undefined || (typeof data.source === "string" && data.source === state.sourceFilter);
    }
    if (typeof data.source === "string" && data.source !== state.sourceFilter) return false;
    if (state.selectedSessionId) {
      if (!isObj(data.snapshot) || typeof data.snapshot.convId !== "string") return false;
      var sel = state.selectedSessionId.toLowerCase();
      var got = data.snapshot.convId.toLowerCase();
      if (got !== sel && got.indexOf(sel) !== 0) return false;
    }
    return true;
  }

  function isValidSessionItem(s) {
    return (
      isObj(s) &&
      typeof s.convId === "string" &&
      s.convId.length > 0 &&
      typeof s.surface === "string" &&
      typeof s.title === "string" &&
      (s.workspace === undefined || typeof s.workspace === "string")
    );
  }

  function isValidSnapshotPayload(snap) {
    if (snap === null) return true;
    return (
      isObj(snap) &&
      typeof snap.convId === "string" &&
      snap.convId.length > 0 &&
      typeof snap.surface === "string" &&
      typeof snap.title === "string" &&
      Array.isArray(snap.completedTools) &&
      Array.isArray(snap.skills) &&
      Array.isArray(snap.mcps) &&
      Array.isArray(snap.agents) &&
      (snap.runningTools == null || Array.isArray(snap.runningTools))
    );
  }

  function isValidPollPayload(data) {
    if (!isObj(data)) return false;
    if (typeof data.error === "string" && data.error.length > 0) return true;
    if (data.unchanged === true) return data.etag === undefined || typeof data.etag === "string";
    if (!Object.prototype.hasOwnProperty.call(data, "snapshot")) return false;
    if (!isValidSnapshotPayload(data.snapshot)) return false;
    if (data.sessions !== undefined && !Array.isArray(data.sessions)) return false;
    return true;
  }

  function ingestPollPayload(data) {
    if (!isValidPollPayload(data)) return;
    if (typeof data.error === "string" && data.error.length > 0) {
      state.errorNote = data.error;
      renderAll();
      return;
    }
    var hadError = state.errorNote.length > 0;
    state.errorNote = "";
    if (typeof data.etag === "string") state.etag = data.etag;
    if (data.unchanged === true) {
      if (hadError) renderAll();
      return;
    }
    if (Array.isArray(data.sessions)) {
      state.sessions = data.sessions.filter(isValidSessionItem);
    }
    state.snapshot = data.snapshot != null ? data.snapshot : null;
    renderAll();
  }`,MCP_INSPECTOR_VERSION=`0.1.0`,INSPECTOR_SCRIPT=`(function () {
  var POLL_INTERVAL_MS = 2000;
  var REQUEST_TIMEOUT_MS = 10000;
  var SEP_PROTOCOL_VERSION = "2026-01-26";
  var FILE_ICO = '<svg class="ico" viewBox="0 0 16 16"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/></svg>';
  var REFRESH_ICO = '<svg class="ico" viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.3-3.4"/><path d="M13 2.5v2.8h-2.8"/></svg>';
  var EMPTY_ICO = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/></svg>';

  var state = {
    nextId: 1,
    pending: new Map(),
    initialized: false,
    isGlobal: false,
    inFlight: false,
    pendingPoll: false,
    pendingForce: false,
    selectionSeq: 0,
    latestRequestSeq: 0,
    acceptHostPush: true,
    unsettledHostPushes: [],
    hostPushOverflow: false,
    disposed: false,
    pollTimer: null,
    etag: null,
    selectedSessionId: null,
    sourceFilter: "auto",
    sessions: [],
    snapshot: null,
    tab: "overview",
    query: "",
    expandedTool: null,
    errorNote: ""
  };

${INSPECTOR_RENDER_SCRIPT}

${INSPECTOR_STATE_SCRIPT}

  function postToHost(msg) {
    try {
      if (window.parent && window.parent !== window) {
        // SEP-1865 sandboxed iframe runs under an opaque origin; inbound replies verify ev.source === window.parent.
        window.parent.postMessage(msg, "*");
      }
    } catch (_err) {
      return;
    }
  }

  function sendRequest(method, params, timeoutMs) {
    var id = state.nextId++;
    return new Promise(function (resolve, reject) {
      var timer = null;
      if (timeoutMs > 0 && typeof setTimeout === "function") {
        timer = setTimeout(function () {
          if (!state.pending.has(id)) return;
          state.pending.delete(id);
          reject(new Error("Request timed out"));
        }, timeoutMs);
      }
      state.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      postToHost({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }

  function sendNotification(method, params) {
    postToHost({ jsonrpc: "2.0", method: method, params: params || {} });
  }

  function applyHostContext(ctx, caps) {
    if (ctx && typeof ctx === "object") {
      if (ctx.theme === "light" || ctx.theme === "dark") {
        document.documentElement.setAttribute("data-theme", ctx.theme);
        document.documentElement.style.colorScheme = ctx.theme;
      }
      var vars = ctx.styles && ctx.styles.variables;
      if (vars && typeof vars === "object") {
        var keys = Object.keys(vars);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var v = vars[k];
          if (k && k.indexOf("--") === 0 && typeof v === "string") {
            document.documentElement.style.setProperty(k, v);
          }
        }
      }
      if (ctx.entrypoint === "global" || ctx.surface === "global" || ctx.viewMode === "global") {
        state.isGlobal = true;
      } else if (ctx.entrypoint === "aux_pane" || ctx.surface === "aux_pane") {
        state.isGlobal = false;
      }
    }
    if (caps && typeof caps === "object") {
      var hasConvCap = Boolean(caps.message || caps.updateModelContext);
      if (!hasConvCap) state.isGlobal = true;
    }
    var shell = document.getElementById("app-shell");
    if (shell) shell.classList.toggle("mode-global", state.isGlobal);
  }

  function extractStructured(toolResult) {
    if (!toolResult || typeof toolResult !== "object") return null;
    if (toolResult.structuredContent && typeof toolResult.structuredContent === "object") {
      return toolResult.structuredContent;
    }
    if (Array.isArray(toolResult.content) && toolResult.content[0] && typeof toolResult.content[0].text === "string") {
      try {
        return JSON.parse(toolResult.content[0].text);
      } catch (_err) {
        return null;
      }
    }
    return null;
  }

  function bumpSelection(fromUser) {
    state.selectionSeq += 1;
    state.etag = null;
    if (fromUser) state.acceptHostPush = false;
  }

  function openLocalFile(fileUri) {
    if (typeof fileUri !== "string" || fileUri.indexOf("file:///") !== 0) return;
    sendRequest("com.google.antigravity/toggle-aux-pane", {
      tabType: "fileView",
      uri: fileUri
    }, REQUEST_TIMEOUT_MS).catch(function (err) {
      if (err && err.code === -32601) return;
    });
  }

  function pollSnapshot(force) {
    if (state.disposed) return;
    if (!state.initialized) {
      if (force) {
        state.pendingPoll = true;
        state.pendingForce = true;
      }
      return;
    }
    if (!force && document.visibilityState !== "visible") return;
    if (state.inFlight) {
      if (force) { state.pendingPoll = true; state.pendingForce = true; }
      return;
    }
    state.inFlight = true;
    state.pendingPoll = false;
    state.pendingForce = false;

    var reqSeq = ++state.latestRequestSeq;
    var reqSelectionSeq = state.selectionSeq;
    var reqSessionId = state.selectedSessionId;
    var reqSource = state.sourceFilter;

    var args = {};
    if (reqSessionId) args.sessionId = reqSessionId;
    if (reqSource && reqSource !== "auto") args.source = reqSource;
    if (!force && state.etag) args.etag = state.etag;

    function isCurrentRequest() {
      return (
        reqSeq === state.latestRequestSeq &&
        reqSelectionSeq === state.selectionSeq &&
        reqSessionId === state.selectedSessionId &&
        reqSource === state.sourceFilter
      );
    }

    sendRequest("tools/call", { name: "hud_poll_snapshot", arguments: args }, REQUEST_TIMEOUT_MS)
      .then(function (res) {
        if (!isCurrentRequest()) return;
        var data = extractStructured(res);
        if (!data) return;
        if (typeof data.error === "string" && data.error.length > 0) {
          state.acceptHostPush = false;
          ingestPollPayload(data);
          return;
        }
        if (!matchesCurrentSelection(data)) return;
        state.acceptHostPush = false;
        ingestPollPayload(data);
      })
      .catch(function (err) {
        if (!isCurrentRequest()) return;
        state.errorNote = err && err.message ? err.message : "Poll error";
        renderAll();
      })
      .finally(function () {
        state.inFlight = false;
        if (state.pendingPoll) {
          var nextForce = state.pendingForce;
          state.pendingPoll = false;
          state.pendingForce = false;
          pollSnapshot(nextForce);
        }
      });
  }

  function stopPolling() {
    if (state.pollTimer !== null) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    if (state.disposed || document.visibilityState !== "visible") return;
    state.pollTimer = setInterval(function () { pollSnapshot(false); }, POLL_INTERVAL_MS);
  }

  function onDocClick(ev) {
    var target = ev.target;
    if (!(target instanceof Element)) return;
    var tabBtn = target.closest("[data-va-tab]");
    if (tabBtn) {
      var nextTab = tabBtn.getAttribute("data-va-tab");
      state.tab = nextTab && nextTab.length > 0 ? nextTab : "overview";
      renderMainPanel();
      return;
    }
    var jumpBtn = target.closest("[data-va-jump]");
    if (jumpBtn) {
      var jumpTab = jumpBtn.getAttribute("data-va-jump");
      state.tab = jumpTab && jumpTab.length > 0 ? jumpTab : "overview";
      renderMainPanel();
      return;
    }
    var toolRow = target.closest("[data-va-tool]");
    if (toolRow) {
      var k = toolRow.getAttribute("data-va-tool");
      state.expandedTool = state.expandedTool === k ? null : k;
      renderMainPanel();
      return;
    }
    var fileBtn = target.closest("[data-file-uri]");
    if (fileBtn) { var uri = fileBtn.getAttribute("data-file-uri"); if (uri) openLocalFile(uri); return; }
    var pickSess = target.closest("[data-pick-session]");
    if (pickSess) {
      var picked = pickSess.getAttribute("data-pick-session");
      state.selectedSessionId = picked && picked.length > 0 ? picked : null;
      bumpSelection(true);
      pollSnapshot(true);
      return;
    }
    var srcPill = target.closest("[data-src-filter]");
    if (srcPill) {
      var srcVal = srcPill.getAttribute("data-src-filter");
      state.sourceFilter = srcVal && srcVal.length > 0 ? srcVal : "auto";
      state.selectedSessionId = null;
      bumpSelection(true);
      pollSnapshot(true);
      return;
    }
    if (target.closest("#va-refresh")) { bumpSelection(true); pollSnapshot(true); }
  }

  function onDocChange(ev) {
    var target = ev.target;
    if (target instanceof HTMLSelectElement && target.id === "va-sess-select") {
      state.selectedSessionId = target.value.length > 0 ? target.value : null;
      bumpSelection(true);
      pollSnapshot(true);
    }
  }

  function onDocInput(ev) {
    var target = ev.target;
    if (target instanceof HTMLInputElement && target.id === "va-search") {
      state.query = target.value;
      renderMainPanel();
    }
  }

  function onVisibilityChange() {
    if (state.disposed) return;
    if (document.visibilityState === "visible") { pollSnapshot(false); startPolling(); }
    else stopPolling();
  }

  function onWindowMessage(ev) {
    if (state.disposed) return;
    if (window.parent && window.parent !== window && ev.source !== window.parent) return;
    var msg = ev.data;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    if (typeof msg.method === "string") {
      if (msg.method === "ping" && msg.id !== undefined) {
        postToHost({ jsonrpc: "2.0", id: msg.id, result: {} });
        return;
      }
      if (msg.method === "ui/notifications/host-context-changed") { applyHostContext(msg.params, null); return; }
      if (msg.method === "ui/notifications/tool-input" && msg.params && msg.params.arguments) {
        var inArgs = msg.params.arguments;
        var nextSess = normalizeSessionId(inArgs.sessionId);
        var nextSrc = normalizeSource(inArgs.source);
        var changed = nextSess !== state.selectedSessionId || nextSrc !== state.sourceFilter;
        var overlapping = recordHostPushRequest(nextSrc, nextSess);
        state.latestRequestSeq += 1;
        state.selectedSessionId = nextSess;
        state.sourceFilter = nextSrc;
        if (overlapping) {
          state.acceptHostPush = false;
          bumpSelection(false);
          pollSnapshot(true);
        } else {
          state.acceptHostPush = true;
          if (changed) {
            bumpSelection(false);
            pollSnapshot(true);
          } else if (state.inFlight) {
            state.pendingPoll = true;
            state.pendingForce = true;
          }
        }
        return;
      }
      if (msg.method === "ui/notifications/tool-result") {
        var pushed = extractStructured(msg.params);
        if (!pushed) return;
        settleHostPush(pushed);
        if (!state.acceptHostPush) return;
        if (!isValidPollPayload(pushed)) return;
        if (matchesCurrentSelection(pushed)) {
          state.acceptHostPush = false;
          state.pendingPoll = false;
          state.pendingForce = false;
          state.latestRequestSeq += 1;
          ingestPollPayload(pushed);
        }
      }
      return;
    }
    if (msg.id !== undefined && state.pending.has(msg.id)) {
      var entry = state.pending.get(msg.id);
      state.pending.delete(msg.id);
      if (entry.timer !== null && typeof clearTimeout === "function") {
        clearTimeout(entry.timer);
      }
      if (msg.error) entry.reject(msg.error);
      else entry.resolve(msg.result);
    }
  }

  function cleanupResources() {
    state.disposed = true;
    stopPolling();
    state.pending.forEach(function (entry) {
      if (entry.timer !== null && typeof clearTimeout === "function") {
        clearTimeout(entry.timer);
      }
    });
    state.pending.clear();
    state.unsettledHostPushes = [];
    state.hostPushOverflow = false;
    if (typeof document.removeEventListener === "function") {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("change", onDocChange);
      document.removeEventListener("input", onDocInput);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    if (typeof window.removeEventListener === "function") {
      window.removeEventListener("message", onWindowMessage);
      window.removeEventListener("pagehide", cleanupResources);
      window.removeEventListener("unload", cleanupResources);
    }
  }

  document.addEventListener("click", onDocClick);
  document.addEventListener("change", onDocChange);
  document.addEventListener("input", onDocInput);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("message", onWindowMessage);
  window.addEventListener("pagehide", cleanupResources);
  window.addEventListener("unload", cleanupResources);

  renderAll();
  sendRequest("ui/initialize", {
    appInfo: { name: "HUD Inspector", version: "${MCP_INSPECTOR_VERSION}" },
    appCapabilities: {},
    protocolVersion: SEP_PROTOCOL_VERSION
  }, REQUEST_TIMEOUT_MS)
    .then(function (res) {
      state.initialized = true;
      if (res && typeof res === "object") applyHostContext(res.hostContext, res.hostCapabilities);
      sendNotification("ui/notifications/initialized", {});
      startPolling();
      if (state.pendingPoll || !state.snapshot) pollSnapshot(true);
    })
    .catch(function () {
      state.initialized = true;
      startPolling();
      if (state.pendingPoll || !state.snapshot) pollSnapshot(true);
      else renderAll();
    });
})();
`,INSPECTOR_STYLES=`:root {
  color-scheme: dark;
  --bg-primary: var(--color-background-primary, #0b0c0e);
  --bg-secondary: var(--color-background-secondary, #141619);
  --bg-tertiary: var(--color-background-tertiary, #17191d);
  --text-primary: var(--color-text-primary, #eceef0);
  --text-secondary: var(--color-text-secondary, #b8bfc6);
  --text-tertiary: var(--color-text-tertiary, #7f8892);
  --border-primary: var(--color-border-primary, rgba(255, 255, 255, 0.09));
  --border-secondary: var(--color-border-secondary, rgba(255, 255, 255, 0.16));
  --accent-info: var(--color-text-info, #4da3ff);
  --accent-ok: var(--color-text-success, #7aae66);
  --accent-warn: var(--color-text-warning, #d4b44a);
  --accent-danger: var(--color-text-danger, #e06c6c);
  --accent-mcp: #9d84f5;
  --bg-info-tint: var(--color-background-info, rgba(77, 163, 255, 0.14));
  --bg-warn-tint: var(--color-background-warning, rgba(212, 180, 74, 0.12));
  --hover: rgba(128, 128, 128, 0.1);
  --fill: rgba(128, 128, 128, 0.14);
  --font-ui: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);
  --font-code: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg-primary: var(--color-background-primary, #ffffff);
  --bg-secondary: var(--color-background-secondary, #f6f7f9);
  --bg-tertiary: var(--color-background-tertiary, #eef0f3);
  --text-primary: var(--color-text-primary, #1b1e23);
  --text-secondary: var(--color-text-secondary, #474e57);
  --text-tertiary: var(--color-text-tertiary, #68717c);
  --border-primary: var(--color-border-primary, rgba(0, 0, 0, 0.09));
  --border-secondary: var(--color-border-secondary, rgba(0, 0, 0, 0.16));
  --accent-info: var(--color-text-info, #1a6dd4);
  --accent-ok: var(--color-text-success, #2d7a36);
  --accent-warn: var(--color-text-warning, #a67300);
  --accent-danger: var(--color-text-danger, #c43737);
  --accent-mcp: #6b4cd8;
  --bg-info-tint: var(--color-background-info, rgba(26, 109, 212, 0.1));
  --bg-warn-tint: var(--color-background-warning, rgba(166, 115, 0, 0.1));
  --hover: rgba(0, 0, 0, 0.045);
  --fill: rgba(0, 0, 0, 0.07);
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  font-family: var(--font-ui);
  font-size: 13px;
  line-height: 1.45;
  background: var(--bg-primary);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
}
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; border: 0; background: none; }
.num { font-variant-numeric: tabular-nums; font-family: var(--font-code); }
.ico { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.6; flex: none; }
.app-shell { display: flex; height: 100%; width: 100%; background: var(--bg-primary); }
.global-sess-list {
  display: none;
  width: 264px;
  flex: none;
  border-right: 1px solid var(--border-primary);
  background: var(--bg-secondary);
  flex-direction: column;
  min-height: 0;
}
.app-shell.mode-global .global-sess-list { display: flex; }
@media (max-width: 639px) {
  .app-shell.mode-global .global-sess-list { display: none; }
}
.global-list-hd {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.global-list-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.src-pills { display: flex; gap: 4px; }
.src-pill {
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--text-tertiary);
  background: var(--fill);
}
.src-pill.on { background: var(--bg-info-tint); color: var(--accent-info); font-weight: 600; }
.global-list-body { flex: 1 1 auto; overflow-y: auto; }
.global-sess-item {
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.global-sess-item:hover { background: var(--hover); }
.global-sess-item.on {
  background: var(--bg-info-tint);
  border-left: 2px solid var(--accent-info);
  padding-left: 10px;
}
.global-sess-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.global-sess-name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.global-sess-sub {
  font-size: 11px;
  color: var(--text-tertiary);
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.inspector-main {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}
.va-header {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--bg-primary);
  padding: 11px 14px 0;
  border-bottom: 1px solid var(--border-primary);
}
.va-title-row { display: flex; align-items: center; gap: 7px; min-width: 0; }
.badge-surf {
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-code);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  background: var(--fill);
  color: var(--text-secondary);
  flex: none;
}
.badge-surf.app { background: var(--bg-info-tint); color: var(--accent-info); }
.badge-surf.ide { background: rgba(157, 132, 245, 0.16); color: var(--accent-mcp); }
.va-title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.va-sess-select {
  margin-top: 7px;
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border-primary);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 11.5px;
}
.app-shell.mode-global .va-sess-select { display: none; }
@media (max-width: 639px) {
  .app-shell.mode-global .va-sess-select { display: block; }
}
.live-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-tertiary);
  flex: none;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  color: var(--text-tertiary);
  flex: none;
}
.icon-btn:hover { background: var(--hover); color: var(--text-primary); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-tertiary); flex: none; }
.dot.ok { background: var(--accent-ok); }
.dot.warn { background: var(--accent-warn); }
.dot.danger { background: var(--accent-danger); }
.dot.pulse { background: var(--accent-ok); box-shadow: 0 0 0 3px rgba(122, 174, 102, 0.25); }
.va-ribbon {
  margin-top: 8px;
  padding: 6px 9px;
  border-radius: 6px;
  background: var(--bg-tertiary);
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  overflow-x: auto;
  white-space: nowrap;
  gap: 10px;
  font-size: 11.5px;
}
.va-ribbon > span { flex: none; white-space: nowrap; }
.va-ctx-track {
  width: 48px;
  height: 5px;
  border-radius: 3px;
  background: var(--fill);
  overflow: hidden;
  display: inline-block;
  vertical-align: middle;
  margin-right: 4px;
}
.va-ctx-fill { height: 100%; border-radius: 3px; background: var(--accent-ok); }
.va-tabs { display: flex; gap: 15px; margin-top: 8px; overflow-x: auto; }
.va-tab {
  position: relative;
  height: 32px;
  padding: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.va-tab:hover { color: var(--text-secondary); }
.va-tab.active { color: var(--text-primary); }
.va-tab.active::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent-info);
}
.va-cnt { font-size: 10.5px; color: var(--text-tertiary); font-family: var(--font-code); }
.va-body { padding: 12px 14px 20px; display: flex; flex-direction: column; gap: 10px; }
.va-run-banner {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-warn-tint);
  border: 1px solid var(--border-secondary);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.va-run-item { display: flex; align-items: center; gap: 7px; font-size: 12px; min-width: 0; }
.va-run-tgt {
  color: var(--text-tertiary);
  font-family: var(--font-code);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.va-card {
  border: 1px solid var(--border-primary);
  border-radius: 7px;
  background: var(--bg-secondary);
  overflow: hidden;
}
.va-card-hd {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-primary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-secondary);
}
.va-row {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.va-row:last-child { border-bottom: 0; }
.va-row:hover { background: var(--hover); }
.va-row-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.va-row-main.clickable { cursor: pointer; }
.va-name { font-family: var(--font-code); font-size: 12px; font-weight: 500; color: var(--text-primary); }
.va-tgt {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-family: var(--font-code);
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.va-bar-bg { height: 3px; border-radius: 2px; background: var(--fill); overflow: hidden; }
.va-bar-fg { height: 100%; background: var(--accent-info); opacity: 0.78; }
.va-targets {
  padding: 5px 8px;
  border-radius: 5px;
  background: var(--bg-tertiary);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.va-target-btn, .va-target-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  font-family: var(--font-code);
  font-size: 11px;
  color: var(--text-secondary);
  padding: 2px 4px;
  border-radius: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.va-target-btn:hover { background: var(--hover); color: var(--accent-info); }
.va-target-text { color: var(--text-tertiary); }
.search-input {
  width: 100%;
  height: 28px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid var(--border-primary);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 12px;
}
.action-link { font-size: 11px; color: var(--accent-info); padding: 2px 6px; border-radius: 4px; }
.action-link:hover { background: var(--hover); }
.va-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.va-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  font-size: 11px;
}
.va-more-btn {
  padding: 2px 8px;
  border-radius: 999px;
  font-family: var(--font-code);
  font-size: 11px;
  background: var(--bg-info-tint);
  color: var(--accent-info);
}
.empty-state {
  margin: auto;
  padding: 28px 20px;
  text-align: center;
  color: var(--text-tertiary);
  max-width: 340px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.empty-state strong { color: var(--text-primary); font-size: 13px; }
.status-note {
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-tertiary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
}
`,INSPECTOR_RESOURCE_URI=`ui://agy-hud/inspector.html`,INSPECTOR_MIME_TYPE=`text/html;profile=mcp-app`;function buildInspectorHtml(){return`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HUD Inspector</title>
  <style>${INSPECTOR_STYLES}</style>
</head>
<body>
  <div id="app-shell" class="app-shell">
    <aside id="global-sess-mount" class="global-sess-list" aria-label="Local Antigravity sessions"></aside>
    <main id="inspector-main" class="inspector-main"></main>
  </div>
  <script>${INSPECTOR_SCRIPT}<\/script>
</body>
</html>
`}var HARD_MAX_MCP_RESPONSE_BYTES=1048576,MAX_MCP_PAYLOAD_BYTES=9e5,TRIM_TIERS=[{maxSessions:30,maxTools:150,maxRunningTools:12,maxRecentTargets:3,maxTargetBytes:240,maxTitleBytes:240,maxWorkspaceBytes:240,maxFieldBytes:96,maxSiblings:5,maxSkills:150,maxAgents:150,maxMcps:40,maxSubtools:25,keepTargetUris:!0,maxUriBytes:1024},{maxSessions:20,maxTools:80,maxRunningTools:8,maxRecentTargets:1,maxTargetBytes:120,maxTitleBytes:160,maxWorkspaceBytes:160,maxFieldBytes:64,maxSiblings:3,maxSkills:80,maxAgents:80,maxMcps:25,maxSubtools:12,keepTargetUris:!0,maxUriBytes:1024},{maxSessions:10,maxTools:40,maxRunningTools:4,maxRecentTargets:0,maxTargetBytes:80,maxTitleBytes:120,maxWorkspaceBytes:120,maxFieldBytes:48,maxSiblings:0,maxSkills:40,maxAgents:40,maxMcps:15,maxSubtools:8,keepTargetUris:!1,maxUriBytes:0},{maxSessions:5,maxTools:15,maxRunningTools:2,maxRecentTargets:0,maxTargetBytes:60,maxTitleBytes:80,maxWorkspaceBytes:80,maxFieldBytes:40,maxSiblings:0,maxSkills:15,maxAgents:15,maxMcps:8,maxSubtools:5,keepTargetUris:!1,maxUriBytes:0}],ELLIPSIS=`…`,ELLIPSIS_BYTES=Buffer.byteLength(ELLIPSIS,`utf8`);function clipUtf8Bytes(value,maxBytes){if(maxBytes<=0)return``;if(Buffer.byteLength(value,`utf8`)<=maxBytes)return value;let budget=maxBytes>ELLIPSIS_BYTES?maxBytes-ELLIPSIS_BYTES:maxBytes,out=``,used=0;for(let ch of value){let chBytes=Buffer.byteLength(ch,`utf8`);if(used+chBytes>budget)break;out+=ch,used+=chBytes}return maxBytes>ELLIPSIS_BYTES?`${out}${ELLIPSIS}`:out}function keepIntactUri(uri,tier){return!tier.keepTargetUris||typeof uri!=`string`||uri.length===0?null:Buffer.byteLength(uri,`utf8`)<=tier.maxUriBytes?uri:null}function trimSessionItems(sessions,tier){return sessions.slice(0,tier.maxSessions).map(s=>({...s,convId:s.convId,shortId:s.shortId,title:clipUtf8Bytes(s.title,tier.maxTitleBytes),workspace:clipUtf8Bytes(s.workspace,tier.maxWorkspaceBytes),ageLabel:clipUtf8Bytes(s.ageLabel,32)}))}function trimSnapshotBody(snap,tier){let runningTools=snap.runningTools.slice(0,tier.maxRunningTools).map(rt=>({name:clipUtf8Bytes(rt.name,tier.maxFieldBytes),disp:clipUtf8Bytes(rt.disp,tier.maxFieldBytes),target:clipUtf8Bytes(rt.target,tier.maxTargetBytes),fullTarget:clipUtf8Bytes(rt.fullTarget,tier.maxTargetBytes),isMcp:rt.isMcp,fileUri:keepIntactUri(rt.fileUri,tier)})),completedTools=snap.completedTools.slice(0,tier.maxTools).map(tool=>{let rawRecent=tool.recentTargets.slice(0,tier.maxRecentTargets),recentTargets=[],targetUris={},collidedKeys=new Set;for(let origTarget of rawRecent){let clippedTarget=clipUtf8Bytes(origTarget,tier.maxTargetBytes);recentTargets.push(clippedTarget);let uri=keepIntactUri(tool.targetUris[origTarget],tier);collidedKeys.has(clippedTarget)||(Object.hasOwn(targetUris,clippedTarget)?targetUris[clippedTarget]!==uri&&(delete targetUris[clippedTarget],collidedKeys.add(clippedTarget)):uri!==null&&(targetUris[clippedTarget]=uri))}let clippedFull=clipUtf8Bytes(tool.fullTarget,tier.maxTargetBytes);if(clippedFull.length>0&&!collidedKeys.has(clippedFull)&&!Object.hasOwn(targetUris,clippedFull)){let fullUri=keepIntactUri(tool.targetUris[tool.fullTarget],tier);fullUri!==null&&(targetUris[clippedFull]=fullUri)}return{disp:clipUtf8Bytes(tool.disp,tier.maxFieldBytes),count:tool.count,latestTarget:clipUtf8Bytes(tool.latestTarget,tier.maxTargetBytes),fullTarget:clippedFull,recentTargets,targetUris,isMcp:tool.isMcp}}),mcps=snap.mcps.slice(0,tier.maxMcps).map(m=>({server:clipUtf8Bytes(m.server,tier.maxFieldBytes),totalCalls:m.totalCalls,subtools:m.subtools.slice(0,tier.maxSubtools).map(st=>({name:clipUtf8Bytes(st.name,tier.maxFieldBytes),count:st.count}))})),agents=snap.agents.slice(0,tier.maxAgents).map(a=>({...a,name:clipUtf8Bytes(a.name,tier.maxFieldBytes),type:clipUtf8Bytes(a.type,tier.maxFieldBytes),model:clipUtf8Bytes(a.model,tier.maxFieldBytes),ageLabel:clipUtf8Bytes(a.ageLabel,32)})),siblingCandidates=snap.siblingCandidates.slice(0,tier.maxSiblings).map(sib=>({...sib,convId:sib.convId,shortId:sib.shortId,title:clipUtf8Bytes(sib.title,tier.maxFieldBytes),ageLabel:clipUtf8Bytes(sib.ageLabel,32)})),todos=snap.todos===null?null:{...snap.todos,...snap.todos.current===void 0?{}:{current:clipUtf8Bytes(snap.todos.current,tier.maxTitleBytes)}};return{...snap,convId:snap.convId,shortId:snap.shortId,title:clipUtf8Bytes(snap.title,tier.maxTitleBytes),model:clipUtf8Bytes(snap.model,tier.maxFieldBytes),workspace:clipUtf8Bytes(snap.workspace,tier.maxWorkspaceBytes),ageLabel:clipUtf8Bytes(snap.ageLabel,32),siblingCandidates,siblingHint:tier.maxSiblings>0?clipUtf8Bytes(snap.siblingHint,tier.maxTitleBytes):``,runningTools,completedTools,skills:snap.skills.slice(0,tier.maxSkills).map(s=>clipUtf8Bytes(s,tier.maxFieldBytes)),mcps,agents,todos}}function applyTrimTier(payload,tier){let sessions=trimSessionItems(payload.sessions,tier);return payload.snapshot===null?{...payload,sessions,truncated:!0}:{...payload,sessions,truncated:!0,snapshot:trimSnapshotBody(payload.snapshot,tier)}}function buildMinimalTruncatedSnapshot(payload){let snap=payload.snapshot;return snap===null?{unchanged:!1,etag:clipUtf8Bytes(payload.etag,64),source:payload.source,sessions:[],snapshot:null,truncated:!0}:{unchanged:!1,etag:clipUtf8Bytes(payload.etag,64),source:payload.source,sessions:[],truncated:!0,snapshot:{...snap,convId:snap.convId,shortId:snap.shortId,title:clipUtf8Bytes(snap.title,96),model:clipUtf8Bytes(snap.model,64),workspace:clipUtf8Bytes(snap.workspace,96),ageLabel:clipUtf8Bytes(snap.ageLabel,24),siblingCandidates:[],siblingHint:``,runningTools:[],completedTools:[],skills:[],mcps:[],agents:[],todos:null}}}function capInspectorPayload(payload,maxBytes=MAX_MCP_PAYLOAD_BYTES){if(Buffer.byteLength(JSON.stringify(payload),`utf8`)<=maxBytes)return payload;for(let tier of TRIM_TIERS){let candidate=applyTrimTier(payload,tier);if(Buffer.byteLength(JSON.stringify(candidate),`utf8`)<=maxBytes)return candidate}let compact=buildMinimalTruncatedSnapshot(payload);return Buffer.byteLength(JSON.stringify(compact),`utf8`)<=maxBytes?compact:{unchanged:!1,etag:clipUtf8Bytes(payload.etag,64),source:payload.source,sessions:[],snapshot:null,truncated:!0}}function clipTextForJsonBudget(value,maxJsonBytes){if(maxJsonBytes<=2)return``;if(Buffer.byteLength(JSON.stringify(value),`utf8`)<=maxJsonBytes)return value;let lo=0,hi=Math.min(Buffer.byteLength(value,`utf8`),maxJsonBytes),best=``;for(;lo<=hi;){let mid=Math.floor((lo+hi)/2),candidate=clipUtf8Bytes(value,mid);Buffer.byteLength(JSON.stringify(candidate),`utf8`)<=maxJsonBytes?(best=candidate,lo=mid+1):hi=mid-1}return best}function safeResponseId(id,maxBytes){let probe=JSON.stringify({jsonrpc:`2.0`,id,error:{code:-32603,message:``}});return Buffer.byteLength(probe,`utf8`)+128<=maxBytes?id:null}function capRpcErrorResponse(response,maxBytes){let id=safeResponseId(response.id,maxBytes),code=response.error.code,overhead=Buffer.byteLength(JSON.stringify({jsonrpc:`2.0`,id,error:{code,message:``}}),`utf8`),budget=Math.max(2,maxBytes-overhead+2);return{jsonrpc:`2.0`,id,error:{code,message:clipTextForJsonBudget(response.error.message,budget)}}}function extractToolErrorText(result){let structured=isPlainObject(result.structuredContent)?result.structuredContent:null,code=structured!==null&&typeof structured.code==`string`?structured.code:void 0,source=structured!==null&&typeof structured.source==`string`?structured.source:void 0,sessionId=structured!==null&&(typeof structured.sessionId==`string`||structured.sessionId===null)?structured.sessionId:void 0;return structured!==null&&typeof structured.error==`string`&&structured.error.length>0?{message:structured.error,code,source,sessionId}:Array.isArray(result.content)&&isPlainObject(result.content[0])&&typeof result.content[0].text==`string`?{message:result.content[0].text,code,source,sessionId}:{message:`MCP tool error exceeded response size limit.`,code,source,sessionId}}function capToolErrorResult(id,result,maxBytes){let safeId=safeResponseId(id,maxBytes),{message,code,source,sessionId}=extractToolErrorText(result),safeCode=code===void 0?void 0:clipUtf8Bytes(code,64),safeSource=source===void 0?void 0:clipUtf8Bytes(source,16),safeSessionId=typeof sessionId==`string`?clipUtf8Bytes(sessionId,256):sessionId,build=text=>({jsonrpc:`2.0`,id:safeId,result:{isError:!0,content:[{type:`text`,text}],structuredContent:{error:text,...safeCode===void 0?{}:{code:safeCode},...safeSource===void 0?{}:{source:safeSource},...safeSessionId===void 0?{}:{sessionId:safeSessionId},truncated:!0}}}),overhead=Buffer.byteLength(JSON.stringify(build(``)),`utf8`),candidate=build(clipTextForJsonBudget(message,Math.max(2,Math.floor((maxBytes-overhead+4)/2))));return Buffer.byteLength(JSON.stringify(candidate),`utf8`)<=maxBytes?candidate:capRpcErrorResponse({jsonrpc:`2.0`,id:safeId,error:{code:-32603,message:`MCP error response exceeded size limit.`}},maxBytes)}function capJsonRpcResponse(response,maxBytes=HARD_MAX_MCP_RESPONSE_BYTES){return Buffer.byteLength(JSON.stringify(response),`utf8`)<=maxBytes?response:`error`in response?capRpcErrorResponse(response,maxBytes):isPlainObject(response.result)&&response.result.isError===!0?capToolErrorResult(response.id,response.result,maxBytes):capRpcErrorResponse({jsonrpc:`2.0`,id:response.id,error:{code:-32603,message:`MCP response exceeded 1 MiB size limit.`}},maxBytes)}var VALID_SOURCES=new Set([`auto`,`cli`,`app`,`all`]),INSPECTOR_ALLOWED_KEYS=new Set([`sessionId`,`source`]),POLL_ALLOWED_KEYS=new Set([`sessionId`,`source`,`etag`]),MCP_TOOLS=[{name:`hud_inspector`,title:`HUD Inspector`,description:`Open interactive HUD Inspector displaying live session telemetry and Activity Snapshot.`,inputSchema:{type:`object`,properties:{sessionId:{type:`string`,minLength:1,maxLength:128,description:`Optional session ID or prefix.`},source:{type:`string`,enum:[`auto`,`cli`,`app`,`all`],description:`Optional session surface filter.`}},additionalProperties:!1},_meta:{ui:{resourceUri:INSPECTOR_RESOURCE_URI,visibility:[`app`]},"com.google.antigravity/ui":{entrypoints:[{type:`aux_pane`,title:`HUD Inspector`},{type:`global`,title:`HUD Inspector`}]}}},{name:`hud_poll_snapshot`,title:`Poll HUD Snapshot`,description:`Poll read-only cross-surface Activity Snapshot and telemetry with ETag short-circuiting.`,inputSchema:{type:`object`,properties:{sessionId:{type:`string`,minLength:1,maxLength:128,description:`Optional session ID or prefix.`},source:{type:`string`,enum:[`auto`,`cli`,`app`,`all`],description:`Optional session surface filter.`},etag:{type:`string`,maxLength:64,description:`Previous snapshot ETag for unchanged short-circuit.`}},additionalProperties:!1},_meta:{ui:{visibility:[`app`]}}}],MCP_RESOURCES=[{uri:INSPECTOR_RESOURCE_URI,name:`HUD Inspector`,description:`Self-contained HUD Inspector MCP App UI (Variant A - Swarm-Native Tabs).`,mimeType:INSPECTOR_MIME_TYPE,_meta:{ui:{prefersBorder:!1}}}];function parsePollToolArgs(raw,allowEtag){if(raw==null)return{ok:!0,args:{}};if(!isPlainObject(raw))return{ok:!1,error:`Tool arguments must be an object.`};let allowedKeys=allowEtag?POLL_ALLOWED_KEYS:INSPECTOR_ALLOWED_KEYS;for(let key of Object.keys(raw))if(!allowedKeys.has(key))return{ok:!1,error:`Unknown argument: ${key}.`};let args={};if(raw.sessionId!==void 0){if(typeof raw.sessionId!=`string`||raw.sessionId.trim().length===0)return{ok:!1,error:`sessionId must be a non-empty string.`};let trimmed=raw.sessionId.trim();if(trimmed.length>128)return{ok:!1,error:`sessionId must be at most 128 characters.`};args.sessionId=trimmed}if(raw.source!==void 0){if(typeof raw.source!=`string`||!VALID_SOURCES.has(raw.source))return{ok:!1,error:`source must be one of: auto, cli, app, all.`};args.source=raw.source}if(allowEtag&&raw.etag!==void 0){if(typeof raw.etag!=`string`)return{ok:!1,error:`etag must be a string.`};if(Buffer.byteLength(raw.etag,`utf8`)>64)return{ok:!1,error:`etag must be at most 64 bytes.`};args.etag=raw.etag}return{ok:!0,args}}function extractErrorCorrelation(raw){if(!isPlainObject(raw))return{source:`auto`,sessionId:null};let source=raw.source===void 0?`auto`:typeof raw.source==`string`&&VALID_SOURCES.has(raw.source)?raw.source:void 0,sessionId=raw.sessionId===void 0?null:typeof raw.sessionId==`string`&&raw.sessionId.trim().length>0&&raw.sessionId.trim().length<=128?raw.sessionId.trim():void 0;return{...source===void 0?{}:{source},...sessionId===void 0?{}:{sessionId}}}var DEFAULT_HUD_CONFIG={preset:`full`,maxAgentChips:8,osc8Links:!0,costCurrency:`usd`,usdToCnyRate:7.25,lines:[`mode`,`identity`,`usage`,`tools`,`skills`,`mcps`,`agents`,`todos`],segments:{model:!0,git:!0,duration:!0,badges:!0,cost:!0,perf:!0,context:!0,quota:!0}},VALID_HUD_PRESETS=[`zen`,`minimal`,`compact`,`swarm`,`full`],VALID_COST_CURRENCIES=[`usd`,`cny`,`both`],DEFAULT_USD_TO_CNY_RATE=DEFAULT_HUD_CONFIG.usdToCnyRate,MIN_USD_TO_CNY_RATE=.01,MAX_USD_TO_CNY_RATE=1e3,HUD_LINE_IDS=[`mode`,`identity`,`usage`,`activity`,`tools`,`skills`,`mcps`,`agents`,`todos`],HUD_SEGMENT_IDS=[`model`,`git`,`duration`,`badges`,`cost`,`perf`,`context`,`quota`],FOCUSED_SEGMENTS={model:!0,git:!0,duration:!1,badges:!0,cost:!1,perf:!1,context:!0,quota:!0},ALL_SEGMENTS={model:!0,git:!0,duration:!0,badges:!0,cost:!0,perf:!0,context:!0,quota:!0},PRESET_TEMPLATES={zen:{lines:[`identity`],segments:FOCUSED_SEGMENTS},minimal:{lines:[`identity`,`usage`],segments:FOCUSED_SEGMENTS},compact:{lines:[`mode`,`identity`,`usage`,`activity`],segments:ALL_SEGMENTS},swarm:{lines:[`mode`,`identity`,`usage`,`agents`,`todos`],segments:ALL_SEGMENTS},full:{lines:[`mode`,`identity`,`usage`,`tools`,`skills`,`mcps`,`agents`,`todos`],segments:ALL_SEGMENTS}},HUD_PRESET_SET=new Set(VALID_HUD_PRESETS),HUD_COST_CURRENCY_SET=new Set(VALID_COST_CURRENCIES),HUD_LINE_ID_SET=new Set(HUD_LINE_IDS),HUD_SEGMENT_ID_SET=new Set(HUD_SEGMENT_IDS);new Map(HUD_LINE_IDS.map((id,idx)=>[id,idx]));function isHudPreset(value){return typeof value==`string`&&HUD_PRESET_SET.has(value)}function isHudCostCurrency(value){return typeof value==`string`&&HUD_COST_CURRENCY_SET.has(value)}function isValidUsdToCnyRate(value){return isFiniteNum(value)&&value>=.01&&value<=1e3}function isHudLineId(value){return typeof value==`string`&&HUD_LINE_ID_SET.has(value)}function isHudSegmentId(value){return typeof value==`string`&&HUD_SEGMENT_ID_SET.has(value)}function isValidMaxAgentChips(value){return isFiniteNum(value)&&Number.isInteger(value)&&value>=0&&value<=20}function cloneNarrowOverride(narrow){if(!narrow)return;let out={};return narrow.lines!==void 0&&(out.lines=[...narrow.lines]),narrow.segments!==void 0&&Object.keys(narrow.segments).length>0&&(out.segments={...narrow.segments}),out.lines!==void 0||out.segments!==void 0?out:void 0}function buildPresetConfig(preset,overrides){let tpl=PRESET_TEMPLATES[preset],narrow=cloneNarrowOverride(overrides?.narrow);return{preset,maxAgentChips:overrides?.maxAgentChips??DEFAULT_HUD_CONFIG.maxAgentChips,osc8Links:overrides?.osc8Links??DEFAULT_HUD_CONFIG.osc8Links,costCurrency:overrides?.costCurrency??DEFAULT_HUD_CONFIG.costCurrency,usdToCnyRate:overrides?.usdToCnyRate??DEFAULT_HUD_CONFIG.usdToCnyRate,lines:[...tpl.lines],segments:{...tpl.segments},...narrow===void 0?{}:{narrow}}}function parseLinesField(rawLines,fallback,strict){if(!Array.isArray(rawLines)){if(strict)throw Error(`Invalid 'lines' in hud-config.json (expected array of line IDs)`);return fallback}let deduped=[],seen=new Set;for(let item of rawLines)if(isHudLineId(item))seen.has(item)||(seen.add(item),deduped.push(item));else if(strict)throw Error(`Invalid line ID '${String(item)}' in hud-config.json (expected: ${HUD_LINE_IDS.join(` | `)})`);return deduped}function applySegmentsField(rawSegments,target,strict){if(isPlainObject(rawSegments)){for(let[segKey,segVal]of Object.entries(rawSegments))if(!UNSAFE_OBJECT_KEYS.has(segKey)){if(!isHudSegmentId(segKey)){if(strict)throw Error(`Unknown segment ID '${segKey}' in hud-config.json (expected: ${HUD_SEGMENT_IDS.join(` | `)})`)}else if(typeof segVal==`boolean`)target[segKey]=segVal;else if(strict)throw Error(`Invalid boolean 'segments.${segKey}' in hud-config.json`)}}else if(strict)throw Error(`Invalid 'segments' in hud-config.json (expected object of segment booleans)`)}function parseNarrowField(rawNarrow,strict){if(!isPlainObject(rawNarrow)){if(strict)throw Error(`Invalid 'narrow' in hud-config.json (expected object with optional 'lines' and 'segments')`);return}let out={};for(let key of Object.keys(rawNarrow))if(!UNSAFE_OBJECT_KEYS.has(key)&&key!==`lines`&&key!==`segments`&&strict)throw Error(`Unknown key 'narrow.${key}' in hud-config.json (expected: lines | segments)`);if(rawNarrow.lines!==void 0){if(Array.isArray(rawNarrow.lines)){let deduped=[],seen=new Set;for(let item of rawNarrow.lines)if(isHudLineId(item))seen.has(item)||(seen.add(item),deduped.push(item));else if(strict)throw Error(`Invalid line ID '${String(item)}' in hud-config.json 'narrow.lines' (expected: ${HUD_LINE_IDS.join(` | `)})`);out.lines=deduped}else if(strict)throw Error(`Invalid 'narrow.lines' in hud-config.json (expected array of line IDs)`)}if(rawNarrow.segments!==void 0){if(isPlainObject(rawNarrow.segments)){let cleanSegs={};for(let[segKey,segVal]of Object.entries(rawNarrow.segments))if(!UNSAFE_OBJECT_KEYS.has(segKey)){if(!isHudSegmentId(segKey)){if(strict)throw Error(`Unknown segment ID '${segKey}' in hud-config.json 'narrow.segments' (expected: ${HUD_SEGMENT_IDS.join(` | `)})`)}else if(typeof segVal==`boolean`)cleanSegs[segKey]=segVal;else if(strict)throw Error(`Invalid boolean 'narrow.segments.${segKey}' in hud-config.json`)}Object.keys(cleanSegs).length>0&&(out.segments=cleanSegs)}else if(strict)throw Error(`Invalid 'narrow.segments' in hud-config.json (expected object of segment booleans)`)}return out.lines!==void 0||out.segments!==void 0?out:void 0}function parseHudConfig(raw,strict){if(!raw)return buildPresetConfig(DEFAULT_HUD_CONFIG.preset);let seedPreset=DEFAULT_HUD_CONFIG.preset;if(raw.preset!==void 0){if(isHudPreset(raw.preset))seedPreset=raw.preset;else if(strict)throw Error(`Invalid 'preset' in hud-config.json (expected: ${VALID_HUD_PRESETS.join(` | `)})`)}let next=buildPresetConfig(seedPreset);if(raw.maxAgentChips!==void 0){if(isValidMaxAgentChips(raw.maxAgentChips))next.maxAgentChips=raw.maxAgentChips;else if(strict)throw Error(`Invalid 'maxAgentChips' in hud-config.json (expected integer 0..20)`)}if(raw.osc8Links!==void 0){if(typeof raw.osc8Links==`boolean`)next.osc8Links=raw.osc8Links;else if(strict)throw Error(`Invalid boolean 'osc8Links' in hud-config.json`)}if(raw.costCurrency!==void 0){if(isHudCostCurrency(raw.costCurrency))next.costCurrency=raw.costCurrency;else if(strict)throw Error(`Invalid 'costCurrency' in hud-config.json (expected: ${VALID_COST_CURRENCIES.join(` | `)})`)}if(raw.usdToCnyRate!==void 0){if(isValidUsdToCnyRate(raw.usdToCnyRate))next.usdToCnyRate=raw.usdToCnyRate;else if(strict)throw Error(`Invalid 'usdToCnyRate' in hud-config.json (expected number ${MIN_USD_TO_CNY_RATE}..${MAX_USD_TO_CNY_RATE})`)}if(raw.lines!==void 0&&(next.lines=parseLinesField(raw.lines,next.lines,strict)),raw.segments!==void 0&&applySegmentsField(raw.segments,next.segments,strict),raw.narrow!==void 0){let parsedNarrow=parseNarrowField(raw.narrow,strict);parsedNarrow!==void 0&&(next.narrow=parsedNarrow)}return next}function mergeHudConfig(raw){return parseHudConfig(raw,!1)}function appendUniqueItem(seq,seen,value){value.length>0&&!seen.has(value)&&(seen.add(value),seq.push(value))}function parseTranscriptCacheMeta(raw){return typeof raw.path!=`string`||!isFiniteNum(raw.ino)||!isFiniteNum(raw.mtimeMs)||typeof raw.mtimeNs!=`string`||raw.mtimeNs.length===0||typeof raw.ctimeNs!=`string`||raw.ctimeNs.length===0||!isFiniteNum(raw.size)||typeof raw.contentHash!=`string`||raw.contentHash.length===0||!isFiniteNum(raw.stableOffset)||typeof raw.stablePrefixHash!=`string`||raw.stablePrefixHash.length===0||!isFiniteNum(raw.stableToolsCount)||!isFiniteNum(raw.stableSkillsCount)||!isFiniteNum(raw.stableMcpsCount)||!isFiniteNum(raw.stableAgentsCount)||typeof raw.stableLastModel!=`string`?null:{path:raw.path,ino:raw.ino,mtimeMs:raw.mtimeMs,mtimeNs:raw.mtimeNs,ctimeNs:raw.ctimeNs,size:raw.size,contentHash:raw.contentHash,stableOffset:raw.stableOffset,stablePrefixHash:raw.stablePrefixHash,stableToolsCount:raw.stableToolsCount,stableSkillsCount:raw.stableSkillsCount,stableMcpsCount:raw.stableMcpsCount,stableAgentsCount:raw.stableAgentsCount,stableLastModel:raw.stableLastModel}}function matchReusablePrefix(fd,transcriptPath,ino,size,seed){let{meta}=seed;if(meta.path!==transcriptPath||meta.ino!==ino||meta.stableOffset<=0||meta.stableOffset>size||meta.stableToolsCount<0||meta.stableToolsCount>seed.tools.length||meta.stableSkillsCount<0||meta.stableSkillsCount>seed.skills.length||meta.stableMcpsCount<0||meta.stableMcpsCount>seed.mcps.length||meta.stableAgentsCount<0||meta.stableAgentsCount>seed.agents.length||size===meta.size)return null;let{digest,fullHash}=computeFullFdRangeHash(fd,meta.stableOffset);return digest===meta.stablePrefixHash?{seed,prefixHash:fullHash}:null}function recordScannedToolCall(tc,ctx,isRunning,stepTs){if(!isPlainObject(tc))return;let name=typeof tc.name==`string`?sanitizeTerminalLabel(tc.name):``;if(name.length===0)return;let args=isPlainObject(tc.args)?tc.args:isPlainObject(tc.arguments)?tc.arguments:void 0,rawTarget=extractToolTarget(name,args),fullTarget=sanitizeFullTarget(rawTarget),targetLinkable=fullTarget.length>0&&rawTarget===fullTarget,skillName=(name===`read_file`||name===`view_file`)&&fullTarget.length>0?resolveSkillName(fullTarget,ctx.skillRootDir,ctx.workspaceDir):null;skillName!==null&&appendUniqueItem(ctx.skills,ctx.skillsSeen,skillName);let mcpInfo=parseMcpTool(name,args,ctx.mcpServers);if(mcpInfo!==null&&appendUniqueItem(ctx.mcps,ctx.mcpsSeen,mcpInfo[0]),name===`invoke_subagent`&&args){let cleanRole=sanitizeTerminalLabel(unwrapArg(args.Role)),cleanType=sanitizeTerminalLabel(unwrapArg(args.TypeName)),cleanModel=sanitizeTerminalLabel(unwrapArg(args.Model)),role=nonEmptyStr(cleanRole)??nonEmptyStr(cleanType)??`subagent`;ctx.agents.push({name:role,type:cleanType,model:cleanModel===`inherit`?``:cleanModel,running:isRunning,ts:stepTs})}ctx.tools.push(ctx.projectToolCall({name,disp:mcpInfo===null?name:`${mcpInfo[0]}:${mcpInfo[1]}`,fullTarget,targetLinkable,running:isRunning,isSkillRead:skillName!==null,mcpServer:mcpInfo===null?null:mcpInfo[0],mcpSubtool:mcpInfo===null?null:mcpInfo[1]}))}function scanTranscriptWithCache(options){let{transcriptPath,seed}=options,fd;try{fd=openSync(transcriptPath,`r`)}catch{return null}try{let st=fstatSync(fd,{bigint:!0});if(!st.isFile())return null;let ino=Number(st.ino),size=Number(st.size),mtimeMs=Number(st.mtimeMs),mtimeNs=st.mtimeNs.toString(),ctimeNs=st.ctimeNs.toString();if(seed!=null&&seed.meta.path===transcriptPath&&seed.meta.ino===ino&&seed.meta.size===size&&seed.meta.mtimeNs===mtimeNs&&seed.meta.ctimeNs===ctimeNs&&computeFdRangeFingerprint(fd,size).digest===seed.meta.contentHash)return{cacheHit:!0,cacheable:!1,meta:seed.meta,tools:[...seed.tools],skills:[...seed.skills],mcps:[...seed.mcps],agents:[...seed.agents],lastModel:seed.lastModel};let reusable=seed==null?null:matchReusablePrefix(fd,transcriptPath,ino,size,seed),resumeSeed=reusable?.seed??null,prefixHash=reusable?.prefixHash??null,startOffset=resumeSeed===null?0:resumeSeed.meta.stableOffset,tools=resumeSeed===null?[]:resumeSeed.tools.slice(0,resumeSeed.meta.stableToolsCount),skills=resumeSeed===null?[]:resumeSeed.skills.slice(0,resumeSeed.meta.stableSkillsCount),skillsSeen=new Set(skills),mcps=resumeSeed===null?[]:resumeSeed.mcps.slice(0,resumeSeed.meta.stableMcpsCount),mcpsSeen=new Set(mcps),agents=resumeSeed===null?[]:resumeSeed.agents.slice(0,resumeSeed.meta.stableAgentsCount),lastModel=resumeSeed===null?``:resumeSeed.meta.stableLastModel,ctx={skillRootDir:options.skillRootDir,workspaceDir:options.workspaceDir,mcpServers:options.mcpServers,projectToolCall:options.projectToolCall,tools,skills,skillsSeen,mcps,mcpsSeen,agents},stableOffset=startOffset,stableToolsCount=tools.length,stableSkillsCount=skills.length,stableMcpsCount=mcps.length,stableAgentsCount=agents.length,stableLastModel=lastModel,sawRunningStep=!1,markStable=offset=>{stableOffset=offset,stableToolsCount=tools.length,stableSkillsCount=skills.length,stableMcpsCount=mcps.length,stableAgentsCount=agents.length,stableLastModel=lastModel},chunkBuf=readFdRange(fd,startOffset,size-startOffset);options.onAfterChunkRead?.();let cursor=0;for(;cursor<chunkBuf.length;){let nlIdx=chunkBuf.indexOf(10,cursor);if(nlIdx===-1)break;let lineStart=startOffset+cursor,lineEnd=startOffset+nlIdx+1,rawLine=chunkBuf.subarray(cursor,nlIdx).toString(`utf8`).trim();if(cursor=nlIdx+1,rawLine.length===0){sawRunningStep||(stableOffset=lineEnd);continue}let step;try{step=JSON.parse(rawLine)}catch{continue}if(!isPlainObject(step))continue;if(step.type===`USER_INPUT`){let rawContent=typeof step.content==`string`?step.content:``;for(let sk of extractUserInputSkills(rawContent))appendUniqueItem(skills,skillsSeen,sk);sawRunningStep||markStable(lineEnd);continue}if(step.type!==`PLANNER_RESPONSE`){sawRunningStep||markStable(lineEnd);continue}let status=typeof step.status==`string`?step.status.toUpperCase():``,isRunning=RUNNING_STEP_STATUSES.has(status);if(isRunning&&!sawRunningStep&&(sawRunningStep=!0,markStable(lineStart)),typeof step.model==`string`){let cleanModel=sanitizeTerminalLabel(step.model);cleanModel.length>0&&(lastModel=cleanModel)}let stepTs=parseIsoTimestampSec(step.created_at),toolCalls=Array.isArray(step.tool_calls)?step.tool_calls:[];for(let tc of toolCalls)recordScannedToolCall(tc,ctx,isRunning,stepTs);sawRunningStep||markStable(lineEnd)}let parsedSize=startOffset+chunkBuf.length,contentHash=computeParsedRangeFingerprint(fd,startOffset,chunkBuf,parsedSize,prefixHash),stablePrefixHash=stableOffset===parsedSize&&parsedSize<=524288?contentHash:stableOffset===startOffset&&resumeSeed!==null?resumeSeed.meta.stablePrefixHash:computeFullParsedRangeHash(fd,startOffset,chunkBuf,stableOffset,prefixHash),stAfter=fstatSync(fd,{bigint:!0});return{cacheHit:!1,cacheable:chunkBuf.length===size-startOffset&&stAfter.ino===st.ino&&stAfter.size===st.size&&stAfter.mtimeNs===st.mtimeNs&&stAfter.ctimeNs===st.ctimeNs,meta:{path:transcriptPath,ino,mtimeMs,mtimeNs,ctimeNs,size:parsedSize,contentHash,stableOffset,stablePrefixHash,stableToolsCount,stableSkillsCount,stableMcpsCount,stableAgentsCount,stableLastModel},tools,skills,mcps,agents,lastModel}}catch{return null}finally{closeSync(fd)}}var MAX_ACTIVITY_CACHE_BYTES=16777216;function parseSanitizedStringList(value){if(!Array.isArray(value))return null;let items=[];for(let item of value){if(typeof item!=`string`)return null;let clean=sanitizeTerminalLabel(item);clean.length>0&&items.push(clean)}return items}function isActivityAgentEntry(value){return isPlainObject(value)&&typeof value.name==`string`&&typeof value.type==`string`&&typeof value.model==`string`&&typeof value.running==`boolean`&&(value.ts===null||isFiniteNum(value.ts))}function parseActivityAgents(value){if(!Array.isArray(value))return null;let agents=[];for(let entry of value){if(!isActivityAgentEntry(entry))return null;agents.push({name:sanitizeTerminalLabel(entry.name),type:sanitizeTerminalLabel(entry.type),model:sanitizeTerminalLabel(entry.model),running:entry.running,ts:entry.ts})}return agents}function writeBoundedPrivateJsonCache(cacheFile,record,maxBytes=MAX_ACTIVITY_CACHE_BYTES){try{let serialized=Buffer.from(JSON.stringify(record),`utf8`);return serialized.byteLength>maxBytes?!1:(writeBufferAtomicSync(cacheFile,serialized,384),!0)}catch{return!1}}function readCliSettings(cliHome){let loaded=readBoundedJsonObjectSync(path.join(cliHome,`settings.json`));return loaded===null?{}:loaded}function readCliFallbackModel(cliHome){return sanitizeTerminalLabel(nonEmptyStr(readCliSettings(cliHome).model)??``)}function readHudConfig(cliHome){return mergeHudConfig(readBoundedJsonObjectSync(path.join(cliHome,`hud-config.json`)))}var SNAPSHOT_ACTIVITY_CACHE_VERSION=4,MAX_SNAPSHOT_CACHE_BYTES=MAX_ACTIVITY_CACHE_BYTES;function parseSnapshotToolRecord(value){if(!isPlainObject(value)||typeof value.name!=`string`||typeof value.disp!=`string`||typeof value.target!=`string`||typeof value.fullTarget!=`string`||typeof value.targetLinkable!=`boolean`||typeof value.running!=`boolean`||typeof value.isSkillRead!=`boolean`)return null;let mcpServer=typeof value.mcpServer==`string`?sanitizeTerminalLabel(value.mcpServer):value.mcpServer===null?null:void 0,mcpSubtool=typeof value.mcpSubtool==`string`?sanitizeTerminalLabel(value.mcpSubtool):value.mcpSubtool===null?null:void 0;if(mcpServer===void 0||mcpSubtool===void 0)return null;let cleanFullTarget=sanitizeTerminalLabel(value.fullTarget),targetLinkable=value.targetLinkable&&cleanFullTarget.length>0&&value.fullTarget===cleanFullTarget;return{name:sanitizeTerminalLabel(value.name),disp:sanitizeTerminalLabel(value.disp),target:sanitizeTerminalLabel(value.target),fullTarget:cleanFullTarget,targetLinkable,running:value.running,isSkillRead:value.isSkillRead,mcpServer:mcpServer!==null&&mcpServer.length>0?mcpServer:null,mcpSubtool:mcpSubtool!==null&&mcpSubtool.length>0?mcpSubtool:null}}function readSnapshotTranscriptCache(cacheFile){let parsed=readRegularJsonObjectSync(cacheFile,MAX_SNAPSHOT_CACHE_BYTES,{requirePrivateMode:!0});if(parsed===null||parsed.v!==SNAPSHOT_ACTIVITY_CACHE_VERSION)return null;let meta=parseTranscriptCacheMeta(parsed);if(meta===null||!isPlainObject(parsed.data)||!Array.isArray(parsed.data.tools)||!Array.isArray(parsed.data.skills)||!Array.isArray(parsed.data.agents)||typeof parsed.data.lastModel!=`string`)return null;let tools=[];for(let item of parsed.data.tools){let rec=parseSnapshotToolRecord(item);if(rec===null)return null;tools.push(rec)}let skills=parseSanitizedStringList(parsed.data.skills),agents=parseActivityAgents(parsed.data.agents);return skills===null||agents===null?null:{v:SNAPSHOT_ACTIVITY_CACHE_VERSION,...meta,data:{tools,skills,agents,lastModel:sanitizeTerminalLabel(parsed.data.lastModel)}}}function mergeMcpServerLists(dataRoot,cacheCliHome){return[...new Set([...listMcpServers(dataRoot),...listMcpServers(cacheCliHome)])].sort((a,b)=>b.length-a.length)}function projectSnapshotToolCall(call){return{name:call.name,disp:call.disp,target:call.fullTarget.length>0?shortenTarget(call.fullTarget,34):``,fullTarget:call.fullTarget,targetLinkable:call.targetLinkable,running:call.running,isSkillRead:call.isSkillRead,mcpServer:call.mcpServer,mcpSubtool:call.mcpSubtool}}function loadSnapshotTranscript(session,cacheCliHome){let empty={tools:[],skills:[],agents:[],lastModel:``},safeId=sanitizeSessionId(session.convId);if(safeId===null)return empty;let transcriptPath=resolveCliSubdirFile(session.dataRoot,`brain`,safeId,`.system_generated`,`logs`,`transcript.jsonl`);if(transcriptPath===null||!existsSync(transcriptPath))return empty;let cacheFile=resolveCliSubdirFile(cacheCliHome,`cache`,`agy_hud_activity_snapshot_${safeId}.json`),cached=cacheFile===null?null:readSnapshotTranscriptCache(cacheFile),cachedMcps=[];if(cached!==null){let seenMcp=new Set;for(let tool of cached.data.tools)tool.mcpServer!==null&&!seenMcp.has(tool.mcpServer)&&(seenMcp.add(tool.mcpServer),cachedMcps.push(tool.mcpServer))}let scanned=scanTranscriptWithCache({transcriptPath,skillRootDir:session.dataRoot,workspaceDir:session.workspace.length>0?session.workspace:void 0,mcpServers:mergeMcpServerLists(session.dataRoot,cacheCliHome),seed:cached===null?null:{meta:cached,tools:cached.data.tools,skills:cached.data.skills,mcps:cachedMcps,agents:cached.data.agents,lastModel:cached.data.lastModel},projectToolCall:projectSnapshotToolCall});if(scanned===null)return empty;if(scanned.cacheHit&&cached!==null)return cached.data;let data={tools:scanned.tools,skills:scanned.skills,agents:scanned.agents,lastModel:scanned.lastModel};return cacheFile!==null&&scanned.cacheable&&writeBoundedPrivateJsonCache(cacheFile,{v:SNAPSHOT_ACTIVITY_CACHE_VERSION,...scanned.meta,data},MAX_SNAPSHOT_CACHE_BYTES),data}var MAX_RECENT_TARGETS=6;function resolveToolMcpPair(call,knownSet){if(typeof call.mcpServer==`string`&&typeof call.mcpSubtool==`string`)return call.mcpServer.length>0&&call.mcpSubtool.length>0?[call.mcpServer,call.mcpSubtool]:null;if(call.mcpServer===null||call.mcpSubtool===null)return null;let colonIdx=call.disp.indexOf(`:`);if(colonIdx<=0||colonIdx>=call.disp.length-1)return null;let prefix=call.disp.slice(0,colonIdx),subtool=call.disp.slice(colonIdx+1);return knownSet.has(prefix)||prefix!==`mcp`&&(call.name.startsWith(`mcp`)||call.name===`call_mcp_tool`||call.name===`list_resources`||call.name===`read_resource`)?[prefix,subtool]:null}function aggregateActivityTools(tools,options={}){let knownServers=options.knownMcpServers??[],targetDisplayLen=options.targetDisplayLen??34,hideSkillReads=options.hideSkillReads??!0,preferEntryTarget=options.preferEntryTarget===!0,collectMcps=options.collectMcps!==!1,collectRunning=options.collectRunning!==!1,runningTools=[],completedMap=new Map,mcpOrder=[],mcpSubMap=new Map,ensureServer=server=>{let subCounts=mcpSubMap.get(server);return subCounts||(mcpOrder.push(server),subCounts=new Map,mcpSubMap.set(server,subCounts)),subCounts};if(collectMcps)for(let srv of knownServers)srv.length>0&&ensureServer(srv);let knownSet=new Set(knownServers),totalToolCalls=0;for(let call of tools){let mcpPair=collectMcps?resolveToolMcpPair(call,knownSet):null;if(mcpPair!==null){let subCounts=ensureServer(mcpPair[0]);subCounts.set(mcpPair[1],(subCounts.get(mcpPair[1])??0)+1)}if(hideSkillReads&&call.isSkillRead||(totalToolCalls+=1,call.running&&!collectRunning))continue;let disp=call.disp.length>0?call.disp:call.name,rawTarget=typeof call.fullTarget==`string`&&call.fullTarget.length>0?call.fullTarget:call.target;if(call.running){runningTools.push({name:call.name,disp,target:call.target,fullTarget:rawTarget,...call.targetLinkable===!1?{targetLinkable:!1}:{},isMcp:mcpPair!==null});continue}let prev=completedMap.get(disp)??{count:0,targets:[],unlinkedTargets:new Set,latestShort:``,isMcp:mcpPair!==null};if(prev.count+=1,call.target.length>0&&(prev.latestShort=call.target),rawTarget.length>0){let existingIdx=prev.targets.indexOf(rawTarget);existingIdx!==-1&&prev.targets.splice(existingIdx,1),prev.targets.unshift(rawTarget),prev.targets.length>MAX_RECENT_TARGETS&&prev.targets.pop(),call.targetLinkable===!1&&prev.unlinkedTargets.add(rawTarget)}completedMap.set(disp,prev)}let completedTools=[...completedMap.entries()].map(([disp,info])=>{let fullTarget=info.targets[0]??``,unlinkedTargets=info.targets.filter(target=>info.unlinkedTargets.has(target));return{disp,count:info.count,latestTarget:preferEntryTarget?info.latestShort:fullTarget.length>0?shortenTarget(fullTarget,targetDisplayLen):info.latestShort,fullTarget,recentTargets:info.targets,...unlinkedTargets.length>0?{unlinkedTargets}:{},isMcp:info.isMcp}}).sort((a,b)=>b.count===a.count?a.disp.localeCompare(b.disp):b.count-a.count),mcps=mcpOrder.map(server=>{let subtools=[...mcpSubMap.get(server)?.entries()??[]].map(([name,count])=>({name,count})).sort((a,b)=>b.count===a.count?a.name.localeCompare(b.name):b.count-a.count);return{server,totalCalls:subtools.reduce((sum,item)=>sum+item.count,0),subtools}});return{runningTools,completedTools,totalToolCalls,mcps}}function mergeActivityAgents(agentsSummary,transcriptAgents,nowMs){let kind=agentsSummary?.kind??`agents`,combined=agentsSummary?[...agentsSummary.entries]:[];if(!agentsSummary)for(let ta of transcriptAgents)combined.push({name:cleanAgentLabel(ta.name,``,ta.type),type:ta.type,model:ta.model,state:ta.running?`working`:`done`,ts:ta.ts});else if(transcriptAgents.length>0){let existingDoneCounts=new Map;for(let entry of combined){if(entry.state!==`done`)continue;let key=entry.name.toLowerCase();existingDoneCounts.set(key,(existingDoneCounts.get(key)??0)+1)}for(let ta of transcriptAgents){if(ta.running)continue;let label=cleanAgentLabel(ta.name,``,ta.type),key=label.toLowerCase(),remaining=existingDoneCounts.get(key)??0;remaining>0?existingDoneCounts.set(key,remaining-1):combined.push({name:label,type:ta.type,model:ta.model,state:`done`,ts:ta.ts})}}return{kind,entries:combined.map(entry=>({name:sanitizeTerminalLabel(entry.name),type:nonEmptyStr(sanitizeTerminalText(entry.type))??(kind===`swarm`?`worker`:`subagent`),model:nonEmptyStr(sanitizeTerminalText(entry.model))??`inherit`,state:entry.state,ts:entry.ts,ageLabel:entry.ts===null?entry.state===`done`?`recent`:`live`:formatRelativeAge(nowMs-entry.ts*1e3)}))}}var TASK_LINE_RE=/^\s*[-*]\s*\[([ xX/])\]\s+(.+)$/;function parseTaskFileCounts(taskFile){try{let lines=readFileSync(taskFile,`utf8`).split(/\r?\n/),total=0,completed=0,current=``;for(let line of lines){let match=TASK_LINE_RE.exec(line);match?.[1]&&match[2]&&(total+=1,match[1].toLowerCase()===`x`?completed+=1:match[1]===`/`&&current.length===0&&(current=sanitizeTerminalLabel(match[2])))}return total>0?{total,completed,current}:null}catch{return null}}function loadTodos(cliHome,data){let info={},convId=resolveConversationId(data);if(convId!==null){let taskFile=resolveCliSubdirFile(cliHome,`brain`,convId,`task.md`),counts=taskFile!==null&&existsSync(taskFile)?parseTaskFileCounts(taskFile):null;counts!==null&&(info.total=counts.total,info.completed=counts.completed,info.current=counts.current)}return typeof data.task_count==`number`&&Number.isInteger(data.task_count)&&data.task_count>0&&(info.taskCount=data.task_count),info.total!==void 0||info.taskCount!==void 0?info:null}var UTF8_DECODER=new TextDecoder(`utf-8`),INT_STR_RE=/^-?\d+$/,MAX_VARINT_BYTES=10,MAX_SAFE_VARINT=BigInt(2**53-1),MAX_UINT32_TAG=0xffffffff,MAX_PROTO_BLOB_BYTES=1048576;function readVarintRaw(buf,start){let val=0n,shift=0n,pos=start;for(let count=0;count<MAX_VARINT_BYTES&&pos<buf.length;count+=1){let byte=buf[pos];if(byte===void 0||count===9&&byte>1)return null;if(pos+=1,val|=BigInt(byte&127)<<shift,!(byte&128))return[val,pos];shift+=7n}return null}function readSafeVarint(buf,start){let raw=readVarintRaw(buf,start);return raw===null||raw[0]>MAX_SAFE_VARINT?null:[Number(raw[0]),raw[1]]}function readProtoTag(buf,pos){let tagRes=readSafeVarint(buf,pos);if(tagRes===null)return null;let[tag,tagEnd]=tagRes;if(tag<=0||tag>MAX_UINT32_TAG)return null;let fnum=tag>>>3;return fnum===0?null:[fnum,tag&7,tagEnd]}function readLengthDelimited(buf,pos){let lenRes=readSafeVarint(buf,pos);if(lenRes===null)return null;let[len,next]=lenRes;return len<0||next+len>buf.length?null:[buf.subarray(next,next+len),next+len]}function skipWireValue(buf,pos,wireType){if(wireType===0){let raw=readVarintRaw(buf,pos);return raw===null?-1:raw[1]}if(wireType===1)return pos+8<=buf.length?pos+8:-1;if(wireType===2){let slice=readLengthDelimited(buf,pos);return slice===null?-1:slice[1]}return wireType===5&&pos+4<=buf.length?pos+4:-1}function parseKvStepIdx(buf){if(buf.length===0||buf.length>1048576)return null;let pos=0,key=``,val=``;for(;pos<buf.length;){let header=readProtoTag(buf,pos);if(header===null)break;let[fnum,wtype,tagEnd]=header;if(pos=tagEnd,wtype===2&&(fnum===1||fnum===2)){let slice=readLengthDelimited(buf,pos);if(slice===null)break;let text=UTF8_DECODER.decode(slice[0]);pos=slice[1],fnum===1?key=text:val=text}else if(pos=skipWireValue(buf,pos,wtype),pos<0)break}if(key!==`last_step_index`)return null;let trimmed=val.trim();return INT_STR_RE.test(trimmed)?Number.parseInt(trimmed,10):null}function parseDurationProto(buf){let pos=0,sec=0,nanos=0;for(;pos<buf.length;){let header=readProtoTag(buf,pos);if(header===null)break;let[fnum,wtype,tagEnd]=header;if(pos=tagEnd,wtype===0&&(fnum===1||fnum===2)){let valRes=readSafeVarint(buf,pos);if(valRes===null)break;pos=valRes[1],fnum===1?sec=valRes[0]:nanos=valRes[0]}else if(pos=skipWireValue(buf,pos,wtype),pos<0)break}return sec+nanos/1e9}function parseUsageProto(buf){let pos=0,usage={in:0,out:0,cw:0,cr:0};for(;pos<buf.length;){let header=readProtoTag(buf,pos);if(header===null)break;let[fnum,wtype,tagEnd]=header;if(pos=tagEnd,wtype===0&&fnum>=2&&fnum<=5){let valRes=readSafeVarint(buf,pos);if(valRes===null)break;pos=valRes[1],fnum===2?usage.in=valRes[0]:fnum===3?usage.out=valRes[0]:fnum===4?usage.cw=valRes[0]:usage.cr=valRes[0]}else if(pos=skipWireValue(buf,pos,wtype),pos<0)break}return usage}function parseCtxWindowProto(buf){let pos=0,used=0,limit=0;for(;pos<buf.length;){let header=readProtoTag(buf,pos);if(header===null)break;let[fnum,wtype,tagEnd]=header;if(pos=tagEnd,wtype===0&&(fnum===1||fnum===4)){let valRes=readSafeVarint(buf,pos);if(valRes===null)break;pos=valRes[1],fnum===1?used=valRes[0]:limit=valRes[0]}else if(pos=skipWireValue(buf,pos,wtype),pos<0)break}return[used,limit]}function parseChatStartProto(buf){let pos=0;for(;pos<buf.length;){let header=readProtoTag(buf,pos);if(header===null)break;let[fnum,wtype,tagEnd]=header;if(pos=tagEnd,wtype===2&&fnum===10){let slice=readLengthDelimited(buf,pos);return slice===null?[0,0]:parseCtxWindowProto(slice[0])}if(pos=skipWireValue(buf,pos,wtype),pos<0)break}return[0,0]}function parseChatModelProto(buf){let pos=0,row={in:0,out:0,cw:0,cr:0,ttft:0,stream:0,ctxUsed:0,ctxMax:0,stepIdx:-1};for(;pos<buf.length;){let header=readProtoTag(buf,pos);if(header===null)break;let[fnum,wtype,tagEnd]=header;if(pos=tagEnd,wtype===2&&(fnum===4||fnum===9||fnum===11||fnum===12||fnum===20)){let slice=readLengthDelimited(buf,pos);if(slice===null)break;let[sub,nextPos]=slice;if(pos=nextPos,fnum===4)Object.assign(row,parseUsageProto(sub));else if(fnum===9){let[used,max]=parseChatStartProto(sub);row.ctxUsed=used,row.ctxMax=max}else if(fnum===11)row.ttft=Math.round(parseDurationProto(sub)*1e4)/1e4;else if(fnum===12)row.stream=Math.round(parseDurationProto(sub)*1e4)/1e4;else{let parsedStepIdx=parseKvStepIdx(sub);parsedStepIdx!==null&&(row.stepIdx=parsedStepIdx)}}else if(pos=skipWireValue(buf,pos,wtype),pos<0)break}return row}function parseGenMetadataBlob(blob){if(!blob||blob.length===0||blob.length>1048576)return null;let pos=0;for(;pos<blob.length;){let header=readProtoTag(blob,pos);if(header===null)break;let[fnum,wtype,tagEnd]=header;if(pos=tagEnd,wtype===2&&fnum===1){let slice=readLengthDelimited(blob,pos);return slice===null||slice[0].length===0?null:parseChatModelProto(slice[0])}if(pos=skipWireValue(blob,pos,wtype),pos<0)break}return null}var STEP_TYPE_CHECKPOINT=23,STEP_TYPE_PLANNER=15,STEP_STATUS_DONE=3;function toInt(val){return typeof val==`number`&&Number.isFinite(val)?Math.trunc(val):typeof val==`bigint`?Number(val):0}function isCompactionCheckpoint(val){return isPlainObject(val)&&typeof val.idx==`number`&&typeof val.payloadLen==`number`&&typeof val.hasPostPlanner==`boolean`}function fetchLatestCheckpoint(db){try{let ckptRow=db.prepare(`SELECT idx, LENGTH(step_payload) AS plen FROM steps WHERE step_type = ${STEP_TYPE_CHECKPOINT} AND status = ${STEP_STATUS_DONE} ORDER BY idx DESC LIMIT 1`).get();if(!isPlainObject(ckptRow))return null;let ckptIdx=toInt(ckptRow.idx);return{idx:ckptIdx,payloadLen:Math.max(0,toInt(ckptRow.plen)),hasPostPlanner:db.prepare(`SELECT 1 AS ok FROM steps WHERE idx > ? AND step_type = ${STEP_TYPE_PLANNER} AND status = ${STEP_STATUS_DONE} LIMIT 1`).get(ckptIdx)!=null}}catch{return null}}function isCompactionActive(validRows,ckpt){if(ckpt===null)return!1;let lastRow=validRows[validRows.length-1],lastStepIdx=lastRow?.stepIdx??-1;return lastRow&&lastStepIdx>=0?ckpt.idx>lastStepIdx:!ckpt.hasPostPlanner}function computeCompactedUsed(validRows,ckpt){let lastRow=validRows[validRows.length-1],preIn=lastRow?lastRow.in+lastRow.cw+lastRow.cr:0,preHist=lastRow?lastRow.ctxUsed:0;return(preIn>preHist&&preHist>0?preIn-preHist:0)+Math.max(1,Math.floor(ckpt.payloadLen/4))}var TELEMETRY_CACHE_VERSION=2,MIN_STREAM_WINDOW_SEC=.5,MAX_BURST_STREAM_TPS=400;function toNumber(val){return typeof val==`number`?val:typeof val==`bigint`?Number(val):0}function fetchUpdatedRows(dbPath,cachedRows){return withReadonlyDb(dbPath,db=>{let ckpt=fetchLatestCheckpoint(db),statsRow=db.prepare(`SELECT COUNT(*) AS cnt, COALESCE(MAX(idx), -1) AS max_idx FROM gen_metadata`).get(),count=isPlainObject(statsRow)?toNumber(statsRow.cnt):0;if(count===0)return{rows:{},ckpt};let seed=cachedRows;count<Object.keys(cachedRows).length&&(seed={});let keys=Object.keys(seed).map(k=>Number.parseInt(k,10)).filter(n=>Number.isFinite(n)),startIdx=keys.length>0?Math.max(...keys):0,updated={...seed},rows=db.prepare(`SELECT idx, CASE WHEN typeof(data) = 'blob' AND length(data) <= ? THEN data ELSE NULL END AS data FROM gen_metadata WHERE idx >= ? ORDER BY idx`).iterate(MAX_PROTO_BLOB_BYTES,startIdx);for(let row of rows){if(!isPlainObject(row))continue;let idx=toNumber(row.idx),parsed=parseGenMetadataBlob(row.data instanceof Uint8Array?row.data:null);parsed===null?delete updated[String(idx)]:updated[String(idx)]=parsed}return{rows:updated,ckpt}})}function isGenMetadataRow(value){return isPlainObject(value)&&isFiniteNum(value.in)&&isFiniteNum(value.out)&&isFiniteNum(value.cw)&&isFiniteNum(value.cr)&&isFiniteNum(value.ttft)&&isFiniteNum(value.stream)&&isFiniteNum(value.ctxUsed)&&isFiniteNum(value.ctxMax)&&(value.stepIdx===void 0||isFiniteNum(value.stepIdx))}function parseCachedRows(value){if(!isPlainObject(value))return null;let rows={};for(let[key,entry]of Object.entries(value)){if(!isGenMetadataRow(entry))return null;rows[key]=entry}return rows}function readTelemetryCache(cacheFile,expectedVersionTag){let parsed=readRegularJsonObjectSync(cacheFile,MAX_ACTIVITY_CACHE_BYTES,{requirePrivateMode:!0});if(parsed===null||parsed.v!==TELEMETRY_CACHE_VERSION)return{hit:!1,rows:{},ckpt:null};let versionTag=typeof parsed.versionTag==`string`&&parsed.versionTag.length>0?parsed.versionTag:null,rows=parseCachedRows(parsed.rows);if(versionTag===null||rows===null)return{hit:!1,rows:{},ckpt:null};let validCkpt=isCompactionCheckpoint(parsed.ckpt)?parsed.ckpt:null;return{hit:versionTag===expectedVersionTag,rows,ckpt:validCkpt}}function loadDbRows(dataRoot,cacheCliHome,convId){let safeId=sanitizeSessionId(convId);if(safeId===null)return{rows:{},ckpt:null};let dbPath=resolveCliSubdirFile(dataRoot,`conversations`,`${safeId}.db`);if(dbPath===null||!existsSync(dbPath))return{rows:{},ckpt:null};let versionTag=readSqliteVersionTag(dbPath);if(versionTag.length===0)return{rows:{},ckpt:null};let cacheFile=resolveCliSubdirFile(cacheCliHome,`cache`,`agy_hud_telemetry_${safeId}.json`);if(cacheFile===null)return{rows:{},ckpt:null};let cached=readTelemetryCache(cacheFile,versionTag);if(cached.hit)return{rows:cached.rows,ckpt:cached.ckpt};let cachedRows=cached.rows,cachedCkpt=cached.ckpt,loaded;try{loaded=fetchUpdatedRows(dbPath,cachedRows)}catch{return{rows:cachedRows,ckpt:cachedCkpt}}return loaded===null?{rows:cachedRows,ckpt:cachedCkpt}:(readSqliteVersionTag(dbPath)===versionTag&&writeBoundedPrivateJsonCache(cacheFile,{v:TELEMETRY_CACHE_VERSION,versionTag,rows:loaded.rows,ckpt:loaded.ckpt},MAX_ACTIVITY_CACHE_BYTES),loaded)}function hasStepMetrics(row){return row.out>0||row.ttft>0||row.in+row.cr+row.cw>0}function fallbackStdinCachePct(ctxObj){let cur=ctxObj?.current_usage;if(!cur)return null;let inTok=isFiniteNum(cur.input_tokens)?cur.input_tokens:0,cwTok=isFiniteNum(cur.cache_creation_input_tokens)?cur.cache_creation_input_tokens:0,crTok=isFiniteNum(cur.cache_read_input_tokens)?cur.cache_read_input_tokens:0,total=inTok+cwTok+crTok;return total>0?crTok/total*100:null}function computeEffectiveTps(outTok,ttftSec,streamSec){if(outTok<=0)return null;let totalSec=ttftSec+streamSec;if(streamSec<=0)return totalSec>0?outTok/totalSec:null;let rawTps=outTok/streamSec;return ttftSec>streamSec&&(streamSec<MIN_STREAM_WINDOW_SEC||rawTps>MAX_BURST_STREAM_TPS)&&totalSec>0?outTok/totalSec:rawTps}function loadSessionTelemetryFromRoot(dataRoot,cacheCliHome,convId,data={}){let ctxObj=data.context_window,{rows,ckpt}=convId===null?{rows:{},ckpt:null}:loadDbRows(dataRoot,cacheCliHome,convId),valid=Object.keys(rows).sort((a,b)=>Number.parseInt(a,10)-Number.parseInt(b,10)).map(k=>rows[k]).filter(r=>r!==void 0).filter(hasStepMetrics),compacted=isCompactionActive(valid,ckpt),last=valid[valid.length-1];if(!last)return{genCount:0,tps:null,ttft:null,cachePct:fallbackStdinCachePct(ctxObj),ctxUsed:compacted&&ckpt!==null?computeCompactedUsed(valid,ckpt):null,ctxMax:null,compacted};let tps=computeEffectiveTps(last.out,last.ttft,last.stream),stepIn=last.in+last.cw+last.cr,cachePct=stepIn>0?last.cr/stepIn*100:fallbackStdinCachePct(ctxObj),ctxMax=null;for(let i=valid.length-1;i>=0;--i){let candidate=valid[i];if(candidate&&candidate.ctxMax>0){ctxMax=candidate.ctxMax;break}}let ctxUsed=compacted&&ckpt!==null?computeCompactedUsed(valid,ckpt):last.ctxUsed>0?last.ctxUsed:null;return{genCount:valid.length,tps,ttft:last.ttft>0?last.ttft:null,cachePct,ctxUsed,ctxMax,compacted}}function formatSiblingHintLine(siblings){if(siblings.length===0)return``;let noun=siblings.length===1?`session`:`sessions`,items=siblings.map(s=>`--session ${s.shortId} ([${formatSurfaceBadge(s.surface)}])`).join(`, `);return`${siblings.length} other active/recent ${noun} in this workspace: ${items}`}function loadActivitySnapshot(session,options){let nowMs=options.nowMs??Date.now(),siblings=options.siblings?[...options.siblings]:[],scanned=loadSnapshotTranscript(session,options.cacheCliHome),syntheticData={conversation_id:session.convId,conversation_title:session.title,cwd:nonEmptyStr(session.envelope?.cwd)??nonEmptyStr(session.workspace),workspace:{current_dir:nonEmptyStr(session.envelope?.workspaceCurrentDir)??nonEmptyStr(session.workspace),project_dir:nonEmptyStr(session.envelope?.workspaceProjectDir)??nonEmptyStr(session.workspace)},subagents:session.envelope?.subagents,task_count:session.envelope?.taskCount??void 0},telemetry=loadSessionTelemetryFromRoot(session.dataRoot,options.cacheCliHome,session.convId,syntheticData),agentsSummary=collectAgentsSummary(session.dataRoot,syntheticData,scanned.agents),todos=loadTodos(session.dataRoot,syntheticData),aggregatedTools=aggregateActivityTools(scanned.tools,{targetDisplayLen:34,hideSkillReads:!0}),mergedAgents=mergeActivityAgents(agentsSummary,scanned.agents,nowMs),model=scanned.lastModel;model.length===0&&session.surface===`cli`&&(model=readCliFallbackModel(session.dataRoot));let isExitedCli=isExitedCliSession(session);return{convId:session.convId,shortId:session.shortId,surface:session.surface,title:session.title,model,workspace:session.workspace,dataRoot:session.dataRoot,resolutionTier:options.resolutionTier??`fallback`,running:isExitedCli?!1:session.running||aggregatedTools.runningTools.length>0,updatedAtMs:session.updatedAtMs,ageLabel:session.ageLabel,livePid:session.livePid,siblingCandidates:siblings,siblingHint:formatSiblingHintLine(siblings),telemetry,cost:session.envelope?.cost??null,runningTools:aggregatedTools.runningTools,completedTools:aggregatedTools.completedTools,totalToolCalls:aggregatedTools.totalToolCalls,skills:scanned.skills,mcps:aggregatedTools.mcps,agentsKind:mergedAgents.kind,agents:mergedAgents.entries,todos}}function formatUsdAmount(usd,compact=!1){return compact||usd>=10?`$${usd.toFixed(2)}`:`$${usd.toFixed(3)}`}function formatCnyAmount(usd,rate=DEFAULT_USD_TO_CNY_RATE){return`¥${(Math.round((usd*rate+1e-12)*100)/100).toFixed(2)}`}function formatCostAmount(usd,options={}){let currency=options.currency??`usd`,rate=isFiniteNum(options.usdToCnyRate)&&options.usdToCnyRate>0?options.usdToCnyRate:DEFAULT_USD_TO_CNY_RATE,compact=options.compact===!0||isFiniteNum(options.termWidth)&&options.termWidth<100;if(currency===`cny`)return formatCnyAmount(usd,rate);if(currency===`both`){let usdStr=formatUsdAmount(usd,compact),cnyStr=formatCnyAmount(usd,rate);return compact?`${usdStr}/${cnyStr}`:`${usdStr} / ${cnyStr}`}return formatUsdAmount(usd,!1)}function formatSessionCostText(cost,options={}){return`${cost.estimated?`~`:``}${formatCostAmount(cost.totalUsd,options)}`}var MAX_SESSIONS_LIST=40,WINDOWS_ABS_RE=/^[A-Za-z]:[\\/]/,SHELL_OPERATOR_RE=/[|&;<>`$\r\n]/;function hashShortSha256(input){return createHash(`sha256`).update(input).digest(`hex`).slice(0,24)}function isExistingRegularFile(filePath){try{return statIfPresentSync(filePath)?.isFile()===!0}catch{return!1}}function resolveLocalTargetFileUri(rawTarget,workspace){let trimmed=rawTarget.trim();if(trimmed.length===0||trimmed.includes(`\0`)||SHELL_OPERATOR_RE.test(trimmed)||trimmed.startsWith(`http://`)||trimmed.startsWith(`https://`))return null;if(trimmed.startsWith(`file:///`)){let cut=trimmed.split(/[?#]/,1)[0]??``;if(cut.length<=8)return null;try{return isExistingRegularFile(fileURLToPath(cut))?cut:null}catch{return null}}if(path.isAbsolute(trimmed)||WINDOWS_ABS_RE.test(trimmed)){if(!isExistingRegularFile(trimmed))return null;try{return pathToFileURL(trimmed).href}catch{return null}}if(workspace.length>0&&!trimmed.startsWith(`-`)){let resolved=path.resolve(workspace,trimmed);if(isExistingRegularFile(resolved))try{return pathToFileURL(resolved).href}catch{return null}}return null}function toInspectorSessionItem(session){return{convId:session.convId,shortId:session.shortId,surface:session.surface,title:session.title,workspace:session.workspace,running:session.running,livePid:session.livePid,updatedAtMs:session.updatedAtMs,ageLabel:session.ageLabel}}function computeEnvelopeSemanticKey(env){return env===null?``:hashShortSha256(JSON.stringify([env.conversationTitle,env.agyPid,env.cwd,env.workspaceCurrentDir,env.workspaceProjectDir,env.taskCount,env.cost??null,env.mdDigest,env.subagents]))}function computeSessionListKeyEntry(s){return[s.convId,s.surface,s.title,s.workspace,s.running?`1`:`0`,String(s.livePid??0),String(s.updatedAtMs),computeEnvelopeSemanticKey(s.envelope)].join(`\0`)}function formatInspectorCostFields(cost,currency,usdToCnyRate){if(!cost)return null;let rate=Number.isFinite(usdToCnyRate)&&usdToCnyRate>0?usdToCnyRate:DEFAULT_USD_TO_CNY_RATE,text=formatSessionCostText(cost,{currency,usdToCnyRate:rate}),titleParts=[`Session cost: ${cost.estimated?`~`:``}${formatUsdAmount(cost.totalUsd,!1)} / ${formatCnyAmount(cost.totalUsd,rate)}`];return cost.subagentUsd!==null&&cost.subagentUsd>0&&titleParts.push(`Subagents: ${formatUsdAmount(cost.subagentUsd,!1)} / ${formatCnyAmount(cost.subagentUsd,rate)}`),cost.estimated&&titleParts.push(`Estimated pricing`),{text,title:titleParts.join(` · `)}}function computeSiblingsSemanticKey(siblings){return siblings.map(s=>[s.convId,s.surface,s.title,String(s.livePid??0),s.running?`1`:`0`].join(`\0`)).join(``)}function computeSessionStatEtag(session,sessions,source,resolutionTier,siblings,costCurrency,usdToCnyRate){let safeId=sanitizeSessionId(session.convId),tPath=safeId===null?null:resolveCliSubdirFile(session.dataRoot,`brain`,safeId,`.system_generated`,`logs`,`transcript.jsonl`),taskPath=safeId===null?null:resolveCliSubdirFile(session.dataRoot,`brain`,safeId,`task.md`),dbPath=safeId===null?null:resolveCliSubdirFile(session.dataRoot,`conversations`,`${safeId}.db`),tHash=tPath===null?``:computeFileContentHash(tPath),taskHash=taskPath===null?``:computeFileContentHash(taskPath),dbTag=dbPath===null?``:readSqliteVersionTag(dbPath),swarmDigest=safeId===null?``:computeSwarmStateDigest(session.dataRoot,safeId),envSemantic=computeEnvelopeSemanticKey(session.envelope),fallbackModel=session.surface===`cli`?readCliFallbackModel(session.dataRoot):``,siblingsKey=computeSiblingsSemanticKey(siblings),listKey=sessions.slice(0,MAX_SESSIONS_LIST).map(computeSessionListKeyEntry).join(``);return hashShortSha256([`v6`,source,resolutionTier,costCurrency,String(usdToCnyRate),session.convId,session.surface,session.title,session.workspace,fallbackModel,session.running?`1`:`0`,String(session.livePid??0),String(session.updatedAtMs),tHash,taskHash,dbTag,swarmDigest,envSemantic,siblingsKey,listKey].join(``))}function enrichActivitySnapshot(snapshot,costCurrency,usdToCnyRate){let{ctxUsed,ctxMax}=snapshot.telemetry,ctxPct=ctxUsed!==null&&ctxMax!==null&&ctxMax>0?Math.min(100,Math.round(ctxUsed/ctxMax*1e3)/10):null,runningTools=selectNewestFirst(snapshot.runningTools).map(rt=>{let{targetLinkable,...rest}=rt;return{...rest,fileUri:targetLinkable===!1?null:resolveLocalTargetFileUri(rt.fullTarget,snapshot.workspace)}}),completedTools=snapshot.completedTools.map(tool=>{let{unlinkedTargets,...rest}=tool,unlinkedSet=unlinkedTargets===void 0?null:new Set(unlinkedTargets),targetUris={};for(let target of tool.recentTargets){if(unlinkedSet?.has(target)===!0)continue;let uri=resolveLocalTargetFileUri(target,snapshot.workspace);uri!==null&&(targetUris[target]=uri)}if(tool.fullTarget.length>0&&targetUris[tool.fullTarget]===void 0&&unlinkedSet?.has(tool.fullTarget)!==!0){let uri=resolveLocalTargetFileUri(tool.fullTarget,snapshot.workspace);uri!==null&&(targetUris[tool.fullTarget]=uri)}return{...rest,targetUris}});return{convId:snapshot.convId,shortId:snapshot.shortId,surface:snapshot.surface,title:snapshot.title,model:snapshot.model,workspace:snapshot.workspace,resolutionTier:snapshot.resolutionTier,running:snapshot.running,updatedAtMs:snapshot.updatedAtMs,ageLabel:snapshot.ageLabel,livePid:snapshot.livePid,siblingCandidates:snapshot.siblingCandidates,siblingHint:snapshot.siblingHint,telemetry:{...snapshot.telemetry,ctxPct},cost:snapshot.cost??null,costFormatted:formatInspectorCostFields(snapshot.cost,costCurrency,usdToCnyRate),costCurrency,usdToCnyRate,runningTools,completedTools,totalToolCalls:snapshot.totalToolCalls,skills:snapshot.skills,mcps:snapshot.mcps,agentsKind:snapshot.agentsKind,agents:snapshot.agents,todos:snapshot.todos}}function pollHudSnapshot(args={},options={}){let env=options.env??process.env,nowMs=options.nowMs??Date.now(),source=args.source??`auto`,{cliHome,geminiRoot}=resolveProfileRoots(options.cliHome,options.geminiRoot,env),resolveOpts={cliHome,geminiRoot,env,nowMs,source,cwd:options.cwd,isAlive:options.isAlive,session:args.sessionId!==void 0&&args.sessionId.trim().length>0?args.sessionId.trim():void 0},resolved;try{resolved=resolveSession(resolveOpts)}catch(err){if(err instanceof SessionResolutionError&&err.code===`no-sessions`){let emptyEtag=hashShortSha256(`empty#${source}`);return args.etag!==void 0&&args.etag===emptyEtag?{unchanged:!0,etag:emptyEtag}:{unchanged:!1,etag:emptyEtag,source,sessions:[],snapshot:null}}throw err}let hudCfg=readHudConfig(cliHome),etag=computeSessionStatEtag(resolved.session,resolved.sessions,source,resolved.tier,resolved.siblings,hudCfg.costCurrency,hudCfg.usdToCnyRate);if(args.etag!==void 0&&args.etag===etag)return{unchanged:!0,etag};let rawSnapshot=loadActivitySnapshot(resolved.session,{cacheCliHome:cliHome,resolutionTier:resolved.tier,siblings:resolved.siblings,nowMs});return capInspectorPayload({unchanged:!1,etag,source,sessions:resolved.sessions.slice(0,MAX_SESSIONS_LIST).map(toInspectorSessionItem),snapshot:enrichActivitySnapshot(rawSnapshot,hudCfg.costCurrency,hudCfg.usdToCnyRate)})}var DEFAULT_PROTOCOL_VERSION=`2025-03-26`,SERVER_NAME=`agy-hud-inspector`,SERVER_VERSION=MCP_INSPECTOR_VERSION,MAX_MCP_REQUEST_BYTES=HARD_MAX_MCP_RESPONSE_BYTES,OVERSIZED_REQUEST_REPLY=JSON.stringify(makeRpcError(null,-32600,`Invalid Request: message exceeds 1 MiB limit`));function makeRpcResult(id,result){return{jsonrpc:`2.0`,id,result}}function makeRpcError(id,code,message){return{jsonrpc:`2.0`,id,error:{code,message}}}function formatInspectorFallbackText(payload){let snap=payload.snapshot;if(snap===null)return payload.truncated===!0?`HUD Inspector: snapshot truncated to fit 1 MiB response limit.`:`HUD Inspector: no local Antigravity sessions found.`;let badge=snap.surface.toUpperCase(),tel=snap.telemetry,parts=[`[${badge}] ${clipUtf8Bytes(snap.title,160)} (${clipUtf8Bytes(snap.shortId,24)})`];if(tel.ctxPct!==null){let used=nonEmptyStr(fmtTokens(tel.ctxUsed))??`0`,max=nonEmptyStr(fmtTokens(tel.ctxMax))??`?`;parts.push(`Ctx ${tel.ctxPct.toFixed(0)}% (${used}/${max})`)}return tel.tps!==null&&parts.push(`TPS ${tel.tps.toFixed(0)}`),tel.cachePct!==null&&parts.push(`Cache ${tel.cachePct.toFixed(0)}%`),parts.push(`${snap.completedTools.length} tools (${snap.totalToolCalls} calls)`),snap.skills.length>0&&parts.push(`${snap.skills.length} skills`),snap.mcps.length>0&&parts.push(`${snap.mcps.length} MCPs`),snap.agents.length>0&&parts.push(`${snap.agents.length} ${snap.agentsKind}`),payload.truncated===!0&&parts.push(`[truncated]`),parts.join(` | `)}function buildCappedPollRpcResponse(id,payload){let build=data=>makeRpcResult(id,{content:[{type:`text`,text:formatInspectorFallbackText(data)}],structuredContent:data}),initial=build(payload);if(Buffer.byteLength(JSON.stringify(initial),`utf8`)<=1048576)return initial;let wrapperBytes=Buffer.byteLength(JSON.stringify(makeRpcResult(id,{content:[{type:`text`,text:formatInspectorFallbackText(payload)}],structuredContent:null})),`utf8`);return build(capInspectorPayload(payload,Math.max(256,HARD_MAX_MCP_RESPONSE_BYTES-wrapperBytes-64)))}function handleToolsCall(id,params,ctx){if(!isPlainObject(params)||typeof params.name!=`string`)return makeRpcError(id,-32602,`Invalid params: tool name is required.`);let toolName=params.name;if(toolName!==`hud_inspector`&&toolName!==`hud_poll_snapshot`)return makeRpcError(id,-32602,`Unknown tool: ${toolName}`);let parsedArgs=parsePollToolArgs(params.arguments,toolName===`hud_poll_snapshot`);if(!parsedArgs.ok)return makeRpcResult(id,{isError:!0,content:[{type:`text`,text:parsedArgs.error}],structuredContent:{error:parsedArgs.error,...extractErrorCorrelation(params.arguments)}});try{let pollResult=pollHudSnapshot(parsedArgs.args,ctx);return pollResult.unchanged?makeRpcResult(id,{content:[{type:`text`,text:JSON.stringify(pollResult)}],structuredContent:pollResult}):buildCappedPollRpcResponse(id,pollResult)}catch(err){let isKnownResolutionErr=err instanceof SessionResolutionError,message=isKnownResolutionErr?err.message:`Failed to load HUD snapshot.`,code=isKnownResolutionErr?err.code:`internal-error`;return makeRpcResult(id,{isError:!0,content:[{type:`text`,text:message}],structuredContent:{error:message,code,source:parsedArgs.args.source??`auto`,sessionId:parsedArgs.args.sessionId??null}})}}function handleResourcesRead(id,params){return!isPlainObject(params)||typeof params.uri!=`string`?makeRpcError(id,-32602,`Invalid params: resource uri is required.`):params.uri===`ui://agy-hud/inspector.html`?makeRpcResult(id,{contents:[{uri:INSPECTOR_RESOURCE_URI,mimeType:INSPECTOR_MIME_TYPE,text:buildInspectorHtml(),_meta:{ui:{prefersBorder:!1}}}]}):makeRpcError(id,-32002,`Resource not found: ${params.uri}`)}function parseJsonRpcId(raw){if(raw===null||typeof raw==`string`||typeof raw==`number`)return raw}function dispatchMcpMessage(raw,ctx){if(!isPlainObject(raw)||raw.jsonrpc!==`2.0`||typeof raw.method!=`string`)return makeRpcError(null,-32600,`Invalid JSON-RPC 2.0 request.`);let hasId=`id`in raw&&raw.id!==void 0,id=hasId?parseJsonRpcId(raw.id):void 0;if(hasId&&id===void 0)return makeRpcError(null,-32600,`Invalid JSON-RPC id.`);if(!hasId)return null;let reqId=id??null;switch(raw.method){case`initialize`:return makeRpcResult(reqId,{protocolVersion:isPlainObject(raw.params)&&typeof raw.params.protocolVersion==`string`&&raw.params.protocolVersion.trim().length>0?raw.params.protocolVersion.trim():DEFAULT_PROTOCOL_VERSION,capabilities:{tools:{listChanged:!1},resources:{subscribe:!1,listChanged:!1}},serverInfo:{name:SERVER_NAME,version:SERVER_VERSION}});case`ping`:return makeRpcResult(reqId,{});case`tools/list`:return makeRpcResult(reqId,{tools:MCP_TOOLS});case`tools/call`:return handleToolsCall(reqId,raw.params,ctx);case`resources/list`:return makeRpcResult(reqId,{resources:MCP_RESOURCES});case`resources/read`:return handleResourcesRead(reqId,raw.params);default:return makeRpcError(reqId,-32601,`Method not found: ${raw.method}`)}}function handleMcpMessage(raw,ctx={}){let response=dispatchMcpMessage(raw,ctx);return response===null?null:capJsonRpcResponse(response,HARD_MAX_MCP_RESPONSE_BYTES)}function handleDecodedMcpLine(line,ctx){let trimmed=line.trim();if(trimmed.length===0)return null;let parsed;try{parsed=JSON.parse(trimmed)}catch{return JSON.stringify(makeRpcError(null,-32700,`Parse error`))}let response=handleMcpMessage(parsed,ctx);return response===null?null:JSON.stringify(response)}function createMcpLineHandler(ctx={}){return line=>Buffer.byteLength(line,`utf8`)>MAX_MCP_REQUEST_BYTES?OVERSIZED_REQUEST_REPLY:handleDecodedMcpLine(line,ctx)}function runMcpStdioServer(input=process.stdin,output=process.stdout,ctx={}){return new Promise(resolve=>{let chunks=[],bufferedBytes=0,droppingOversized=!1,settled=!1,writeReplySafe=reply=>{try{output.write(`${reply}\n`)}catch(err){let detail=err instanceof Error?err.message:String(err);process.stderr.write(`[agy-hud-mcp] output write error: ${detail}\n`)}},flushLine=line=>{try{let reply=handleDecodedMcpLine(line,ctx);reply!==null&&writeReplySafe(reply)}catch(err){let detail=err instanceof Error?err.message:String(err);process.stderr.write(`[agy-hud-mcp] unhandled request error: ${detail}\n`)}},emitOversized=()=>{writeReplySafe(OVERSIZED_REQUEST_REPLY)},onData=rawChunk=>{let buf=typeof rawChunk==`string`?Buffer.from(rawChunk,`utf8`):rawChunk,offset=0;for(;offset<buf.length;){let nlIdx=buf.indexOf(10,offset);if(droppingOversized){if(nlIdx===-1)return;droppingOversized=!1,emitOversized(),offset=nlIdx+1;continue}let end=nlIdx===-1?buf.length:nlIdx,segLen=end-offset;if(bufferedBytes+segLen>MAX_MCP_REQUEST_BYTES){if(chunks=[],bufferedBytes=0,nlIdx===-1){droppingOversized=!0;return}emitOversized(),offset=nlIdx+1;continue}let seg=buf.subarray(offset,end);if(nlIdx===-1){seg.length>0&&(chunks.push(seg),bufferedBytes+=seg.length);return}let lineBuf=chunks.length===0?seg:Buffer.concat([...chunks,seg],bufferedBytes+seg.length);chunks=[],bufferedBytes=0,flushLine(lineBuf.toString(`utf8`)),offset=nlIdx+1}},finish=()=>{settled||(settled=!0,input.off(`data`,onData),input.off(`end`,onEnd),input.off(`error`,onError),resolve())},onEnd=()=>{if(droppingOversized)emitOversized();else if(bufferedBytes>0){let tail=Buffer.concat(chunks,bufferedBytes).toString(`utf8`);tail.trim().length>0&&flushLine(tail)}finish()},onError=err=>{process.stderr.write(`[agy-hud-mcp] stdin error: ${err.message}\n`),finish()};input.on(`data`,onData),input.on(`end`,onEnd),input.on(`error`,onError)})}isMainEntry(import.meta.url)&&runMcpStdioServer().catch(err=>{let detail=err instanceof Error?err.message:String(err);process.stderr.write(`[agy-hud-mcp] fatal error: ${detail}\n`),process.exitCode=1});export{createMcpLineHandler,handleMcpMessage,runMcpStdioServer};