// File-access intro: three screens shown only while the OS denies all-files access.
// Ported from design/latest-inline-fragment.html (2026-10-18). Each change freezes the current
// picture, fades the whole slide out (160ms), selects the next screen at its first frame, fades it
// in (240ms) and only then starts its own motion and hold timer (5200/5600/6000ms).
const icon=n=>`<i data-lucide="${n}" aria-hidden="true"></i>`;
const DURATIONS=[5200,5600,6000];
const EASE='cubic-bezier(.4,0,.2,1)';
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');

export function introMarkup(){return `
<div class="hw-onboarding" data-intro-stage="0" aria-label="문서 모아보기, 보안, 광고 없는 무료 사용 안내">
 <section class="hw-intro-slide hw-intro-active" data-slide="0" aria-hidden="false">
  <h2>한글 문서를<br>한곳에 모아보세요</h2>
  <p class="hw-intro-subtitle hw-collection-subtitle">폴더마다 흩어진 문서를<br>한눈에 찾아볼 수 있어요.</p>
  <div class="hw-collection"><div class="hw-collect-scene" role="img" aria-label="파일 다섯 개가 중앙 문서함으로 모이는 모습">
   <div class="hw-collect-destination" aria-hidden="true">${icon('inbox')}<span class="hw-collect-title">문서함</span><span class="hw-collect-check">${icon('check')}</span></div>
   ${['HWP','HWPX','HWP','HWPX','HWP'].map((type,n)=>`<span class="hw-anim-sheet" data-sheet="${n}" aria-hidden="true">${icon('file-text')}<small>${type}</small></span>`).join('')}
  </div></div>
 </section>
 <section class="hw-intro-slide hw-intro-security" data-slide="1" aria-hidden="true">
  <h2>보안걱정 끝!<br>문서 유출 없어요.</h2>
  <p class="hw-intro-subtitle hw-security-top-copy">인터넷 연결 없이,<br>문서 작업은 자유롭게.</p>
  <div class="hw-flat-scene hw-security-art-scene" role="img" aria-label="업로드 아이콘과 글자를 감싼 굵은 원형 금지 표시">
   <div class="hw-security-art hw-block-art hw-circle-art hw-circle-mode-filled" aria-hidden="true">
    <span class="hw-circle-wash"></span>
    <div class="hw-circle-pill"><span class="hw-circle-upload-group"><span class="hw-circle-upload">${icon('upload')}</span><span class="hw-circle-word">업로드</span></span></div>
    <span class="hw-circle-ring" data-block-anim="appear"></span>
    <span class="hw-circle-slash"><span class="hw-circle-stroke" data-block-anim="wipe"></span></span>
   </div>
  </div>
 </section>
 <section class="hw-intro-slide hw-intro-free" data-slide="2" aria-hidden="true">
  <h2>광고 없이<br>완전 무료</h2>
  <p class="hw-intro-subtitle hw-free-subtitle">결제 걱정 없이<br>문서에만 집중하세요.</p>
  <div class="hw-flat-scene hw-free-scene hw-free-c hw-alternating-free" role="img" aria-label="광고 없음 안내와 이용료 0원 안내가 번갈아 나타나는 모습">
   <div class="hw-free-stage hw-free-ad-stage" aria-hidden="true"><span class="hw-large-ad"><span class="hw-ad-letter hw-ad-upper">AD</span><span class="hw-ad-letter hw-ad-lower">AD</span></span><span class="hw-center-label">광고 없음</span></div>
   <div class="hw-free-stage hw-free-price-stage" aria-hidden="true"><span class="hw-large-zero">0<span>원</span></span><span class="hw-center-label">이용료 없음</span></div>
  </div>
 </section>
</div>
<div class="hw-intro-pager" aria-label="안내 화면 선택">${['문서 모아보기','보안','광고 없이 무료'].map((label,n)=>`<button type="button" class="hw-intro-dot" data-action="intro-page" data-page="${n}" aria-label="${label}" aria-pressed="${n===0}"></button>`).join('')}</div>
<button type="button" class="hw-main-button hw-permission-needed" data-action="allow">파일 접근 허용</button>
<p class="hw-permission-note">Android 설정에서<br>모든 파일에 대한 접근을 허용해 주세요.</p>`;}

