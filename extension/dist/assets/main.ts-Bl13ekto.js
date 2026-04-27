(function(){const fe="http://localhost:8000";const Ae=Math.round(66.66666666666667),pe=5e3,he="/api/analyze-chunk",Te=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"];function Ve(){for(const e of Te)if(MediaRecorder.isTypeSupported(e))return e;return""}let I=null;function Me(){return I}function me(e,t,n){var f,k,x;const o=`${t.video_id}|${window.location.href}`;if((I==null?void 0:I.sessionKey)===o&&!I.stopped)return console.log("[VERI-Real] Chunked capture already active for:",t.video_id),I;I&&L("start-new-session");const r=document.createElement("canvas");r.width=224,r.height=224;const a=r.getContext("2d",{willReadFrequently:!1,alpha:!1});if(!a)return console.error("[VERI-Real] 2D context unavailable — aborting capture."),null;a.imageSmoothingEnabled=!0,a.imageSmoothingQuality="high";let i;try{i=r.captureStream(15)}catch(C){return console.info("[VERI-Real] captureStream() failed before first draw — CORS restriction:",C instanceof DOMException?C.name:C),null}if(i.getVideoTracks().length===0)return console.warn("[VERI-Real] captureStream() returned no video tracks — aborting."),ye(i),null;let c=null;try{const C=((f=e.captureStream)==null?void 0:f.call(e))??((k=e.mozCaptureStream)==null?void 0:k.call(e));if(C){const N=C.getAudioTracks();N.length>0?(c=new MediaStream(N),console.log("[VERI-Real] Audio forked:",{tracks:N.length,label:((x=N[0])==null?void 0:x.label)??"(unlabelled)"})):console.log("[VERI-Real] Video element has no audio tracks (muted / silent).")}}catch(C){console.warn("[VERI-Real] Audio fork failed — continuing video-only:",C)}const d=[...i.getVideoTracks(),...(c==null?void 0:c.getAudioTracks())??[]],u=new MediaStream(d),h=Ve(),l={sessionKey:o,media:e,metadata:t,canvas:r,ctx:a,canvasStream:i,audioStream:c,compositeStream:u,mediaRecorder:null,drawIntervalId:null,cycleTimerId:null,_cycleBlobs:[],_mimeType:h,chunkSequence:0,uploadErrors:0,status:"idle",stopped:!1,_onVideoEnded:null,_onPause:null,_onResume:null};I=l,se(l),l.drawIntervalId=window.setInterval(()=>{se(l)},Ae),ne(l),l.status="recording",n==null||n("recording");const R=()=>{console.log("[VERI-Real] Video ended — finalising capture session."),L("video-ended")};l._onVideoEnded=R,e.addEventListener("ended",R,{once:!0});const m=()=>{l.stopped||(console.log("[VERI-Real] Video paused — flushing partial chunk and suspending capture."),l.cycleTimerId!==null&&(window.clearTimeout(l.cycleTimerId),l.cycleTimerId=null),l.mediaRecorder&&l.mediaRecorder.state==="recording"&&l.mediaRecorder.stop())};l._onPause=m,e.addEventListener("pause",m);const S=()=>{l.stopped||l.mediaRecorder&&l.mediaRecorder.state==="recording"||(console.log("[VERI-Real] Video resumed — starting fresh capture cycle."),ne(l))};return l._onResume=S,e.addEventListener("play",S),console.log("[VERI-Real] Chunked capture session started:",{video_id:t.video_id,canvas_size:"224×224",fps:15,chunk_dur_ms:pe,mime:h||"(browser default)",has_audio:((c==null?void 0:c.getAudioTracks().length)??0)>0,endpoint:`${fe}${he}`}),l}function L(e){const t=I;!t||t.stopped||(console.log("[VERI-Real] Stopping chunked capture session:",{reason:e,video_id:t.metadata.video_id,chunks_sent:t.chunkSequence,upload_errors:t.uploadErrors}),t.stopped=!0,t.status="stopped",I=null,Ne(t))}function ne(e){if(e.stopped||!e.compositeStream)return;e._cycleBlobs=[];let t;try{t=new MediaRecorder(e.compositeStream,e._mimeType?{mimeType:e._mimeType}:void 0)}catch(n){console.error("[VERI-Real] MediaRecorder creation failed:",n),L("recorder-create-failed");return}e.mediaRecorder=t,t.ondataavailable=n=>{n.data.size>0&&e._cycleBlobs.push(n.data)},t.onstop=()=>{const n=e._cycleBlobs;if(e._cycleBlobs=[],n.length===0)return;const o=++e.chunkSequence,r=new Blob(n,{type:t.mimeType||e._mimeType||"video/webm"});console.log(`[VERI-Real] Cycle #${o} complete:`,{video_id:e.metadata.video_id,size_bytes:r.size,mime:r.type}),Ue(r,e.metadata.video_id,o),Le(r,e,o),!e.stopped&&!e.media.paused&&!e.media.ended?ne(e):!e.stopped&&e.media.paused&&console.log("[VERI-Real] Capture suspended (video is paused).")},t.onerror=n=>{const o=n.error;console.error("[VERI-Real] MediaRecorder error:",o==null?void 0:o.name,o==null?void 0:o.message),L("recorder-error")},t.start(),e.cycleTimerId=window.setTimeout(()=>{e.stopped||(e.cycleTimerId=null,t.state==="recording"&&t.stop())},pe)}function se(e){if(e.stopped||!e.canvas||!e.ctx)return;const{media:t,ctx:n,canvas:o}=e;if(!(t.paused||t.ended||t.readyState<HTMLMediaElement.HAVE_CURRENT_DATA))try{n.drawImage(t,0,0,o.width,o.height)}catch(r){r instanceof DOMException&&r.name==="SecurityError"&&e.status!=="cors-error"&&(console.info("[VERI-Real] CORS canvas taint — recording unavailable for this video.",r.name),e.status="cors-error",L("cors-taint"))}}async function Le(e,t,n){const o=`${fe}${he}`,r=new FormData;r.append("chunk",e,`chunk-${String(n).padStart(5,"0")}.webm`),r.append("video_id",t.metadata.video_id),r.append("chunk_index",String(n)),r.append("page_url",window.location.href),r.append("captured_at",new Date().toISOString()),t.metadata.channel_name&&r.append("channel_name",t.metadata.channel_name),t.metadata.content_title&&r.append("content_title",t.metadata.content_title);try{const a=await fetch(o,{method:"POST",body:r});if(!a.ok){console.warn(`[VERI-Real] Chunk #${n} upload → HTTP ${a.status}`),t.uploadErrors++;return}console.log(`[VERI-Real] Chunk #${n} uploaded.`,{video_id:t.metadata.video_id,size_bytes:e.size,status:a.status})}catch(a){t.uploadErrors++,a instanceof TypeError&&a.message.includes("fetch")||console.warn(`[VERI-Real] Chunk #${n} upload error:`,a)}}function Ue(e,t,n){const r=`veri-real-${t.replace(/[^a-zA-Z0-9_-]/g,"_")}-chunk-${String(n).padStart(5,"0")}.webm`,a=URL.createObjectURL(e),i=document.createElement("a");i.href=a,i.download=r,i.rel="noopener",document.body.appendChild(i),i.click(),i.remove(),window.setTimeout(()=>URL.revokeObjectURL(a),2e3)}function Ne(e){if(e.cycleTimerId!==null&&(window.clearTimeout(e.cycleTimerId),e.cycleTimerId=null),e.mediaRecorder&&e.mediaRecorder.state!=="inactive")try{e.mediaRecorder.stop()}catch{}e.mediaRecorder=null,e._cycleBlobs=[],e.drawIntervalId!==null&&(window.clearInterval(e.drawIntervalId),e.drawIntervalId=null);for(const t of[e.compositeStream,e.canvasStream,e.audioStream])t&&ye(t);e.compositeStream=null,e.canvasStream=null,e.audioStream=null,e.ctx=null,e.canvas=null,e._onVideoEnded&&(e.media.removeEventListener("ended",e._onVideoEnded),e._onVideoEnded=null),e._onPause&&(e.media.removeEventListener("pause",e._onPause),e._onPause=null),e._onResume&&(e.media.removeEventListener("play",e._onResume),e._onResume=null),console.log("[VERI-Real] Session resources released:",e.metadata.video_id)}function ye(e){for(const t of e.getTracks())t.stop()}const oe="veri-real-overlay-root",De="veri-real-badge",$e="veri-real-check-button",Be="veri-real-status-dot",Fe="veri-real-status-tooltip",Oe="is-checking-active",Pe=3e3,ze=3,He=2e6,qe=13e4,Ye=600*1e3,Ke=50,W="veriRealAutoCaptureOnPlay";let b=!0,$=!0,je=1,H=0,y=null,w=null,q=!1,D=0;const Y=3,g=new Map;let E=null,s=null,v=null,_=null,V=null,Ze=1;const p=new Map,J=new WeakMap,We=new Map;function Ge(e){return!Number.isFinite(e)||e<=0?null:Number(e.toFixed(1))}function Xe(e){const t=Ge(e.duration_seconds);return t===null?null:`youtube:${e.video_id}:${t}`}function Qe(e){const t=Xe(e);return t?We.has(t):!1}function ge(){return typeof chrome<"u"&&typeof chrome.storage<"u"&&typeof chrome.storage.sync<"u"&&typeof chrome.storage.onChanged<"u"}function Q(){return typeof chrome<"u"&&typeof chrome.runtime<"u"&&typeof chrome.runtime.id=="string"}Je().catch(e=>{console.warn("[VERI-Real] bootstrap failed:",e)});async function Je(){if(console.log("[VERI-Real] Extension initializing on:",window.location.href),!ge()||!Q()){console.warn("[VERI-Real] Chrome extension APIs are unavailable in this context.");return}Et(),le(),await et(),console.log("[VERI-Real] Extension enabled state:",b),A(),new MutationObserver(()=>{A(),T()}).observe(document.documentElement,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["src","currentSrc","poster"]}),window.addEventListener("scroll",()=>{A(),T()},!0),window.addEventListener("resize",()=>{y=null,w=null,A(),T()}),window.addEventListener("mousemove",ft,{passive:!0}),window.addEventListener("mouseleave",()=>{y=null,w=null,A(),T()}),setInterval(()=>{b&&(A(),T())},2500),document.addEventListener("play",n=>{n.target instanceof HTMLVideoElement&&(!b||!$||ue(n.target))},!0);const t=document.querySelector("video");t instanceof HTMLVideoElement&&!t.paused&&!t.ended&&b&&$&&ue(t),chrome.storage.onChanged.addListener((n,o)=>{o==="sync"&&(n.veriRealEnabled&&(b=!!n.veriRealEnabled.newValue),n[W]&&($=n[W].newValue!==!1),b?A():(L("extension-disabled"),bt()))}),window.addEventListener("beforeunload",()=>{L("page-unload")})}async function et(){if(!ge()){b=!0,$=!0;return}const e=await chrome.storage.sync.get(["veriRealEnabled",W]);b=e.veriRealEnabled!==!1,$=e[W]!==!1}function A(){if(!b){wt(),Z();return}y&&(!y.isConnected||!ae(y)||!G(y))&&(y=null,w=null),ie(),U(),yt();for(const[e,t]of g.entries())!e.isConnected||!t.isConnected||!F(e)||(G(e)?vt(e):t.style.display="none")}function B(e){return e.isConnected&&ae(e)&&G(e)}function ae(e){const t=e.getBoundingClientRect();return t.width>=48&&t.height>=48}function G(e){const t=e.getBoundingClientRect();return t.width>0&&t.height>0&&t.bottom>0&&t.right>0&&t.top<window.innerHeight&&t.left<window.innerWidth}function ve(e){const t=e.currentSrc||e.src;if(e instanceof HTMLVideoElement&&!t){const n=e.querySelector("source");return(n==null?void 0:n.src)||e.poster||null}return t||null}function M(e){var r;const t=re(ve(e)??""),n=((r=F(e))==null?void 0:r.url)??"",o=re(window.location.href);return`${e.tagName.toLowerCase()}|${t}|${n}|${o}`}function we(){for(const[e,t]of p.entries())if(t.status==="checking")return e;return null}function tt(e){if(y&&B(y)&&M(y)===e)return y;if(v&&B(v)&&M(v)===e)return v;const t=Se();for(const n of t)if(B(n)&&M(n)===e)return n;return null}function U(e){const t=y&&B(y)?M(y):null;let n=e??V;if((!n||!p.has(n))&&(n=t&&p.has(t)?t:null),!n){v=null,_=null,V=null,Z();return}const o=p.get(n);if(!o){v=null,_=null,V=null,Z();return}V=n,_=o.result,o.status;const r=tt(n);v=r,r&&B(r)?Rt(r):Z()}function K(e,t){const n={...t,updatedAt:Date.now()};return p.set(e,n),ie(),n}function ie(){const e=Date.now();for(const[t,n]of p.entries())e-n.updatedAt>Ye&&(p.delete(t),V===t&&(v=null,_=null,V=null));for(;p.size>Ke;){let t=null,n=Number.POSITIVE_INFINITY;for(const[o,r]of p.entries())r.updatedAt<n&&(n=r.updatedAt,t=o);if(!t)break;p.delete(t)}}async function nt(e,t,n,o,r,a,i){const d={type:"VERIFY_MEDIA",payload:{mediaId:String(je++),mediaUrl:t,effectiveUrl:e instanceof HTMLVideoElement&&dt(window.location.href)?window.location.href:void 0,contentUrl:r==null?void 0:r.url,platform:r==null?void 0:r.platform,frameDataUrl:n??void 0,signature:o,mediaType:e instanceof HTMLImageElement?"img":"video",pageUrl:window.location.href}},u=await it(d),h=p.get(a);if(!h||h.requestId!==i||h.status!=="checking")return;const l=z(u);K(a,{status:l.label.toLowerCase().includes("checking")?"checking":"done",result:l,startedAt:h.startedAt,requestId:i,lastMediaRef:e}),U(a)}async function ot(e,t=!1){var S;if(q&&D>=Y){console.warn("[VERI-Real] Extension context invalid, recovery attempts exhausted");return}if(H>=ze){console.warn("[VERI-Real] Max concurrent verifications reached");return}const n=ve(e)??"",o=await at(e),r=F(e),a=M(e);if(e instanceof HTMLVideoElement&&(r==null?void 0:r.platform)==="youtube"){const f=Ee(e);f&&(Re(f),me(e,f,k=>{console.log("[VERI-Real] Chunk capture status →",k,"for",f.video_id)}))}else{const f=Me();f&&f.media!==e&&L("media-switched")}if(!n&&!o&&!(r!=null&&r.url)){console.warn("[VERI-Real] No source found to verify for this element.");return}const i=await rt(e,n,o);console.log("[VERI-Real] Starting verification for:",{mediaUrl:n,hasFrame:!!o,signature:i});const c=Date.now(),d=J.get(e)??{lastSignature:"",lastCheckedAt:0,inFlight:!1};if(d.inFlight){console.log("[VERI-Real] Verification already in flight");return}const u=d.lastSignature===i,h=c-d.lastCheckedAt<Pe;if(!t&&u&&h)return;const l=(S=Array.from(p.entries()).find(([,f])=>f.status==="checking"))==null?void 0:S[0];if(l&&l!==a)return;const R=Ze++,m=z({trustLevel:"yellow",label:"Checking",reason:"Submitting media signature to AI and blockchain layers...",source:"extension"});K(a,{status:"checking",result:m,startedAt:c,requestId:R,lastMediaRef:e}),U(a),P(),T(),d.inFlight=!0,J.set(e,d),H++;try{await nt(e,n,o,i,r,a,R),d.lastSignature=i,d.lastCheckedAt=Date.now(),q&&(D=0,q=!1,console.log("[VERI-Real] Extension context recovered successfully"))}catch(f){const k=f instanceof Error?f.message:String(f);if(be(k)){D++,console.warn(`[VERI-Real] Extension context invalid (attempt ${D}/${Y})`);const C=p.get(a);if(C&&C.requestId===R){const N=D>=Y?{trustLevel:"yellow",label:"Extension Reloaded",reason:"Reload this page to re-attach live verification.",source:"extension-reload"}:{trustLevel:"yellow",label:"Reconnecting",reason:"Re-establishing extension connection...",source:"extension-recovery"};K(a,{status:"error",result:N,startedAt:C.startedAt,requestId:R,lastMediaRef:e}),U(a)}D>=Y&&(q=!0);return}const x=p.get(a);x&&x.requestId===R&&(K(a,{status:"error",result:{trustLevel:"gray",label:"Error",reason:"Verification temporarily unavailable. Please try again.",source:"extension-fallback"},startedAt:x.startedAt,requestId:R,lastMediaRef:e}),U(a)),d.lastCheckedAt=Date.now()}finally{H=Math.max(0,H-1),d.inFlight=!1,J.set(e,d),P(),T()}}async function rt(e,t,n){const o=t?re(t):"no-url",r=`${Math.round(e.clientWidth)}x${Math.round(e.clientHeight)}`,a=e instanceof HTMLVideoElement?`|t${Math.floor(e.currentTime/15)}`:"",i=n?`|f${n.slice(0,96)}`:"",c=`${e.tagName.toLowerCase()}|${o}|${r}${a}${i}`,d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(c)),u=new Uint8Array(d);return`0x${Array.from(u).map(l=>l.toString(16).padStart(2,"0")).join("")}`}async function at(e){try{return e instanceof HTMLImageElement?e.complete?de(e,e.naturalWidth,e.naturalHeight):null:de(e,e.videoWidth,e.videoHeight)}catch(t){return console.warn("[VERI-Real] SecurityError: Cannot read pixels (CORS).",t),null}}function de(e,t,n){const o=document.createElement("canvas"),a=Math.min(1,512/Math.max(t,n));o.width=Math.max(1,Math.round(t*a)),o.height=Math.max(1,Math.round(n*a));const i=o.getContext("2d",{willReadFrequently:!0});if(!i)return null;i.imageSmoothingEnabled=!0,i.imageSmoothingQuality="high",i.drawImage(e,0,0,o.width,o.height);const c=o.toDataURL("image/jpeg",.8);return c.length>He?null:c}async function it(e){if(!Q())throw new Error("Extension context invalidated.");console.log("[VERI-Real] Sending verify message:",e);const t=new Promise((n,o)=>setTimeout(()=>o(new Error("Timeout: Background script did not respond")),qe));try{const n=await Promise.race([chrome.runtime.sendMessage(e),t]);return console.log("[VERI-Real] Got response from service worker:",n),n}catch(n){const o=n instanceof Error?n.message:String(n);throw be(o)?(console.error("[VERI-Real] Extension context invalidated:",n),new Error("Extension context invalidated.")):(console.error("[VERI-Real] Message Error:",n),n)}}function be(e){const t=e.toLowerCase();return t.includes("extension context invalidated")||t.includes("could not establish connection")||t.includes("receiving end does not exist")||t.includes("message channel closed")}function lt(e){try{const t=new URL(e,window.location.origin),n=t.searchParams.get("v");if(n)return n;const o=t.pathname.match(/\/shorts\/([A-Za-z0-9_-]+)/);if(o)return o[1]}catch{}return null}function j(e){var o;const t=document.querySelector(e),n=(o=t==null?void 0:t.content)==null?void 0:o.trim();return n||null}function O(e){var o;const t=document.querySelector(e),n=(o=t==null?void 0:t.textContent)==null?void 0:o.trim();return n||null}function ct(){const e=j('meta[itemprop="datePublished"]')??j('meta[property="video:release_date"]')??j('meta[name="date"]');if(e)return e;const t=document.querySelector("ytd-watch-info-text tp-yt-paper-tooltip, #info-strings yt-formatted-string"),o=((t==null?void 0:t.textContent)??"").match(/(\d{4}-\d{2}-\d{2})/);return(o==null?void 0:o[1])??null}function Ee(e){const t=Ce(e)??window.location.href,n=lt(t);if(!n)return null;const o=Number.isFinite(e.duration)?Number(e.duration.toFixed(1)):Number(e.currentTime.toFixed(1)),r=O("#owner #channel-name a")??O("ytd-channel-name a")??O("a.yt-simple-endpoint.yt-formatted-string"),a=O("h1.ytd-watch-metadata yt-formatted-string")??O("h1.title yt-formatted-string")??j('meta[name="title"]');return{url:t,video_id:n,duration_seconds:o,publish_date:ct(),channel_name:r,content_title:a,captured_at:new Date().toISOString()}}async function st(e){if(Q())try{await chrome.runtime.sendMessage(e)}catch(t){console.warn("[VERI-Real] Failed to send runtime message:",t)}}async function Re(e){const t={type:"VIDEO_METADATA",payload:e};console.log("[VERI-Real] YouTube metadata:",e),await st(t)}async function ue(e){if(!b||!$||!e.isConnected||e.ended||e.readyState<1)return;const t=F(e);if((t==null?void 0:t.platform)!=="youtube")return;const n=Ee(e);if(n){if(Qe(n)){console.log("[VERI-Real] Skipping already completed video:",{video_id:n.video_id,duration_seconds:n.duration_seconds});return}await Re(n),me(e,n,o=>{console.log("[VERI-Real] Auto-capture status →",o,"for",n.video_id)})}}function re(e){try{const t=new URL(e,window.location.href);return t.hash="",t.toString()}catch{return e}}function dt(e){try{const n=new URL(e).hostname.toLowerCase();return n==="x.com"||n==="www.x.com"||n==="twitter.com"||n==="www.twitter.com"||n==="youtube.com"||n==="www.youtube.com"||n==="m.youtube.com"||n==="youtu.be"}catch{return!1}}function F(e){const t=window.location.hostname.toLowerCase();if(t.includes("youtube.com")||t==="youtu.be"){const n=Ce(e);return n?{url:n,platform:"youtube"}:null}if(t.includes("x.com")||t.includes("twitter.com")){const n=ut(e);return n?{url:n,platform:"twitter"}:null}return null}function Ce(e){var i,c,d,u,h,l,R;const t=[],n=(i=w==null?void 0:w.closest)==null?void 0:i.call(w,'a[href*="/watch?v="], a[href*="/shorts/"]'),o=e.closest('a[href*="/watch?v="], a[href*="/shorts/"]');((c=n==null?void 0:n.getAttribute("href"))!=null&&c.includes("/watch?v=")||(d=n==null?void 0:n.getAttribute("href"))!=null&&d.includes("/shorts/"))&&t.push(n==null?void 0:n.getAttribute("href")),((u=o==null?void 0:o.getAttribute("href"))!=null&&u.includes("/watch?v=")||(h=o==null?void 0:o.getAttribute("href"))!=null&&h.includes("/shorts/"))&&t.push(o==null?void 0:o.getAttribute("href"));let r=e.parentElement,a=0;for(;r&&a<5;){const m=r.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');if((l=m==null?void 0:m.getAttribute("href"))!=null&&l.includes("/watch?v=")||(R=m==null?void 0:m.getAttribute("href"))!=null&&R.includes("/shorts/")){t.push(m.getAttribute("href"));break}r=r.parentElement,a++}t.push(window.location.href);for(const m of t)if(m)try{const S=new URL(m,window.location.origin),f=S.searchParams.get("v");if(f)return`https://www.youtube.com/watch?v=${f}`;const k=S.pathname.match(/\/shorts\/([A-Za-z0-9_-]+)/);if(k)return`https://www.youtube.com/shorts/${k[1]}`;const x=S.pathname.match(/\/watch\?v=([A-Za-z0-9_-]+)/);if(x)return`https://www.youtube.com/watch?v=${x[1]}`}catch{}return null}function ut(e){var a;const t=(a=w==null?void 0:w.closest)==null?void 0:a.call(w,"article"),n=e.closest("article"),o=t??n;if(!o)return null;const r=o.querySelectorAll('a[href*="/status/"]');for(const i of r){const c=i.getAttribute("href")??"";if(c)try{const u=new URL(c,window.location.origin).pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);if(!u)continue;return`${window.location.origin}/${u[1]}/status/${u[2]}`}catch{}}return null}function ft(e){w=e.target instanceof Element?e.target:null}function _e(e){if(window.location.pathname.startsWith("/shorts/")){const n=e.closest("ytd-reel-video-renderer, ytd-reel-item-renderer, ytd-shorts, ytd-watch-flexy");if(n)return n}return e.closest("article, ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-rich-grid-media, ytd-reel-item-renderer, a#thumbnail")??e.parentElement??e}function pt(e){return!!e.closest("ytd-moving-thumbnail-renderer, ytd-video-preview, ytd-rich-grid-media #hover-overlays, #mouseover-overlay, #hover-overlays")}function ht(e){return!(e.paused||e.ended||e.readyState<2||pt(e)||window.location.hostname.includes("youtube.com")&&!e.closest("#movie_player, ytd-player, ytd-watch-flexy, ytd-reel-video-renderer, ytd-reel-item-renderer, ytd-shorts"))}function ee(e,t,n){t.classList.remove("is-home-thumbnail-left","is-shorts-action-stack"),t.style.left="",t.style.right="8px",t.style.bottom="",window.location.hostname.includes("youtube.com")?(t.style.top="8px",t.style.transform=""):(t.style.top="50%",t.style.transform="translateY(-50%)")}function mt(e){for(const[t,n]of g.entries())if(n.isConnected&&n.parentElement===e)return{media:t,button:n};return null}function Ie(e){const t=_e(e),n=g.get(e);if(n)return n.parentElement!==t&&(window.getComputedStyle(t).position==="static"&&(t.style.position="relative"),t.appendChild(n)),ee(e,n),n;const o=mt(t);if(o)return o.media!==e&&(g.delete(o.media),g.set(e,o.button)),ee(e,o.button),o.button;const r=Q()?chrome.runtime.getURL("icons/icon6.png"):"data:image/gif;base64,R0lGODlhAQABAAAAACw=";window.getComputedStyle(t).position==="static"&&(t.style.position="relative");const a=document.createElement("button");return a.className=$e,a.type="button",a.innerHTML=`<img src="${r}" alt="VERI-Real check" />`,a.title="Check Deepfake",a.style.display="none",a.addEventListener("click",()=>{const i=we();!b||!e.isConnected||i!==null||(y=e,U(M(e)),P(),T(),ot(e,!0).finally(()=>{P(),A(),T()}))}),a.addEventListener("mouseenter",()=>{const i=M(e),c=p.get(i);if(!c||!s)return;const d=c.result,u=z(d),h=u.isDeepfake===!0?"True":u.isDeepfake===!1?"False":"Unknown",l=xe(u.confidence);s.innerHTML=[`<div class="veri-real-tooltip-title">Deepfake: ${X(h)}</div>`,`<div class="veri-real-tooltip-sub">${X(l)}</div>`].join(""),s.dataset.trustLevel=u.trustLevel,s.style.display="block",ce(e,s)}),a.addEventListener("mouseleave",()=>{s&&(s.style.display="none")}),t.appendChild(a),ee(e,a),g.set(e,a),a}function P(){const e=we();for(const[t,n]of g.entries()){if(!t.isConnected||!n.isConnected){g.delete(t);continue}const o=M(t),r=!!(e&&o!==e);n.disabled=r,n.classList.toggle("is-disabled",r),n.classList.toggle(Oe,!!(e&&o===e))}}function Se(){const e=document.querySelectorAll("video"),t=new Map;for(const n of e){if(!(n instanceof HTMLVideoElement)||!ae(n)||!ht(n)||!F(n))continue;const o=_e(n);t.has(o)||t.set(o,n)}return Array.from(t.values())}function yt(){const e=Se(),t=new Set(e);for(const n of e)Ie(n);for(const[n,o]of g.entries())(!n.isConnected||!o.isConnected||!F(n)||!t.has(n))&&(o.remove(),g.delete(n));P()}function gt(){let e=document.getElementById(oe);return e||(e=document.createElement("div"),e.id=oe,e.style.position="fixed",e.style.left="0",e.style.top="0",e.style.width="100%",e.style.height="100%",e.style.pointerEvents="none",e.style.zIndex="2147483646",document.documentElement.appendChild(e)),e}function le(){const e=gt();if(!E){const t=document.createElement("button");t.type="button",t.className=`${De} ${Be}`,t.style.display="none",t.innerHTML='<span class="veri-real-status-dot-core"></span>',t.addEventListener("mouseenter",()=>{if(!s||!_||!v)return;const n=z(_),o=n.isDeepfake===!0?"Deepfake":n.isDeepfake===!1?"Natural":n.label,r=xe(n.confidence);s.innerHTML=[`<div class="veri-real-tooltip-title">${X(o)}</div>`,`<div class="veri-real-tooltip-sub">${X(r)}</div>`].join(""),s.style.display="block",ce(v,s)}),t.addEventListener("mouseleave",()=>{s&&(s.style.display="none")}),e.appendChild(t),E=t}if(!s){const t=document.createElement("div");t.className=Fe,t.style.display="none",e.appendChild(t),s=t}}function vt(e){const t=Ie(e);!t||!e.isConnected||!G(e)||(t.style.display="flex")}function wt(){for(const[e,t]of g.entries()){if(!e.isConnected||!t.isConnected){g.delete(e);continue}t.style.display="none"}}function Z(){E&&(E.style.display="none"),s&&(s.style.display="none")}function ke(e,t,n=!1,o){if(le(),!E)return;const r=M(e);if(o&&r!==o)return;const a=z(t),i=a.label.toLowerCase().includes("checking");E.dataset.trustLevel=a.trustLevel,E.title=i?"Checking in progress":"Hover for result details";const c=g.get(e);c&&(c.dataset.trustLevel=a.trustLevel,i?(c.classList.add("is-checking-active"),c.classList.remove("is-result-ready")):(c.classList.remove("is-checking-active"),c.classList.add("is-result-ready"))),E.style.display="none"}function z(e){return e.isDeepfake===!0?{...e,trustLevel:"red",label:"Deepfake",reason:e.reason||"Deepfake detected"}:e.isDeepfake===!1?{...e,trustLevel:"green",label:"Natural",reason:e.reason||"Content appears natural"}:e.label.toLowerCase().includes("checking")?{...e,trustLevel:"yellow",label:"Checking",reason:"Verification in progress..."}:e}function ce(e,t){if(!e.isConnected){t.style.display="none";return}const n=e.getBoundingClientRect(),o=170;let r=n.right-o-8,a=n.top+44;r=Math.max(Math.min(r,window.innerWidth-o-4),4),a=Math.max(Math.min(a,window.innerHeight-100),4),t.style.left=`${r}px`,t.style.top=`${a}px`}function bt(){const e=document.getElementById(oe);e&&e.remove();for(const t of g.values())t.remove();g.clear(),E=null,s=null,p.clear(),v=null,_=null,V=null}let te=null;function T(){te===null&&(te=window.requestAnimationFrame(()=>{te=null,ie(),U(),v&&_&&E&&b&&B(v)?(ke(v,_,!0,V??void 0),(s==null?void 0:s.style.display)==="block"&&ce(v,s)):E&&(E.style.display="none",s&&(s.style.display="none")),b&&A()}))}function Et(){if(document.getElementById("veri-real-style"))return;const e=document.createElement("style");e.id="veri-real-style",e.textContent=`
    .veri-real-check-button {
      position: absolute;
      display: none;
      pointer-events: auto;
      border: 0;
      border-radius: 50%;
      width: 42px;
      height: 42px;
      right: 8px;
      top: 8px;
      padding: 0;
      background: transparent;
      cursor: pointer;
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.18);
      align-items: center;
      justify-content: center;
      overflow: visible;
      z-index: 2147483645;
    }

    .veri-real-check-button.is-disabled {
      opacity: 0.45;
      cursor: not-allowed;
      filter: grayscale(0.5);
    }

    .veri-real-check-button img {
      width: 44px;
      height: 44px;
      object-fit: contain;
      pointer-events: none;
    }

    .veri-real-check-button.is-checking-active {
      cursor: progress;
    }

    .veri-real-check-button.is-checking-active::after {
      content: '';
      position: absolute;
      inset: -2px;
      border-radius: 50%;
      border: 2px solid transparent;
      background: conic-gradient(from 0deg, #a8762b 0deg, #ea8d28 180deg, #ceae7b 360deg);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
      animation: veri-real-spin 0.9s linear infinite;
      pointer-events: none;
    }

    .veri-real-check-button.is-result-ready::after {
      content: '';
      position: absolute;
      inset: -2px;
      border-radius: 50%;
      border: 2px solid;
      background: transparent;
      pointer-events: none;
      animation: none;
    }

    .veri-real-check-button.is-result-ready[data-trust-level="green"]::after {
      border-color: #16a34a;
    }

    .veri-real-check-button.is-result-ready[data-trust-level="red"]::after {
      border-color: #dc2626;
    }

    .veri-real-check-button.is-result-ready[data-trust-level="yellow"]::after {
      border-color: #f59e0b;
    }

    .veri-real-check-button.is-result-ready[data-trust-level="gray"]::after {
      border-color: #64748b;
    }

    .veri-real-status-dot {
      position: fixed;
      display: none;
      pointer-events: auto;
      width: 30px;
      height: 30px;
      border: 2px solid #cbd5e1;
      border-radius: 50%;
      padding: 3px;
      background: transparent;
      cursor: default;
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.24);
    }

    .veri-real-status-dot-core {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: transparent;
    }

    .veri-real-status-dot[data-trust-level="green"] {
      border-color: #16a34a;
    }

    .veri-real-status-dot[data-trust-level="red"] {
      border-color: #dc2626;
    }

    .veri-real-status-dot[data-trust-level="yellow"] {
      border-color: #f59e0b;
    }

    .veri-real-status-dot[data-trust-level="gray"] {
      border-color: #64748b;
    }

    .veri-real-status-tooltip {
      position: fixed;
      display: none;
      min-width: 128px;
      max-width: 170px;
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.96);
      color: #f8fafc;
      padding: 8px 10px;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      line-height: 1.2;
      box-shadow: 0 8px 24px rgba(2, 6, 23, 0.35);
      pointer-events: none;
      z-index: 2147483647;
    }

    .veri-real-tooltip-title {
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 2px;
    }

    .veri-real-status-tooltip[data-trust-level="green"] .veri-real-tooltip-title {
      color: #16a34a;
    }

    .veri-real-status-tooltip[data-trust-level="red"] .veri-real-tooltip-title {
      color: #dc2626;
    }

    .veri-real-status-tooltip[data-trust-level="yellow"] .veri-real-tooltip-title {
      color: #f59e0b;
    }

    .veri-real-status-tooltip[data-trust-level="gray"] .veri-real-tooltip-title {
      color: #64748b;
    }

    .veri-real-tooltip-sub {
      font-size: 11px;
      opacity: 0.92;
    }

    @keyframes veri-real-spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `,document.documentElement.appendChild(e)}function Rt(e){le(),!(!E||!_)&&ke(e,_,!0,V??void 0)}function xe(e){if(typeof e!="number"||Number.isNaN(e))return"Confidence: N/A";const t=e>1?e:e*100;return`Confidence: ${Math.max(0,Math.min(100,t)).toFixed(1)}%`}function X(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}
})()
