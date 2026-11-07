// Desktop shell follows the pinned PC 1.6.1 Studio layout; commands stay on Android's existing bridge.
export function studioMenus({editing,btn}){
 const item=(action,label,key='',attrs='')=>btn('studio-command',`<span>${label}</span><kbd>${key}</kbd>`,'studio-menu-command',`data-command="${action}" ${attrs}`);
 const groups=[['파일',item('back','열기','Ctrl+O')+item('save','저장','Ctrl+S',editing?'':'disabled')+item('save-as','다른 이름으로 저장','Ctrl+Shift+S',editing?'':'disabled')+item('studio-pdf','PDF로 저장')+item('about','제품 정보')],
 ['편집',item('tb-undo','되돌리기','Ctrl+Z',editing?'':'disabled')+item('tb-redo','다시 실행','Ctrl+Y',editing?'':'disabled')+item('studio-select-all','모두 선택','Ctrl+A',editing?'':'disabled')+item('tb-painter','모양 복사','Alt+C',editing?'':'disabled')],
 ['보기',item('zoom-in','확대','Ctrl++')+item('zoom-out','축소','Ctrl+-')+item('zoom-reset','폭 맞춤','Ctrl+0')+item('settings','화면 테마')],
 ['입력',item('tb-memo','메모', '',editing?'':'disabled')],
 ['서식',item('tb-char','글자 모양','',editing?'':'disabled')+item('tb-para','문단 모양','',editing?'':'disabled')],
 ['쪽',item('info','문서 정보')],['표',item('tb-table','표 편집','',editing?'':'disabled')],['도구',item('settings','설정')+item('help','사용 방법')]];
 return `<nav class="studio-menu-bar" aria-label="주 메뉴">${groups.map(([name,body])=>`<details class="studio-menu"><summary>${name}</summary><div class="studio-dropdown" aria-label="${name}">${body}</div></details>`).join('')}${btn('studio-toolbox','⌃','studio-toolbox','aria-label="도구 상자 접기" aria-expanded="true"')}</nav>`;
}
export function studioStatus({editing,btn,icon}){
 return `<footer class="studio-status read-controls"><span id="page-label" class="page-label"></span><span class="studio-mode">${editing?'삽입':'읽기 전용'}</span><div class="zoom-tools" aria-label="문서 배율">${btn('zoom-out',icon('minus'),'chip','aria-label="문서 축소 (Ctrl+-)"')}<output id="document-zoom">100%</output>${btn('zoom-in',icon('plus'),'chip','aria-label="문서 확대 (Ctrl++)"')}${btn('zoom-reset','폭 맞춤','chip','title="문서 배율 초기화 (Ctrl+0)"')}</div></footer>`;
}
export function studioStyle({btn,icon}){
 return `<div class="studio-style-bar" aria-label="서식 도구 모음"><label>크기<select id="studio-font-size" aria-label="글자 크기" disabled><option value="">—</option>${[8,9,10,11,12,14,16,18,20,24,28,32,36,48,72].map(n=>`<option value="${n*100}">${n} pt</option>`).join('')}</select></label><label>줄 간격<select id="studio-line-spacing" aria-label="줄 간격" disabled><option value="">—</option>${[100,130,160,180,200,300].map(n=>`<option value="${n}">${n}%</option>`).join('')}</select></label><span class="studio-separator"></span>${[['left','text-align-start','왼쪽 정렬'],['center','text-align-center','가운데 정렬'],['right','text-align-end','오른쪽 정렬'],['justify','text-align-justify','양쪽 정렬']].map(([v,i,label])=>btn('tb-align',icon(i),'studio-align',`data-value="${v}" aria-label="${label}" disabled`)).join('')}<span class="studio-group-label">글꼴 및 간격 · 문단 정렬</span></div>`;
}