// isPaused(): true while a dialog covers the library or the app is hidden.
export function createIntro(isPaused){
 let panel=null,animations=[],collectionRun=0,timer=null,stage=0,started=0,remaining=DURATIONS[0];
 let requested=0,changing=false,ready=false,fade=null,run=0;
 const paused=()=>document.hidden||isPaused();
 const scope=()=>panel?.isConnected?panel:null;
 function track(el,frames,options){const a=el.animate(frames,options);animations.push(a);if(paused())a.pause();return a;}
 function cancelMotion(){collectionRun++;animations.forEach(a=>a.cancel());animations=[];}
 function playCollection(){
  cancelMotion();const run=collectionRun,scene=scope()?.querySelector('.hw-collect-scene');if(!scene)return;
  const box=scene.querySelector('.hw-collect-destination'),w=scene.clientWidth,h=scene.clientHeight,cx=w/2,cy=h/2;box.classList.remove('hw-collected');
  const points=[[.17,.16],[.83,.18],[.91,.64],[.48,.91],[.08,.59]],turns=[-13,12,9,-10,-12];
  scene.querySelectorAll('.hw-anim-sheet').forEach((sheet,n)=>{
   const x=w*points[n][0]-20,y=h*points[n][1]-25,from=`translate(${x}px, ${y}px) rotate(${turns[n]}deg) scale(1)`;sheet.style.opacity='1';sheet.style.transform=from;
   if(reducedMotion.matches){sheet.style.transform=`translate(${cx-20+(n-2)*19}px, ${cy-78+Math.abs(n-2)*5}px) rotate(${(n-2)*6}deg) scale(.6)`;return;}
   const midX=x+(cx-20-x)*.67+(n%2?7:-7),midY=y+(cy-25-y)*.67;
   track(sheet,[{transform:from,opacity:1},{transform:`translate(${midX}px, ${midY}px) rotate(0deg) scale(.72)`,opacity:1,offset:.68},{transform:`translate(${cx-20}px, ${cy-25}px) rotate(0deg) scale(.06)`,opacity:0}],{duration:1050,delay:650+n*250,easing:'cubic-bezier(.35,0,.18,1)',fill:'both'});
  });
  if(reducedMotion.matches){box.classList.add('hw-collected');return;}
  Promise.all(animations.map(a=>a.finished)).then(()=>{if(run===collectionRun&&box.isConnected)box.classList.add('hw-collected');}).catch(()=>{});
 }
 function playSecurity(){
  cancelMotion();const art=scope()?.querySelector('.hw-block-art');if(!art||reducedMotion.matches)return;
  art.querySelectorAll('[data-block-anim]').forEach(el=>{
   const frames=el.dataset.blockAnim==='wipe'?[{clipPath:'inset(0 100% 0 0)'},{clipPath:'inset(0 100% 0 0)',offset:.1},{clipPath:'inset(0 0 0 0)',offset:.23},{clipPath:'inset(0 0 0 0)'}]:[{opacity:.15},{opacity:.15,offset:.1},{opacity:1,offset:.23},{opacity:1}];
   track(el,frames,{duration:5600,fill:'both',easing:'ease-out'});
  });
 }
 function playFree(){
  cancelMotion();const scene=scope()?.querySelector('.hw-alternating-free');if(!scene)return;
  const ad=scene.querySelector('.hw-free-ad-stage'),price=scene.querySelector('.hw-free-price-stage'),upper=scene.querySelector('.hw-ad-upper'),lower=scene.querySelector('.hw-ad-lower');
  upper.style.transform='translate(-4px,-3px)';lower.style.transform='translate(4px,3px)';ad.style.opacity='1';price.style.opacity='0';price.style.transform='translate(-50%,-50%)';
  if(reducedMotion.matches){
   const step=frames=>frames.map(frame=>({...frame,easing:'steps(1,end)'}));
   track(ad,step([{opacity:1},{opacity:0,offset:.5},{opacity:0}]),{duration:6000,fill:'both'});
   track(price,step([{opacity:0},{opacity:1,offset:.5},{opacity:1}]),{duration:6000,fill:'both'});return;
  }
  track(upper,[{transform:'translate(0,0)'},{transform:'translate(-4px,-3px)'}],{duration:240,delay:710,fill:'both',easing:'ease-out'});
  track(lower,[{transform:'translate(0,0)'},{transform:'translate(4px,3px)'}],{duration:240,delay:710,fill:'both',easing:'ease-out'});
  // AD disappears completely before the price message becomes visible.
  track(ad,[{opacity:1},{opacity:1,offset:2600/6000},{opacity:0,offset:2800/6000},{opacity:0}],{duration:6000,fill:'both'});
  track(price,[{opacity:0},{opacity:0,offset:2800/6000},{opacity:1,offset:3040/6000},{opacity:1}],{duration:6000,fill:'both'});
  track(price,[{transform:'translate(-50%,-50%) scale(.97)'},{transform:'translate(-50%,-50%) scale(1)'}],{duration:300,delay:2800,fill:'both',easing:'ease-out'});
 }
 function playCurrent(){if(stage===0)playCollection();else if(stage===1)playSecurity();else playFree();}
 function select(index){
  const p=scope();if(!p)return;stage=index;p.dataset.introStage=String(index);
  p.querySelectorAll('[data-slide]').forEach(slide=>{const active=Number(slide.dataset.slide)===index;slide.classList.toggle('hw-intro-active',active);slide.setAttribute('aria-hidden',String(!active));slide.style.opacity=active?'1':'0';});
  p.parentElement.querySelectorAll('[data-action="intro-page"]').forEach((b,n)=>b.setAttribute('aria-pressed',String(n===index)));
 }
 function schedule(){
  clearTimeout(timer);timer=null;
  if(changing||paused()||!scope())return;
  started=performance.now();timer=setTimeout(()=>{timer=null;go((stage+1)%3);},Math.max(0,remaining));
 }
 async function fadeSlide(slide,from,to,duration,token){
  slide.style.opacity=String(from);
  const a=slide.animate([{opacity:from},{opacity:to}],{duration,easing:EASE,fill:'both'});
  fade=a;if(paused())a.pause();
  try{await a.finished;}catch{return false;}
  if(token!==run)return false;
  slide.style.opacity=String(to);a.cancel();if(fade===a)fade=null;
  return true;
 }
 async function change(){
  const token=++run,p=scope();changing=true;clearTimeout(timer);timer=null;
  animations.forEach(a=>a.pause());
  try{
   while(token===run&&requested!==stage){
    if(!await fadeSlide(p.querySelector(`[data-slide="${stage}"]`),1,0,160,token))return;
    // The previous illustration stays frozen until its whole slide is hidden.
    const target=requested;select(target);
    const incoming=p.querySelector(`[data-slide="${target}"]`);incoming.style.opacity='0';
    playCurrent();
    // Prepare the new picture at its first frame; its motion starts after the fade.
    animations.forEach(a=>{a.pause();a.currentTime=0;});
    if(!await fadeSlide(incoming,0,1,240,token))return;
   }
  }finally{
   if(token===run){
    changing=false;remaining=DURATIONS[stage];
    if(!paused())animations.forEach(a=>{if(a.playState==='paused')a.play();});
    schedule();
   }
  }
 }
 function go(index){
  if(!scope())return;
  index=Math.max(0,Math.min(2,Number(index)||0));requested=index;
  if(!ready||reducedMotion.matches){
   run++;fade?.cancel();fade=null;changing=false;clearTimeout(timer);timer=null;
   select(index);ready=true;playCurrent();remaining=DURATIONS[index];schedule();return;
  }
  // Rapid taps update the destination without interrupting a fade in progress.
  if(!changing&&index!==stage)void change();
 }
 function stop(){run++;clearTimeout(timer);timer=null;fade?.cancel();fade=null;changing=false;ready=false;cancelMotion();panel=null;}
 // Attaches to a freshly rendered panel. Re-rendering the library keeps the current screen instead of restarting at 1.
 function mount(el){
  if(el===panel)return;
  const keep=ready?stage:0;stop();panel=el;if(!el)return;go(keep);
 }
 function pause(){
  if(timer!==null){clearTimeout(timer);timer=null;remaining=Math.max(0,remaining-(performance.now()-started));}
  if(fade?.playState==='running')fade.pause();
  animations.forEach(a=>{if(a.playState==='running')a.pause();});
 }
 function resume(){
  if(!scope()||paused())return;
  if(changing){if(fade?.playState==='paused')fade.play();return;}
  animations.forEach(a=>{if(a.playState==='paused')a.play();});schedule();
 }
 reducedMotion.addEventListener('change',()=>{if(scope()){const target=requested;run++;fade?.cancel();fade=null;changing=false;ready=false;cancelMotion();go(target);}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();else resume();});
 return {mount,stop,pause,resume,go};
}
