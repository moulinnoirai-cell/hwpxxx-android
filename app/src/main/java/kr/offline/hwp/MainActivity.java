package kr.offline.hwp;

import android.app.*;
import android.os.*;
import android.content.*;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.provider.Settings;
import android.provider.OpenableColumns;
import android.print.*;
import android.print.pdf.*;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.RectF;
import android.graphics.pdf.PdfDocument;
import android.view.*;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.webkit.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

/** One Activity owns isolated document runtimes and at most two attached panes. */
public class MainActivity extends Activity {
    private static final String ORIGIN="https://appassets.androidplatform.net";
    /** Operations that never touch shared storage: status, in-memory buffers, the user-selected Termux tree and app-private recovery drafts. */
    private static final Set<String> UNGATED=new HashSet<>(Arrays.asList("status","release","abortSave","abortPdf","disconnectFolder","scan","read","saveChunk","beginDraft","finishDraft","abortDraft","listDrafts","readDraft","discardDraft","newDocument","fontList","fontRead","fontDelete","clipboardRead","clipboardWrite","beginPrintPdf","beginPdfPage","finishPdfPage","finishPdf","beginClipboardImage","finishClipboardImage","takeOpenRequests","historyList","beginHistory","finishHistory","readHistory","deleteHistory","clearHistory","recentList","recentAdd","recentOpen","recentRemove","recentClear"));
    private static final java.util.regex.Pattern OVERSIZE_ID=java.util.regex.Pattern.compile("^\\{\"id\":(\\d+)");
    private static JSONObject obj(Object...v)throws JSONException {JSONObject o=new JSONObject();for(int i=0;i<v.length;i+=2)o.put((String)v[i],v[i+1]);return o;}
    /** Window colour behind the WebView; matches the light and dark page backgrounds. */
    private int surface(){return (getResources().getConfiguration().uiMode&Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES?Color.rgb(20,25,34):Color.rgb(245,246,250);}
    private void barAppearance(){
        boolean dark=(getResources().getConfiguration().uiMode&Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES;
        int light=WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        WindowInsetsController c=getWindow().getInsetsController();if(c!=null)c.setSystemBarsAppearance(dark?0:light,light);
        getWindow().setStatusBarColor(surface());getWindow().setNavigationBarColor(surface());
    }
    private List<File> volumeRoots()throws IOException {
        LinkedHashMap<String,File> found=new LinkedHashMap<>();File primary=Environment.getExternalStorageDirectory().getCanonicalFile();found.put(primary.getPath(),primary);
        for(File f:getExternalFilesDirs(null)){if(f==null)continue;String path=f.getCanonicalPath();int at=path.indexOf("/Android/");if(at>0){File root=new File(path.substring(0,at));if(root.isDirectory())found.put(root.getPath(),root);}}
        return new ArrayList<>(found.values());
    }
    private void sweepPdfCache(){File[] files=getCacheDir().listFiles();if(files==null)return;long now=System.currentTimeMillis();for(File f:files)if(f.isFile()&&f.getName().matches("offline-pdf-.*\\.pdf")&&now-f.lastModified()>600000)f.delete();}
    private FrameLayout root;
    private LinearLayout panes;
    private final Map<String,EditorSession> editors=new ConcurrentHashMap<>();
    /** A never-instantiated restored tab still needs its own expiring close authority. */
    private final Map<String,String> unloadedOwners=new HashMap<>();
    private final Map<String,AlertDialog> unloadedCloseDialogs=new HashMap<>();
    private final Handler closeHandler=new Handler(Looper.getMainLooper());
    private static final long CLOSE_FALLBACK_MS=15_000;
    private static final String CLOSE_BUSY="닫기 확인 중이에요. 열린 확인 대화상자를 마치거나 잠시 뒤 다시 시도해 주세요.";
    private WorkspaceModel workspace;
    private WorkspaceStateStore workspaceState;
    private WorkspaceServices services;
    private WorkspaceRequests requests;
    private SharedPreferences pickerPreferences;
    private static final Object PICKER_COUNTER_LOCK=new Object();
    private volatile List<File> workspaceRoots=Collections.emptyList();
    private boolean legacyTests,activityResumed,arrangingPanes;
    private volatile boolean activityDestroyed;
    private String startupWarning;
    private long savedWorkspaceRevision=-1;
    private String migrationOwnerId,newPlaceholderId;
    private final ArrayDeque<Intent> deferredIncoming=new ArrayDeque<>();
    private boolean migrationPending;
    private android.widget.ProgressBar startupProgress;
    private final ExecutorService workspaceIo=Executors.newSingleThreadExecutor();

    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);
        legacyTests=BuildConfig.DEBUG&&getIntent().getBooleanExtra("legacyUiForTests",false);
        pickerPreferences=getSharedPreferences("workspace-request-codes",MODE_PRIVATE);
        requests=new WorkspaceRequests(Math.max(pickerPreferences.getInt("next",1000),saved==null?1000:saved.getInt("workspaceNextPickerCode",1000)));
        root=new FrameLayout(this);root.setBackgroundColor(surface());
        panes=new LinearLayout(this);panes.setOrientation(LinearLayout.HORIZONTAL);
        root.addView(panes,new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,FrameLayout.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener((v,insets)->{android.graphics.Insets x=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());v.setPadding(x.left,x.top,x.right,Math.max(x.bottom,insets.getInsets(WindowInsets.Type.ime()).bottom));return WindowInsets.CONSUMED;});
        getWindow().setDecorFitsSystemWindows(false);setContentView(root);barAppearance();
        if(Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,()->onBackPressed());
        try{
            workspaceRoots=volumeRoots();services=WorkspaceServices.acquire(getApplicationContext(),workspaceRoots);
            workspaceState=new WorkspaceStateStore(new File(getFilesDir(),"workspace-state"));
            workspace=new WorkspaceModel();
            if(!legacyTests){
                WorkspaceStateStore.Loaded loaded=workspaceState.load();
                if(loaded.status==WorkspaceStateStore.Status.OK){
                    workspace=loaded.model;
                    if(workspace.isOverLimit())startupWarning="열 수 있는 문서는 "+WorkspaceModel.MAX_TABS+"개까지예요. 이전에 열어 둔 "+workspace.size()+"개는 그대로 두었어요. 새 문서를 열려면 사용하지 않는 탭을 닫아 주세요.";
                }
                else if(loaded.status!=WorkspaceStateStore.Status.ABSENT){
                    startupWarning="이전 작업공간 배치를 읽지 못했어요. 복구 자료는 보존했어요.";
                    try{workspaceState.quarantineInvalid();}catch(IOException preserved){workspaceState=null;}
                }
            }
            if(workspace.isEmpty()){UUID id=UUID.randomUUID();workspace.createTab(id);newPlaceholderId=id.toString();}
            migrationOwnerId=workspace.tabIds().get(0);migrationPending=!legacyTests;
            if(legacyTests){retainEditor(new EditorSession(migrationOwnerId,"blank"));layoutWorkspace();}
            else{
                startupProgress=new android.widget.ProgressBar(this);startupProgress.setContentDescription("복구 자료 확인 중");root.addView(startupProgress,new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT,FrameLayout.LayoutParams.WRAP_CONTENT,Gravity.CENTER));
                persistWorkspace();
            }
            final String legacyOwner=migrationOwnerId;
            final boolean canMigrate=!legacyTests&&savedWorkspaceRevision==workspace.persistentRevision();
            workspaceIo.execute(()->{
                String warning=null;List<String> recoverable=Collections.emptyList();
                if(canMigrate)try{services.migrateLegacyDraftsTo(legacyOwner);}catch(IOException preserved){warning="이전 복구 자료를 모두 옮기지 못했어요. 원본 복구 자료는 보존했어요.";}
                if(!legacyTests)try{recoverable=services.recoverableTabIds();}catch(IOException preserved){warning="일부 복구 자료를 확인하지 못했어요. 기존 자료는 보존했어요.";}
                final String recoveryWarning=warning;final List<String> recoverableIds=recoverable;
                if(!legacyTests)runOnUiThread(()->completeStartup(recoverableIds,recoveryWarning));
                sweepPdfCache();ClipboardImageProvider.sweep(MainActivity.this);
            });
            if(!legacyTests&&saved==null)incoming(getIntent());
        }catch(Exception error){new AlertDialog.Builder(this).setMessage("작업공간을 열지 못했어요. 복구 자료는 보존했어요.").setPositiveButton("닫기",(d,w)->finish()).show();}
    }
    @Override protected void onSaveInstanceState(Bundle out){if(requests!=null)out.putInt("workspaceNextPickerCode",requests.nextPickerCode());super.onSaveInstanceState(out);}
    private void completeStartup(List<String> recoverableIds,String warning){
        if(activityDestroyed)return;
        if(warning!=null)startupWarning=warning;
        try{
            mergeRecoveryTabs(recoverableIds);persistWorkspace();
            for(String id:workspace.visibleIds())retainEditor(new EditorSession(id,"blank"));
            layoutWorkspace();migrationPending=false;
            if(startupProgress!=null){root.removeView(startupProgress);startupProgress=null;}
            for(EditorSession editor:editors.values())editor.load();
            while(!deferredIncoming.isEmpty())incoming(deferredIncoming.removeFirst());
        }catch(Exception|OutOfMemoryError error){new AlertDialog.Builder(this).setMessage("편집기를 열지 못했어요. 복구 자료는 보존했어요.").setPositiveButton("닫기",(d,w)->finish()).show();}
    }
    /** Discover only opaque recovery owners. Reading actual draft contents stays inside that owner's session. */
    private void mergeRecoveryTabs(List<String> recoveryIds){
        if(recoveryIds.isEmpty())return;
        WorkspaceModel.State before=workspace.exportState();
        boolean dropPlaceholder=newPlaceholderId!=null&&workspace.size()==1&&workspace.contains(newPlaceholderId)&&!recoveryIds.contains(newPlaceholderId);
        if(dropPlaceholder)workspace.removeConfirmed(newPlaceholderId);
        int pending=0;boolean added=false;
        for(String id:recoveryIds){if(workspace.contains(id))continue;if(workspace.canCreateTab()){workspace.createTab(UUID.fromString(id));added=true;}else pending++;}
        if(added){
            List<String> ids=workspace.tabIds(),recent=new ArrayList<>(before.recentIds);
            for(String id:ids)if(!recent.contains(id))recent.add(id);
            recent.retainAll(ids);
            String primary=dropPlaceholder?ids.get(0):before.primaryId;
            workspace=WorkspaceModel.restore(new WorkspaceModel.State(ids,dropPlaceholder?primary:before.activeId,primary,dropPlaceholder?null:before.secondaryId,!dropPlaceholder&&before.split,recent));
            savedWorkspaceRevision=-1;
        }
        if(pending>0)startupWarning="열 수 있는 문서는 5개까지예요. 추가 복구 자료는 보존했어요. 사용하지 않는 탭을 닫고 앱을 다시 열어 주세요.";
    }
    private void retainEditor(EditorSession editor){
        String unloadedOwner=unloadedOwners.remove(editor.tabId);if(unloadedOwner!=null)requests.removeSession(unloadedOwner);
        AlertDialog unloadedDialog=unloadedCloseDialogs.remove(editor.tabId);if(unloadedDialog!=null)unloadedDialog.cancel();
        editors.put(editor.tabId,editor);
        try{if(!migrationPending)editor.load();}catch(RuntimeException|OutOfMemoryError error){editors.remove(editor.tabId,editor);editor.dispose();throw error;}
    }
    private boolean isLive(EditorSession editor){return !activityDestroyed&&!editor.destroyed&&editors.get(editor.tabId)==editor;}
    private List<File> refreshRoots()throws IOException {
        List<File> current=volumeRoots();services.refreshRoots(current);workspaceRoots=current;
        for(EditorSession editor:editors.values())editor.roots=current;
        return current;
    }
    private EditorSession activeEditor(){return workspace==null?null:editors.get(workspace.activeId());}
    private JSONObject snapshot(EditorSession self)throws JSONException {
        if(legacyTests)return obj("enabled",false);
        JSONArray tabs=new JSONArray();for(WorkspaceModel.Tab tab:workspace.snapshot().tabs())tabs.put(obj("id",tab.id,"title",tab.title,"dirty",tab.dirty,"encrypted",tab.encrypted,"ready",tab.ready));
        return obj("enabled",true,"selfId",self.tabId,"tabs",tabs,"activeId",workspace.activeId(),"primaryId",workspace.primaryId(),"secondaryId",workspace.secondaryId()==null?JSONObject.NULL:workspace.secondaryId(),"split",workspace.secondaryId()!=null,"maxTabs",8);
    }
    private void persistWorkspace(){
        if(legacyTests||workspaceState==null||workspace==null||workspace.persistentRevision()==savedWorkspaceRevision)return;
        try{workspaceState.save(workspace);savedWorkspaceRevision=workspace.persistentRevision();}catch(IOException error){String warning="작업공간 배치를 저장하지 못했어요. 문서는 그대로예요.";EditorSession active=activeEditor();if(active!=null&&active.started)active.event("hostError",JSONObject.quote(warning));else startupWarning=warning;}
    }
    private void changed(){
        persistWorkspace();
        for(EditorSession editor:editors.values())try{editor.event("workspaceChanged",snapshot(editor));}catch(JSONException ignored){}
        showStartupWarnings();
    }
    private void showStartupWarnings(){
        EditorSession active=activeEditor();if(active==null||!isLive(active)||!active.hostReady)return;
        String warning=startupWarning;startupWarning=null;
        if(active.sessionStartupWarning!=null){warning=warning==null?active.sessionStartupWarning:warning+"\n"+active.sessionStartupWarning;active.sessionStartupWarning=null;}
        if(warning!=null)active.event("hostError",JSONObject.quote(warning));
    }
    private void broadcastEvent(String name,Object data){runOnUiThread(()->{for(EditorSession editor:editors.values())editor.event(name,data);});}
    /** Reorder never reaches here: pane assignments and WebViews remain untouched during dragging. */
    private void layoutWorkspace(){
        arrangingPanes=true;
        try{
            List<String> wanted=workspace.visibleIds();
            for(String id:wanted)if(!editors.containsKey(id))try{retainEditor(new EditorSession(id,"blank"));}catch(Exception|OutOfMemoryError unavailable){
                workspace.update(id,"복구 문서",false,false,false);
                android.widget.Toast.makeText(this,"문서를 열지 못했어요. 복구 자료는 보존했어요. 다른 문서를 저장한 뒤 다시 선택하거나 탭을 닫아 주세요.",android.widget.Toast.LENGTH_LONG).show();
            }
            for(EditorSession editor:editors.values())if(editor.visible&&!wanted.contains(editor.tabId)){
                editor.visible=false;editor.event("pause",Boolean.TRUE);
                if(editor.web!=null){editor.web.clearFocus();editor.web.onPause();}
            }
            // Keep an unchanged pane attached, including when its neighbour is replaced or closed.
            Set<WebView> retained=new HashSet<>();for(String id:wanted){EditorSession editor=editors.get(id);if(editor!=null&&editor.web!=null)retained.add(editor.web);}
            for(int i=panes.getChildCount()-1;i>=0;i--)if(!retained.contains(panes.getChildAt(i)))panes.removeViewAt(i);
            int position=0;
            for(String id:wanted){
                EditorSession editor=editors.get(id);if(editor==null||editor.web==null)continue;
                if(editor.web.getParent()!=panes)panes.addView(editor.web,position,new LinearLayout.LayoutParams(0,LinearLayout.LayoutParams.MATCH_PARENT,1f));
                else if(panes.indexOfChild(editor.web)!=position){panes.removeView(editor.web);panes.addView(editor.web,position,new LinearLayout.LayoutParams(0,LinearLayout.LayoutParams.MATCH_PARENT,1f));}
                position++;
                if(!editor.visible){editor.visible=true;if(activityResumed)editor.web.onResume();editor.event("resume",Boolean.TRUE);}
            }
            if(activeEditor()==null)for(String id:wanted){EditorSession available=editors.get(id);if(available!=null&&isLive(available)){workspace.setActive(id);break;}}
            EditorSession active=activeEditor();if(active!=null&&active.web!=null&&!active.web.hasFocus())active.web.requestFocus();
        }finally{arrangingPanes=false;}
    }
    private void focusSession(EditorSession editor){
        if(arrangingPanes||!isLive(editor)||!editor.visible||workspace==null||editor.tabId.equals(workspace.activeId()))return;
        workspace.setActive(editor.tabId);if(editor.web!=null&&!editor.web.hasFocus())editor.web.requestFocus();changed();
    }
    private EditorSession newEditor(EditorSession origin,String initialAction)throws Exception {
        if(!workspace.canCreateTab())throw new IOException("문서는 5개까지 열 수 있어요. 사용하지 않는 탭을 닫아 주세요.");
        UUID uuid=UUID.randomUUID();String id=uuid.toString();
        EditorSession editor=new EditorSession(id,initialAction);
        if(!workspace.createTab(uuid,origin==null?workspace.activeId():origin.tabId)){editor.dispose();throw new IOException("새 문서 탭을 만들지 못했어요.");}
        try{retainEditor(editor);}catch(RuntimeException|OutOfMemoryError error){workspace.removeConfirmed(id);layoutWorkspace();changed();throw error;}
        layoutWorkspace();changed();return editor;
    }
    private void splitWithNewEditor(EditorSession origin)throws Exception {
        UUID uuid=UUID.randomUUID();EditorSession editor=new EditorSession(uuid.toString(),"blank");
        if(!workspace.splitWithNewTab(uuid,origin.tabId)){editor.dispose();throw new IOException("분할할 문서 탭을 만들지 못했어요.");}
        try{retainEditor(editor);}catch(RuntimeException|OutOfMemoryError error){workspace.removeConfirmed(editor.tabId);layoutWorkspace();changed();throw error;}
        layoutWorkspace();changed();
    }
    private void workspaceOperation(EditorSession origin,long request,String op,JSONObject args){
        if(!isLive(origin))return;
        try{
            if(op.equals("workspaceState")){origin.reply(request,snapshot(origin),null);showStartupWarnings();return;}
            if(legacyTests){origin.reply(request,obj("enabled",false),null);return;}
            switch(op){
                case "workspaceReady": {
                    JSONObject data=snapshot(origin),action=obj("kind",origin.initialAction);
                    if(origin.initialRecentId!=null)action.put("recentId",origin.initialRecentId);
                    data.put("initialAction",action);origin.initialAction="blank";origin.initialRecentId=null;
                    origin.hostReady=true;origin.reply(request,data,null);showStartupWarnings();return;
                }
                case "workspaceNew":newEditor(origin,args.optBoolean("open",false)?"open":"blank");break;
                case "workspaceOpenRecent": {String id=args.optString("recentId",args.optString("id",""));if(!HostState.validRecentId(id))throw new IOException("최근 문서 ID가 올바르지 않아요.");EditorSession editor=newEditor(origin,"recent");editor.initialRecentId=id;break;}
                case "workspaceSelect": {
                    String target=WorkspaceModel.canonicalId(args.getString("id"));
                    if(target!=null&&workspace.contains(target)&&!editors.containsKey(target))retainEditor(new EditorSession(target,"blank"));
                    workspace.select(target,origin.tabId);layoutWorkspace();changed();break;
                }
                case "workspaceFocus":focusSession(origin);break;
                case "workspaceMove":workspace.moveBefore(args.getString("id"),args.isNull("beforeId")?null:args.optString("beforeId",null));changed();break;
                case "workspaceSplit": {
                    boolean enabled=args.optBoolean("enabled",false);
                    WorkspaceModel.SplitResult result=workspace.setSplit(enabled,origin.tabId);
                    if(result==WorkspaceModel.SplitResult.NEEDS_NEW_TAB)splitWithNewEditor(origin);
                    else if(result==WorkspaceModel.SplitResult.REJECTED)throw new IOException("분할할 문서 탭을 찾지 못했어요.");
                    else{layoutWorkspace();changed();}break;
                }
                case "workspaceUpdate":workspace.update(origin.tabId,args.optString("title","새 문서"),args.optBoolean("dirty",false),args.optBoolean("encrypted",false),args.optBoolean("ready",false));changed();break;
                case "workspaceClose":requestClose(args.getString("id"),origin);break;
                case "workspaceCloseResult": {
                    String token=args.optString("token","");
                    if(args.optBoolean("unavailable",false)){offerNativeClose(origin,token);break;}
                    String target=requests.consumeClose(origin.sessionId,token);
                    if(target!=null&&target.equals(origin.tabId)){if(token.equals(origin.pendingCloseToken))origin.pendingCloseToken=null;if(args.optBoolean("allow",false))removeConfirmed(origin,true);}break;
                }
                case "workspaceInitialDone": {
                    boolean createdForOpen=origin.initialOpenPending;origin.initialOpenPending=false;
                    WorkspaceModel.Tab tab=workspace.tab(origin.tabId);
                    if(createdForOpen&&args.optBoolean("cancelled",false)&&tab!=null&&!tab.dirty&&!origin.hasOpenedContent&&origin.documents.isEmpty()&&origin.selectedFiles.size()==0&&origin.newDocuments.size()==0&&origin.pendingOpens.isEmpty())requestClose(origin.tabId,origin);
                    break;
                }
                default:throw new IOException("지원하지 않는 작업공간 요청이에요.");
            }
            if(isLive(origin))origin.reply(request,snapshot(origin),null);
        }catch(OutOfMemoryError error){origin.reply(request,null,"메모리가 부족해 새 문서를 열지 못했어요. 편집 중인 문서를 저장해 주세요.");}
        catch(Exception error){origin.reply(request,null,error.getMessage()==null?"작업공간 요청을 완료하지 못했어요.":error.getMessage());}
    }
    private void requestClose(String tabId,EditorSession origin)throws Exception {
        String canonical=WorkspaceModel.canonicalId(tabId);
        if(canonical==null||!workspace.contains(canonical))throw new IOException("문서 탭을 찾지 못했어요.");
        EditorSession target=editors.get(canonical);
        if(target==null){requestUnloadedClose(canonical);return;}
        if(!isLive(target))throw new IOException("문서 탭을 다시 확인해 주세요.");
        if(requests.hasPendingClose(target.sessionId)||!target.nativeDialogs.isEmpty())throw new IOException(CLOSE_BUSY);
        workspace.select(canonical,origin==null?workspace.activeId():origin.tabId);layoutWorkspace();changed();
        String token=requests.requestClose(target.tabId,target.sessionId);target.pendingCloseToken=token;
        // Revoke the JS token before offering a native fallback. A late Core answer cannot answer that dialog.
        closeHandler.postDelayed(()->offerNativeClose(target,token),CLOSE_FALLBACK_MS);
        String quoted=JSONObject.quote(token);
        String script="(function(){var token="+quoted+";function answer(allow,unavailable){window.OfflineNative.postMessage(JSON.stringify({id:0,op:'workspaceCloseResult',args:{token:token,allow:allow===true,unavailable:unavailable===true}}));}try{if(document.querySelector('dialog[open], .modal-overlay'))return 'dialog';"
            +"if("+(!target.closeFallbackRequired)+"&&typeof window.AndroidWorkspaceCloseRequest==='function'){Promise.resolve(window.AndroidWorkspaceCloseRequest(token)).catch(function(){answer(false,true);});return 'workspace';}"
            +"var core=window.rhwpStudio&&window.rhwpStudio.android;if(core&&typeof core.confirmClose==='function'){Promise.resolve().then(function(){return core.confirmClose();}).then(function(allow){answer(allow,false);},function(){answer(false,true);});return 'core';}"
            +"}catch(error){}return 'unavailable';})()";
        try{target.web.evaluateJavascript(script,value->{
            if("\"dialog\"".equals(value)){if(isLive(target)&&requests.consumeClose(target.sessionId,token)!=null){if(token.equals(target.pendingCloseToken))target.pendingCloseToken=null;showCloseError(new IOException(CLOSE_BUSY));}}
            else if(!"\"workspace\"".equals(value)&&!"\"core\"".equals(value))offerNativeClose(target,token);
        });}
        catch(RuntimeException unavailable){offerNativeClose(target,token);}
    }
    /** Probe before fallback: a responsive Core/host dialog must never acquire a stacked native close prompt. */
    private void offerNativeClose(EditorSession target,String token){
        if(!isLive(target)||!token.equals(target.pendingCloseToken))return;
        if(!requests.isPendingClose(target.sessionId,token)){
            target.pendingCloseToken=null;showCloseError(new IOException("닫기 확인 시간이 지났어요. 확인 대화상자를 마친 뒤 다시 닫아 주세요."));return;
        }
        if(!activityResumed||!target.nativeDialogs.isEmpty()){closeHandler.postDelayed(()->offerNativeClose(target,token),CLOSE_FALLBACK_MS);return;}
        final long probe=++target.closeProbe;
        Runnable unresponsive=()->{if(isLive(target)&&target.closeProbe==probe){if(activityResumed)showNativeClose(target,token);else closeHandler.postDelayed(()->offerNativeClose(target,token),CLOSE_FALLBACK_MS);}};
        closeHandler.postDelayed(unresponsive,2500);
        try{target.web.evaluateJavascript("(function(){return document.querySelector('dialog[open], .modal-overlay')?'dialog':'clear';})()",value->{
            if(!isLive(target)||target.closeProbe!=probe||!token.equals(target.pendingCloseToken))return;
            target.closeProbe++;
            if("\"dialog\"".equals(value))closeHandler.postDelayed(()->offerNativeClose(target,token),CLOSE_FALLBACK_MS);
            else showNativeClose(target,token);
        });}catch(RuntimeException unavailable){unresponsive.run();}
    }
    /** No cached ready/dirty flag authorizes this close: the user gives fresh, explicit consent for the same instance. */
    private void showNativeClose(EditorSession target,String token){
        if(!isLive(target)||!token.equals(target.pendingCloseToken)||!requests.isPendingClose(target.sessionId,token))return;
        if(!activityResumed){closeHandler.postDelayed(()->offerNativeClose(target,token),CLOSE_FALLBACK_MS);return;}
        if(!target.nativeDialogs.isEmpty()){closeHandler.postDelayed(()->offerNativeClose(target,token),CLOSE_FALLBACK_MS);return;}
        requests.consumeClose(target.sessionId,token);target.pendingCloseToken=null;target.closeFallbackRequired=true;target.closeProbe++;
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("문서 탭 닫기")
            .setMessage("편집기의 응답을 확인하지 못했어요. 이 탭을 닫으면 저장하지 않은 변경사항이 사라질 수 있어요. 기존 복구 자료는 보존해요. 탭을 닫을까요?")
            .setNegativeButton("취소",(d,w)->{})
            .setPositiveButton("탭 닫기",(d,w)->{if(isLive(target))removeConfirmed(target,false);}).create();
        target.nativeDialogs.add(dialog);dialog.setOnDismissListener(d->target.nativeDialogs.remove(dialog));
        dialog.setOnShowListener(d->{dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setFocusableInTouchMode(true);dialog.getButton(AlertDialog.BUTTON_NEGATIVE).requestFocus();});dialog.show();
    }
    private void requestUnloadedClose(String tabId)throws IOException {
        String owner=unloadedOwners.get(tabId);if(owner==null){owner=UUID.randomUUID().toString();unloadedOwners.put(tabId,owner);}
        if(requests.hasPendingClose(owner)||unloadedCloseDialogs.containsKey(tabId))throw new IOException(CLOSE_BUSY);
        final String instance=owner,token=requests.requestClose(tabId,owner);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("문서 탭 닫기")
            .setMessage("아직 열지 않은 문서 탭을 닫을까요? 기존 복구 자료는 보존해요.")
            .setNegativeButton("취소",(d,w)->{})
            .setPositiveButton("탭 닫기",(d,w)->{
                if(!activityDestroyed&&workspace.contains(tabId)&&editors.get(tabId)==null&&instance.equals(unloadedOwners.get(tabId))&&requests.isPendingClose(instance,token)){
                    requests.consumeClose(instance,token);requests.removeSession(instance);unloadedOwners.remove(tabId);workspace.removeConfirmed(tabId);finishCloseLayout();
                }else if(!activityDestroyed)showCloseError(new IOException("닫기 확인 시간이 지났어요. 문서 탭을 다시 확인한 뒤 닫아 주세요."));
            }).create();
        unloadedCloseDialogs.put(tabId,dialog);
        dialog.setOnDismissListener(d->{if(unloadedCloseDialogs.get(tabId)==dialog)unloadedCloseDialogs.remove(tabId);requests.consumeClose(instance,token);});
        dialog.setOnShowListener(d->{dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setFocusableInTouchMode(true);dialog.getButton(AlertDialog.BUTTON_NEGATIVE).requestFocus();});dialog.show();
    }
    private void removeConfirmed(EditorSession editor,boolean discardOwnedRecovery){
        if(!isLive(editor))return;
        if(legacyTests){finish();return;}
        workspace.removeConfirmed(editor.tabId);editors.remove(editor.tabId);editor.dispose(discardOwnedRecovery);finishCloseLayout();
    }
    private void finishCloseLayout(){
        if(workspace.isEmpty()){persistWorkspace();finish();return;}
        layoutWorkspace();changed();
    }
    private void rendererGone(EditorSession editor){
        if(!isLive(editor))return;
        // Hidden documents keep only their recovery identity until selected again; no hidden WASM startup.
        editors.remove(editor.tabId);editor.dispose();
        if(legacyTests){finish();return;}
        workspace.update(editor.tabId,"복구 문서",false,false,false);
        if(workspace.isVisible(editor.tabId))layoutWorkspace();
        changed();
    }
    private void launchPicker(EditorSession owner,Intent intent,int localCode){
        if(!isLive(owner))throw new IllegalStateException("문서가 닫혔어요.");
        final int requestCode;
        synchronized(PICKER_COUNTER_LOCK){
            requests.raiseNextPickerCodeTo(pickerPreferences.getInt("next",1000));
            requestCode=requests.registerPicker(owner.tabId,owner.sessionId,localCode);
            if(!pickerPreferences.edit().putInt("next",requests.nextPickerCode()).commit()){requests.consumePicker(requestCode);throw new IllegalStateException("파일 선택 요청을 안전하게 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.");}
        }
        try{startActivityForResult(intent,requestCode);}catch(RuntimeException error){requests.consumePicker(requestCode);throw error;}
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);if(requests==null)return;
        WorkspaceRequests.Picker route=requests.consumePicker(request);if(route==null)return;
        EditorSession owner=editors.get(route.tabId);if(owner==null||!owner.sessionId.equals(route.sessionId)||!isLive(owner))return;
        owner.pickerResult(route.localCode,result,data);
    }
    private void incoming(Intent intent){
        if(intent==null||!HostIntents.acceptableIncomingAction(intent.getAction()))return;
        if(intent.getData()==null&&!(intent.getParcelableExtra(Intent.EXTRA_STREAM) instanceof Uri))return;
        if(migrationPending){if(deferredIncoming.size()<WorkspaceModel.MAX_TABS)deferredIncoming.addLast(intent);else startupWarning="전달받은 문서가 너무 많아요. 복구가 끝난 뒤 파일 앱에서 다시 열어 주세요.";return;}
        try{EditorSession owner=newEditor(activeEditor(),"blank");owner.handleIncoming(intent);}
        catch(Exception|OutOfMemoryError error){EditorSession active=activeEditor();if(active!=null)active.event("hostError",JSONObject.quote(error.getMessage()==null?"전달받은 문서를 열지 못했어요.":error.getMessage()));}
    }
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);if(!legacyTests)incoming(intent);}
    @Override public void onConfigurationChanged(Configuration config){
        super.onConfigurationChanged(config);for(EditorSession editor:editors.values())if(editor.web!=null){editor.web.getSettings().setTextZoom(Math.round(config.fontScale*100));editor.web.setBackgroundColor(surface());}
        if(root!=null)root.setBackgroundColor(surface());barAppearance();
    }
    @Override protected void onResume(){super.onResume();activityResumed=true;for(EditorSession editor:editors.values()){if(editor.visible&&editor.web!=null)editor.web.onResume();editor.event("resume",Boolean.TRUE);}}
    @Override protected void onPause(){activityResumed=false;for(EditorSession editor:editors.values()){editor.event("pause",Boolean.TRUE);if(editor.web!=null)editor.web.onPause();}super.onPause();}
    @Override public boolean dispatchKeyEvent(KeyEvent event){EditorSession active=activeEditor();if(active!=null&&active.web!=null&&active.visible&&event.getKeyCode()!=KeyEvent.KEYCODE_BACK&&!active.web.hasFocus())active.web.requestFocus();return super.dispatchKeyEvent(event);}
    @Override public void onBackPressed(){
        if(workspace==null||migrationPending){finish();return;}
        EditorSession active=activeEditor();
        if(legacyTests){if(active!=null&&active.web!=null&&active.started)active.web.evaluateJavascript("(function(){if(typeof window.AppBack==='function'){window.AppBack();return true;}return false;})()",value->{if(!"true".equals(value))MainActivity.super.onBackPressed();});else super.onBackPressed();return;}
        if(active==null){try{requestClose(workspace.activeId(),null);}catch(Exception error){showCloseError(error);}return;}
        final long attempt=++active.backAttempt;
        Runnable close=()->{if(isLive(active)&&active.backAttempt==attempt){active.backAttempt++;try{requestClose(active.tabId,active);}catch(Exception error){showCloseError(error);}}};
        closeHandler.postDelayed(close,2500);
        try{active.web.evaluateJavascript("(function(){try{if(document.querySelector('dialog[open], .modal-overlay, .context-menu, #menu-bar .menu-item.open, .tb-split.open')&&typeof window.AppBack==='function'){window.AppBack();return true;}}catch(error){}return false;})()",value->{if(!isLive(active)||active.backAttempt!=attempt)return;if("true".equals(value))active.backAttempt++;else close.run();});}
        catch(RuntimeException unavailable){close.run();}
    }
    private void showCloseError(Exception error){android.widget.Toast.makeText(this,error.getMessage()==null?CLOSE_BUSY:error.getMessage(),android.widget.Toast.LENGTH_LONG).show();}
    @Override protected void onDestroy(){
        activityDestroyed=true;closeHandler.removeCallbacksAndMessages(null);
        for(AlertDialog dialog:new ArrayList<>(unloadedCloseDialogs.values()))dialog.cancel();unloadedCloseDialogs.clear();
        for(String owner:unloadedOwners.values())requests.removeSession(owner);unloadedOwners.clear();
        for(EditorSession editor:editors.values())editor.dispose();editors.clear();workspaceIo.shutdown();super.onDestroy();
    }

    /** RAM-only per-document state. Selecting a tab never navigates or recreates this runtime. */
    private final class EditorSession {
    final String tabId,sessionId=UUID.randomUUID().toString();
    String initialAction,initialRecentId,sessionStartupWarning; boolean visible,initialOpenPending,loaded,hostReady;
    private volatile boolean hasOpenedContent;
    /** IO-thread-owned keys written or explicitly selected/discarded, never mere recovery-list preview reads. */
    private final Set<String> ownedDraftKeys=new HashSet<>();
    private long backAttempt,closeProbe;
    private String pendingCloseToken;
    private boolean closeFallbackRequired;
    private final Set<AlertDialog> nativeDialogs=new HashSet<>();
    private WebView web;
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    /** A scan can take minutes (provider calls, large storage). It runs on its own thread so status, read, save, connect and abort never queue behind it. */
    private final ExecutorService scanner=Executors.newSingleThreadExecutor();
    private final Map<String,File> documents=new ConcurrentHashMap<>();
    /** Unsaved documents receive native-issued identities; they can only create a new file. */
    private final NativeHandleRegistry<String> newDocuments=new NativeHandleRegistry<>("new:");
    private final class SelectedFile {Uri uri;String name,format,mime;long size;}
    /** Temporary SAF selections are opaque and read-only; no content URI crosses the bridge. */
    private final NativeHandleRegistry<SelectedFile> selectedFiles=new NativeHandleRegistry<>("saf:");
    /** Files other apps asked us to open (VIEW/EDIT/SEND). They wait here until the page is ready; only the newest few are kept. */
    private final List<JSONObject> pendingOpens=Collections.synchronizedList(new ArrayList<>());
    private final Map<String,byte[]> blobs=new ConcurrentHashMap<>();
    private final Map<String,Long> blobTimes=new ConcurrentHashMap<>();
    /** A reply the page gave up waiting for (its timeout) would otherwise leave its buffer reserved forever. */
    private void purgeBlobs(){long now=System.currentTimeMillis();for(Map.Entry<String,Long> e:blobTimes.entrySet())if(now-e.getValue()>120000){blobs.remove(e.getKey());blobTimes.remove(e.getKey());}}
    private void putBlob(String token,byte[] data){blobs.put(token,data);blobTimes.put(token,System.currentTimeMillis());}
    /** Each scan owns its stop flag, so cancelling an abandoned scan can never cancel the next one. */
    private volatile AtomicBoolean scanStop=new AtomicBoolean();
    /** Documents any one scan reports, and the share of it linked Termux folders may use (they are scanned first, so a full device cannot hide them). */
    private static final int SCAN_LIMIT=10000,LINKED_SHARE=5000;
    private volatile FileStore store;
    private TermuxFolders termux;
    private long folderPickerRequest=-1;
    private long fontPickerRequest=-1;
    private long filePickerRequest=-1;
    private String filePickerKind="document";
    private FontStore fonts;
    private volatile List<File> roots;
    private boolean started=false;
    private volatile boolean destroyed=false;
    private PdfDocument pdf; private String pdfTarget,pdfName; private int pdfCount,pdfIndex; private long pdfTouched;
    private final NativeSessions<Upload> sessions=new NativeSessions<>();
    /** Encrypted private state (document history, recent documents). Created on first use; unavailable means every state op fails visibly, never a plaintext fallback. */
    private DraftStore drafts;
    private final class Upload extends NativeSessions.Session {final long started=System.currentTimeMillis();String target,sha;boolean replace,backup;boolean studio;int seq,length,width,height;Map<String,String> info;ByteArrayOutputStream out=new ByteArrayOutputStream();}

    EditorSession(String tabId,String initialAction)throws IOException {
        this.tabId=tabId;this.initialAction=initialAction;this.initialOpenPending="open".equals(initialAction);
        termux=new TermuxFolders(MainActivity.this);fonts=services.fonts();store=services.files();roots=workspaceRoots;
        try{
        try{drafts=legacyTests?services.legacyDraftStore():services.draftStoreFor(tabId);}catch(IOException preserved){drafts=null;sessionStartupWarning="이 문서의 복구 저장소를 열지 못했어요. 편집과 파일 저장은 계속할 수 있어요. 기존 복구 자료는 보존했어요.";}
        web=new WebView(MainActivity.this);
        web.setBackgroundColor(surface());
        WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setTextZoom(Math.round(getResources().getConfiguration().fontScale*100));
        s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setAllowFileAccessFromFileURLs(false);s.setAllowUniversalAccessFromFileURLs(false);
        s.setBlockNetworkLoads(true);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // No external URLs are ever loaded; disable remote URL checks for this local-only view.
        s.setSafeBrowsingEnabled(false);s.setGeolocationEnabled(false);s.setDatabaseEnabled(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);s.setSupportMultipleWindows(false);s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);s.setSupportZoom(false);s.setBuiltInZoomControls(false);s.setSaveFormData(false);
        CookieManager.getInstance().setAcceptCookie(false);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0);
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return true;}
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){return intercept(request.getUrl(),request.getMethod());}
            @Override public void onPageFinished(WebView view,String url){if(!isLive(EditorSession.this)||view!=web)return;if(url.equals(ORIGIN+"/index.html")||url.equals(ORIGIN+"/studio/index.html")){started=true;hostReady=hostReady||legacyTests;event("resume",Boolean.TRUE);showStartupWarnings();if(!visible||!activityResumed)web.onPause();}}
            @Override public void onReceivedSslError(WebView view,android.webkit.SslErrorHandler handler,android.net.http.SslError error){handler.cancel();}
            @Override public boolean onRenderProcessGone(WebView view,android.webkit.RenderProcessGoneDetail detail){rendererGone(EditorSession.this);return true;}
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public void onPermissionRequest(PermissionRequest request){request.deny();}
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){callback.onReceiveValue(null);return true;}
            @Override public void onGeolocationPermissionsShowPrompt(String origin,GeolocationPermissions.Callback callback){callback.invoke(origin,false,false);}
            @Override public boolean onJsAlert(WebView view,String url,String message,JsResult result){if(!isLive(EditorSession.this)){result.cancel();return true;}if(!url.startsWith(ORIGIN+"/"))return false;showNativeDialog(new AlertDialog.Builder(MainActivity.this).setTitle("hwpxxx").setMessage(clip(message,8000)).setPositiveButton("확인",(dialog,which)->result.confirm()).setOnCancelListener(dialog->result.cancel()));return true;}
            @Override public boolean onJsConfirm(WebView view,String url,String message,JsResult result){if(!isLive(EditorSession.this)){result.cancel();return true;}if(!url.startsWith(ORIGIN+"/"))return false;showNativeDialog(new AlertDialog.Builder(MainActivity.this).setTitle("hwpxxx").setMessage(clip(message,8000)).setPositiveButton("확인",(dialog,which)->result.confirm()).setNegativeButton("취소",(dialog,which)->result.cancel()).setOnCancelListener(dialog->result.cancel()));return true;}
            @Override public boolean onJsPrompt(WebView view,String url,String message,String value,JsPromptResult result){if(!isLive(EditorSession.this)){result.cancel();return true;}if(!url.startsWith(ORIGIN+"/"))return false;android.widget.EditText input=new android.widget.EditText(MainActivity.this);input.setText(clip(value,1000));input.setSingleLine(true);showNativeDialog(new AlertDialog.Builder(MainActivity.this).setTitle("hwpxxx").setMessage(clip(message,8000)).setView(input).setPositiveButton("확인",(dialog,which)->result.confirm(input.getText().toString())).setNegativeButton("취소",(dialog,which)->result.cancel()).setOnCancelListener(dialog->result.cancel()));return true;}
        });
        web.setDownloadListener((url,ua,cd,mime,len)->{});
        web.addJavascriptInterface(new Bridge(),"OfflineNative");
        web.setOnTouchListener((v,event)->{if(event.getActionMasked()==MotionEvent.ACTION_DOWN)focusSession(EditorSession.this);return false;});
        web.setOnFocusChangeListener((v,focused)->{if(focused)focusSession(EditorSession.this);});
        }catch(RuntimeException|OutOfMemoryError error){dispose();throw error;}
    }
    private void showNativeDialog(AlertDialog.Builder builder){
        AlertDialog dialog=builder.create();nativeDialogs.add(dialog);dialog.setOnDismissListener(ignored->nativeDialogs.remove(dialog));dialog.show();
    }
    private void load(){if(destroyed||loaded||web==null)return;loaded=true;web.loadUrl(ORIGIN+(legacyTests?"/index.html":"/studio/index.html"));}
    private WebResourceResponse blocked(){return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream(new byte[0]));}
    private WebResourceResponse intercept(Uri uri,String method) {
        if(!method.equals("GET")||!"https".equals(uri.getScheme())||!"appassets.androidplatform.net".equals(uri.getHost())||uri.getPort()!=-1||uri.getQuery()!=null)return blocked();
        String path=uri.getPath();if(path==null||path.contains("..")||path.contains("\\")||path.contains("\u0000"))return blocked();
        try {
            InputStream input;String mime;
            if(path.startsWith("/document/")) {byte[] data=blobs.get(path.substring(10));if(data==null)return blocked();input=new ByteArrayInputStream(data);mime="application/octet-stream";}
            else {String n=path.substring(1);if(!n.matches("[A-Za-z0-9_./-]+")||n.isEmpty())return blocked();input=getAssets().open(n);
                mime=n.endsWith(".svg")?"image/svg+xml":n.endsWith(".png")?"image/png":n.endsWith(".ico")?"image/x-icon":n.endsWith(".html")?"text/html":(n.endsWith(".js")||n.endsWith(".mjs"))?"text/javascript":n.endsWith(".css")?"text/css":n.endsWith(".wasm")?"application/wasm":n.endsWith(".ttf")?"font/ttf":n.endsWith(".otf")?"font/otf":n.endsWith(".woff2")?"font/woff2":n.endsWith(".woff")?"font/woff":n.endsWith(".json")?"application/json":n.endsWith(".webmanifest")?"application/manifest+json":"text/plain";}
            Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");headers.put("X-Content-Type-Options","nosniff");
            headers.put("Content-Security-Policy","default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' blob:; connect-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
            return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,input);
        } catch(IOException e){return blocked();}
    }
    private void reply(long id,Object data,String error) {
        JSONObject result=new JSONObject();try{result.put("ok",error==null);if(error==null)result.put("data",data==null?JSONObject.NULL:data);else result.put("error",error);}catch(JSONException ignored){}
        runOnUiThread(()->{if(isLive(EditorSession.this)&&web!=null)web.evaluateJavascript("window.NativeReply&&window.NativeReply("+id+","+result+")",null);});
    }
    private void event(String name,Object data){runOnUiThread(()->{if(isLive(EditorSession.this)&&web!=null)web.evaluateJavascript("window.NativeEvent&&window.NativeEvent("+JSONObject.quote(name)+","+String.valueOf(data)+")",null);});}
    public final class Bridge {
        /** Synchronous immutable mode capability; it does not inspect the UI-thread model. */
        @JavascriptInterface public boolean workspaceEnabled(){return !legacyTests&&!destroyed&&!activityDestroyed;}
        @JavascriptInterface public void postMessage(String message){
            if(message==null)return;
            if(message.length()>400000){java.util.regex.Matcher m=OVERSIZE_ID.matcher(message.substring(0,Math.min(64,message.length())));if(m.find())reply(Long.parseLong(m.group(1)),null,"요청이 너무 커요.");return;}
            try {
                if(!isLive(EditorSession.this))return;
                JSONObject m=new JSONObject(message);long id=m.getLong("id");String op=m.getString("op");JSONObject a=m.optJSONObject("args");if(a==null)a=new JSONObject();final JSONObject args=a;
                if(destroyed)return;
                if(op.startsWith("workspace")){runOnUiThread(()->workspaceOperation(EditorSession.this,id,op,args));return;}
                if(op.equals("cancelScan")){scanStop.set(true);reply(id,true,null);return;}
                if(op.equals("scan")){
                    final AtomicBoolean mine=new AtomicBoolean();scanStop.set(true);scanStop=mine;
                    try{scanner.execute(()->{try{reply(id,scan(mine),null);}catch(OutOfMemoryError e){reply(id,null,"메모리가 부족해 검색을 마치지 못했어요.");}catch(Throwable e){reply(id,null,e.getMessage()==null?"문서를 찾지 못했어요.":e.getMessage());}});}catch(RejectedExecutionException closing){reply(id,null,"앱을 닫는 중이에요.");}
                    return;
                }
                if(op.equals("exit")){runOnUiThread(()->{if(isLive(EditorSession.this)){if(legacyTests){reply(id,true,null);finish();return;}try{requestClose(tabId,EditorSession.this);reply(id,true,null);}catch(Exception error){reply(id,null,error.getMessage()==null?CLOSE_BUSY:error.getMessage());}}});return;}
                if(op.equals("connectFolder")){runOnUiThread(()->{
                    if(folderPickerRequest!=-1){reply(id,null,"폴더 선택을 마쳐 주세요.");return;}
                    try{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION|Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);intent.putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI,android.provider.DocumentsContract.buildDocumentUri(TermuxFolders.AUTHORITY,"/data/data/com.termux/files/home"));folderPickerRequest=id;launchPicker(EditorSession.this,intent,301);}catch(Exception e){folderPickerRequest=-1;reply(id,null,"폴더 선택 화면을 열지 못했어요. Termux 설치를 확인해 주세요.");}
                });return;}
                if(op.equals("fontImport")){runOnUiThread(()->{
                    if(fontPickerRequest!=-1){reply(id,null,"글꼴 선택을 마쳐 주세요.");return;}
                    if(fonts==null){reply(id,null,"글꼴 저장소를 사용할 수 없어요.");return;}
                    try{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.setType("*/*");intent.addCategory(Intent.CATEGORY_OPENABLE);intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);fontPickerRequest=id;launchPicker(EditorSession.this,intent,302);}catch(Exception e){fontPickerRequest=-1;reply(id,null,"글꼴 선택 화면을 열지 못했어요.");}
                });return;}
                if(op.equals("pickFile")){runOnUiThread(()->{
                    if(filePickerRequest!=-1){reply(id,null,"파일 선택을 마쳐 주세요.");return;}
                    try{filePickerKind=args.optString("kind","document");if(!filePickerKind.equals("image"))filePickerKind="document";Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.setType(filePickerKind.equals("image")?"image/*":"*/*");intent.addCategory(Intent.CATEGORY_OPENABLE);intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|(filePickerKind.equals("image")?0:Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION));filePickerRequest=id;launchPicker(EditorSession.this,intent,303);}catch(Exception e){filePickerRequest=-1;reply(id,null,"파일 선택 화면을 열지 못했어요.");}
                });return;}
                if(op.equals("permission")){runOnUiThread(()->{try{Intent intent=new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,Uri.parse("package:"+getPackageName()));startActivity(intent);reply(id,true,null);}catch(Exception e){reply(id,null,"설정에서 hwpxxx의 모든 파일 접근을 허용해 주세요.");}});return;}
                io.execute(()->{try {if(destroyed)return;if(!UNGATED.contains(op)&&!Environment.isExternalStorageManager())throw new IOException("문서에 접근하려면 파일 접근을 허용해 주세요.");reply(id,operation(op,args),null);}catch(OutOfMemoryError e){sessions.clear(EditorSession.this::releaseNewSource);if(op.equals("beginSave"))releaseNewId(args.optString("id",null));reply(id,null,"메모리가 부족해 작업을 마치지 못했어요. 원본은 변경하지 않았어요.");}catch(Throwable e){if(op.equals("beginSave"))releaseNewId(args.optString("id",null));reply(id,null,e.getMessage()==null?"작업을 완료하지 못했어요.":e.getMessage());}});
            }catch(Exception ignored){}
        }
    }
    private JSONObject record(File f)throws Exception {
        String id=FileStore.sha(f.getPath().getBytes(StandardCharsets.UTF_8));documents.put(id,f);
        return obj("id",id,"name",f.getName(),"path",f.getPath(),"folder",f.getParent(),"size",f.length(),"modified",f.lastModified(),"format",documentFormat(f));
    }
    private File document(String id)throws IOException {if(termux.find(id)!=null)throw new IOException("연결 폴더 원본은 유지해요. 다른 이름으로 저장해 주세요.");if(!Environment.isExternalStorageManager())throw new IOException("문서에 접근하려면 파일 접근을 허용해 주세요.");File f=documents.get(id);if(f==null)throw new IOException("문서 목록을 새로고침한 뒤 다시 선택해 주세요.");return store.resolve(f.getPath());}
    private Object operation(String op,JSONObject a)throws Exception {
        if(op.equals("read")||op.equals("readDraft")||op.equals("readHistory")||op.equals("beginSave"))hasOpenedContent=true;
        switch(op){
            case "newDocument": {String format=a.optString("format","hwp");if(!format.matches("hwp|hwpx|hml"))throw new IOException("지원하지 않는 문서 형식이에요.");String id=newDocuments.create(format);return obj("id",id);}
            case "fontList":if(fonts==null)throw new IOException("글꼴 저장소를 사용할 수 없어요.");return new JSONObject(fonts.snapshot());
            case "fontRead": {if(fonts==null)throw new IOException("글꼴 저장소를 사용할 수 없어요.");byte[] bytes=fonts.read(a.getString("id"),a.getString("revision"));purgeBlobs();if(blobs.size()>=2)throw new IOException("다른 파일을 처리 중이에요. 잠시 뒤 다시 시도해 주세요.");String token=UUID.randomUUID().toString();putBlob(token,bytes);return obj("url","/document/"+token,"token",token);}
            case "fontDelete":if(fonts==null)throw new IOException("글꼴 저장소를 사용할 수 없어요.");fonts.delete(a.getString("id"));broadcastEvent("fontsChanged",Boolean.TRUE);return new JSONObject(fonts.snapshot());
            case "clipboardRead": {
                android.content.ClipboardManager clipboard=(android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);ClipData data=clipboard.getPrimaryClip();if(data==null||data.getItemCount()==0)return obj("text","","html","");
                ClipData.Item item=data.getItemAt(0);CharSequence text=item.getText();String html=item.getHtmlText();
                if(!HostState.clipboardWithinLimit(text==null?"":text.toString(),html))throw new IOException("클립보드 내용이 너무 커서 가져올 수 없어요. (글자·서식 합계 256KB까지)");
                JSONObject result=obj("text",text==null?"":text.toString(),"html",html==null?"":html);
                Uri imageUri=item.getUri();
                if(imageUri!=null&&"content".equals(imageUri.getScheme())){
                    try{
                    byte[] raw=ProviderRead.read(resources->{
                        String type=getContentResolver().getType(imageUri);
                        if(type==null||!type.matches("image/(png|jpeg|gif|webp|bmp)"))return null;
                        InputStream input=resources.own(getContentResolver().openInputStream(imageUri));if(input==null)throw new IOException("클립보드 이미지를 읽지 못했어요.");return FileStore.bounded(input,FileStore.MAX_BYTES);
                    });
                    if(raw!=null){
                            validateImage(raw);byte[] png=raw;
                            if(!(raw.length>8&&raw[0]==(byte)137&&raw[1]==80&&raw[2]==78&&raw[3]==71)){Bitmap bitmap=BitmapFactory.decodeByteArray(raw,0,raw.length);if(bitmap==null)throw new IOException("클립보드 이미지를 읽지 못했어요.");try{ByteArrayOutputStream encoded=new ByteArrayOutputStream();bitmap.compress(Bitmap.CompressFormat.PNG,100,encoded);png=encoded.toByteArray();}finally{bitmap.recycle();}}
                            if(png.length>FileStore.MAX_BYTES)throw new IOException("클립보드 이미지가 32MB를 넘어요.");
                            purgeBlobs();if(blobs.size()>=2)throw new IOException("다른 파일을 처리 중이에요. 잠시 뒤 다시 시도해 주세요.");
                            String token=UUID.randomUUID().toString();putBlob(token,png);result.put("image",obj("url","/document/"+token,"token",token,"mime","image/png","size",png.length));
                        }
                    }catch(Exception unreadable){if((text==null||text.length()==0)&&(html==null||html.isEmpty()))throw new IOException("클립보드 이미지를 읽지 못했어요.",unreadable);}
                }
                return result;
            }
            case "historyList":return historyList();
            case "beginHistory":return beginState(a,"history");
            case "finishHistory":return finishHistory(a);
            case "readHistory":return readHistory(a);
            case "deleteHistory": {String id=a.getString("id");if(!HostState.validHistoryId(id))throw new IOException("기록 ID가 올바르지 않아요.");state().delete(HISTORY,id);return true;}
            case "clearHistory":state().clear(HISTORY);return true;
            case "recentList":return recentList();
            case "recentAdd":return recentAdd(a);
            case "recentOpen":return recentOpen(a);
            case "recentRemove": {String id=a.getString("id");if(!HostState.validRecentId(id))throw new IOException("최근 문서 ID가 올바르지 않아요.");PrivateStateStore shared=state();synchronized(shared){shared.delete(RECENT,id);releaseDroppedRecents(shared);}return true;}
            case "recentClear": {PrivateStateStore shared=state();synchronized(shared){shared.clear(RECENT);releaseDroppedRecents(shared);}return true;}
            case "takeOpenRequests": {JSONArray out=new JSONArray();synchronized(pendingOpens){for(JSONObject meta:pendingOpens)out.put(meta);pendingOpens.clear();}return out;}
            case "beginClipboardImage": {
                if(sessions.upload!=null&&System.currentTimeMillis()-sessions.upload.started<120000)throw new IOException("저장 중이에요. 잠시 기다려 주세요.");
                Upload u=new Upload();u.kind="clipimage";u.token=UUID.randomUUID().toString();u.length=a.getInt("length");
                if(u.length<8||u.length>FileStore.MAX_BYTES)throw new IOException("클립보드 이미지의 크기가 올바르지 않아요.");
                String text=a.optString("text",""),html=a.optString("html","");if(!HostState.clipboardWithinLimit(text,html))throw new IOException("복사한 내용이 너무 커서 클립보드에 넣을 수 없어요. (글자·서식 합계 256KB까지)");
                Map<String,String> info=new LinkedHashMap<>();info.put("text",text);info.put("html",html);u.info=info;setUpload(u);return u.token;
            }
            case "finishClipboardImage": {Upload u=requireUpload(a);try{
                if(!u.kind.equals("clipimage")||u.out.size()!=u.length)throw new IOException("클립보드 이미지 크기가 일치하지 않아요.");
                byte[] png=u.out.toByteArray();if(png.length<8||png[0]!=(byte)137||png[1]!=80||png[2]!=78||png[3]!=71||png[4]!=13||png[5]!=10||png[6]!=26||png[7]!=10)throw new IOException("PNG 이미지만 복사할 수 있어요.");
                validateImage(png);Uri uri=ClipboardImageProvider.publish(MainActivity.this,png);String text=u.info.get("text"),html=u.info.get("html");
                ClipData.Item item=new ClipData.Item(text,html.isEmpty()?null:html,null,uri);
                String[] types=html.isEmpty()?new String[]{"text/plain","image/png"}:new String[]{"text/plain","text/html","image/png"};
                ((android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(new ClipData(new ClipDescription("hwpxxx",types),item));
                return true;
            }finally{sessions.upload=null;}}
            case "clipboardWrite": {String text=a.optString("text",""),html=a.optString("html","");if(!HostState.clipboardWithinLimit(text,html))throw new IOException("복사한 내용이 너무 커서 클립보드에 넣을 수 없어요. (글자·서식 합계 256KB까지)");android.content.ClipboardManager clipboard=(android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);clipboard.setPrimaryClip(html.isEmpty()?ClipData.newPlainText("hwpxxx",text):ClipData.newHtmlText("hwpxxx",text,html));return true;}
            case "status": {roots=refreshRoots();JSONArray volumes=new JSONArray();for(int i=0;i<roots.size();i++)volumes.put(obj("path",roots.get(i).getPath(),"name",i==0?"내장 저장공간":"SD 카드 · "+roots.get(i).getName()));return obj("permission",Environment.isExternalStorageManager(),"connectedFolders",termux.list(),"volumes",volumes,"version",BuildConfig.VERSION_NAME,"engine","rhwp 0.8.7");}
            case "disconnectFolder":termux.disconnect(a.getString("id"));broadcastEvent("foldersChanged",Boolean.TRUE);return true;
            case "listDirs": {
                File dir=store.resolve(a.getString("path"));if(!dir.isDirectory()||!dir.canRead())throw new IOException("폴더를 열 수 없어요. 접근 권한을 확인해 주세요.");
                File[] children=dir.listFiles();if(children==null)throw new IOException("폴더 목록을 읽지 못했어요.");JSONArray result=new JSONArray();int n=0;
                for(File f:children){if(f.getName().startsWith(".")||!f.isDirectory())continue;try{store.resolve(f.getPath());}catch(IOException e){continue;}if(++n>3000)throw new IOException("하위 폴더가 너무 많아요. 다른 위치를 선택해 주세요.");String[] entries=f.list();result.put(obj("path",f.getPath(),"name",f.getName(),"modified",f.lastModified(),"count",entries==null?JSONObject.NULL:entries.length));}
                return obj("path",dir.getPath(),"writable",dir.canWrite(),"folders",result);
            }
            case "mkdir": {File f=store.createFolder(a.getString("parent"),a.getString("name"));return obj("path",f.getPath());}
            case "read": {
                String id=a.getString("id");TermuxFolders.Ref linked=termux.find(id);byte[] data;JSONObject meta;String format;
                SelectedFile selected=selectedFiles.get(id);
                if(selected!=null){data=readProviderBytes(selected.uri,FileStore.MAX_BYTES);meta=selectedRecord(id,selected);format=selected.format;}
                else if(linked!=null){data=termux.read(linked);meta=termux.record(linked);format=linked.format;}else{File f=document(id);data=store.read(f.getPath());meta=record(f);format=documentFormat(f);}
                if(format.equals("image"))validateImage(data);else validateDocument(data,format);
                purgeBlobs();if(blobs.size()>=2)throw new IOException("다른 문서를 처리 중이에요. 잠시 뒤 다시 시도해 주세요.");String token=UUID.randomUUID().toString();putBlob(token,data);return obj("url","/document/"+token,"token",token,"sha",FileStore.sha(data),"meta",meta);
            }
            case "release":{String token=a.getString("token");blobs.remove(token);blobTimes.remove(token);return true;}
            case "delete": {String id=a.getString("id");File f=document(id);store.delete(f.getPath());documents.remove(id);return true;}
            case "move": {File src=document(a.getString("id"));File dest=store.move(src.getPath(),a.getString("parent"),src.getName());documents.remove(a.getString("id"));return record(dest);}
            case "rename": {File src=document(a.getString("id"));String name=a.getString("name");if(!FileStore.ext(new File(name)).equals(FileStore.ext(src)))throw new IOException("확장자는 변경할 수 없어요.");File dest=store.move(src.getPath(),src.getParent(),name);documents.remove(a.getString("id"));return record(dest);}
            case "beginPdf": {
                releaseStalePdf();if(pdf!=null)throw new IOException("다른 PDF를 만들고 있어요.");
                pdfTarget=store.resolve(a.getString("target")).getPath();if(!pdfTarget.endsWith(".pdf")||new File(pdfTarget).exists())throw new IOException("같은 이름의 파일이 있거나 PDF 이름이 올바르지 않아요.");
                pdfCount=a.getInt("count");if(pdfCount<1||pdfCount>100)throw new IOException("PDF 저장은 100페이지까지 지원해요.");pdfIndex=0;pdf=new PdfDocument();pdfTouched=System.currentTimeMillis();return true;
            }
            case "beginPrintPdf": {
                releaseStalePdf();if(pdf!=null)throw new IOException("다른 PDF를 만들고 있어요.");pdfCount=a.getInt("count");if(pdfCount<1||pdfCount>100)throw new IOException("인쇄는 100페이지까지 지원해요.");pdfTarget=null;pdfName=clip(a.optString("name","문서"),160);pdfIndex=0;pdf=new PdfDocument();pdfTouched=System.currentTimeMillis();return true;
            }
            case "beginPdfPage": {
                if(pdf==null||sessions.upload!=null||a.getInt("index")!=pdfIndex)throw new IOException("PDF 페이지 순서가 올바르지 않아요.");pdfTouched=System.currentTimeMillis();
                Upload u=new Upload();u.kind="pdf";u.token=UUID.randomUUID().toString();u.length=a.getInt("length");u.width=a.getInt("width");u.height=a.getInt("height");
                if(u.length<8||u.length>8*1024*1024||u.width<36||u.height<36||u.width>2000||u.height>2000)throw new IOException("PDF 페이지의 크기가 너무 커요.");setUpload(u);return u.token;
            }
            case "finishPdfPage": {
                Upload u=requireUpload(a);try {
                    if(pdf==null||!u.kind.equals("pdf")||u.out.size()!=u.length)throw new IOException("PDF 페이지 데이터가 일치하지 않아요.");
                    byte[] data=u.out.toByteArray();BitmapFactory.Options opts=new BitmapFactory.Options();opts.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(data,0,data.length,opts);
                    if(opts.outWidth<1||opts.outHeight<1||(long)opts.outWidth*opts.outHeight>5000000)throw new IOException("PDF 이미지의 크기가 너무 커요.");
                    Bitmap bitmap=BitmapFactory.decodeByteArray(data,0,data.length);if(bitmap==null)throw new IOException("PDF 이미지를 읽지 못했어요.");
                    try{PdfDocument.Page page=pdf.startPage(new PdfDocument.PageInfo.Builder(u.width,u.height,pdfIndex+1).create());page.getCanvas().drawColor(Color.WHITE);page.getCanvas().drawBitmap(bitmap,null,new RectF(0,0,u.width,u.height),new android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG));pdf.finishPage(page);pdfIndex++;pdfTouched=System.currentTimeMillis();}finally{bitmap.recycle();}
                    return true;
                }finally{sessions.upload=null;}
            }
            case "finishPdf": {
                if(pdf==null||pdfIndex!=pdfCount)throw new IOException("PDF 페이지가 모두 준비되지 않았어요.");
                if(pdfTarget!=null&&!Environment.isExternalStorageManager())throw new IOException("파일 접근 권한을 확인해 주세요.");
                File temp=File.createTempFile("offline-pdf-",".pdf",getCacheDir());boolean printing=pdfTarget==null;try{try(FileOutputStream out=new FileOutputStream(temp)){pdf.writeTo(out);out.getFD().sync();}if(temp.length()>FileStore.MAX_BYTES)throw new IOException("PDF가 32MB를 넘어요.");if(printing){final int count=pdfCount;final String name=pdfName;runOnUiThread(()->printPdf(temp,name,count));return obj("printing",true);}byte[] bytes;try(InputStream in=new FileInputStream(temp)){bytes=FileStore.bounded(in,FileStore.MAX_BYTES);}store.write(pdfTarget,bytes,null,false);return obj("path",pdfTarget);}catch(Exception error){temp.delete();throw error;}finally{pdf.close();pdf=null;if(!printing)temp.delete();}
            }
            case "abortPdf":if(sessions.abortPdf(a.optString("token",null))&&pdf!=null){pdf.close();pdf=null;}return true;
            case "beginExport": {
                if(sessions.upload!=null&&System.currentTimeMillis()-sessions.upload.started<120000)throw new IOException("저장 중이에요. 잠시 기다려 주세요.");Upload u=new Upload();u.kind="export";u.token=UUID.randomUUID().toString();File target=store.resolve(a.getString("target"));FileStore.name(target.getName());String ext=exportExtension(target.getName());if(!ext.matches("html|htm|doc|mhtml|mht|txt|svg|png|jpg|jpeg|hml"))throw new IOException("지원하지 않는 내보내기 형식이에요.");if(target.exists())throw new IOException("같은 이름의 파일이 있어요. 이름을 바꿔 주세요.");u.target=target.getPath();u.length=a.getInt("length");if(u.length<1||u.length>FileStore.MAX_BYTES)throw new IOException("내보내기 결과가 32MB를 넘거나 비어 있어요.");setUpload(u);return u.token;
            }
            case "finishExport": {Upload u=requireUpload(a);try{if(!u.kind.equals("export")||u.out.size()!=u.length)throw new IOException("내보내기 크기가 일치하지 않아요.");byte[] bytes=u.out.toByteArray();if(exportExtension(u.target).equals("hml"))validateDocument(bytes,"hml");File target=writeAdditional(u.target,bytes,null,false);return obj("path",target.getPath());}finally{sessions.upload=null;}}
            case "beginSave": {
                // A session older than two minutes is treated as abandoned rather than blocking every later save.
                if(sessions.upload!=null&&System.currentTimeMillis()-sessions.upload.started<120000)throw new IOException("저장 중이에요. 잠시 기다려 주세요.");
                Upload u=new Upload();u.token=UUID.randomUUID().toString();u.sourceId=a.getString("id");try{TermuxFolders.Ref linked=termux.find(u.sourceId);
                File src;if(newDocuments.containsKey(u.sourceId)){
                    if(a.optBoolean("replace",false))throw new IOException("새 문서는 다른 이름으로 저장해 주세요.");
                    src=new File("untitled."+newDocuments.get(u.sourceId));
                }else if(selectedFiles.containsKey(u.sourceId)){
                    if(a.optBoolean("replace",false))throw new IOException("선택한 파일 원본은 유지해요. 다른 이름으로 저장해 주세요.");src=new File(selectedFiles.get(u.sourceId).name);
                }else if(u.sourceId.startsWith("draft:")){
                    // A recovered edit is only ever saved as a new copy; the original document is never its save target.
                    if(drafts==null||!DraftStore.validKey(u.sourceId.substring(6)))throw new IOException("복구 항목을 찾을 수 없어요.");
                    if(a.optBoolean("replace",false))throw new IOException("복구한 내용은 다른 이름으로 저장해 주세요.");
                    String selectedKey=u.sourceId.substring(6);ownedDraftKeys.add(selectedKey);src=new File(drafts.info(selectedKey).get("name"));
                } else {src=linked==null?document(u.sourceId):new File(linked.name);if(linked!=null&&a.optBoolean("replace",false))throw new IOException("연결 폴더 원본은 유지해요. 다른 이름으로 저장해 주세요.");}u.target=store.resolve(a.getString("target")).getPath();u.replace=a.optBoolean("replace",false);u.backup=u.replace&&a.optBoolean("backup",false);u.sha=a.optString("sha","");u.length=a.getInt("length");
                if(u.length<8||u.length>FileStore.MAX_BYTES)throw new IOException("저장할 문서가 너무 커요.");
                // Explicit desktop format conversion is allowed only when creating a new copy.
                String format=a.optString("format",documentFormat(src));if(!format.matches("hwp|hwpx|hml")||!documentFormat(new File(u.target)).equals(format))throw new IOException("저장할 문서 형식이 일치하지 않아요.");
                if(u.replace&&!format.equals(documentFormat(src)))throw new IOException("원래 문서 형식을 유지해 주세요.");
                // Same-file desktop saves require a baseline hash and retain the original HWP backup policy.
                u.studio=a.optBoolean("studio",false);if(u.studio&&u.replace){if(!u.sha.matches("[0-9a-f]{64}"))throw new IOException("원본 확인 정보가 없어요. 문서를 다시 열어 주세요.");u.backup=true;}
                if(u.replace&&!u.target.equals(src.getPath()))throw new IOException("원본 저장 경로가 일치하지 않아요.");
                if(!u.replace&&new File(u.target).exists())throw new IOException("같은 이름의 파일이 있어요. 이름이나 폴더를 바꿔 주세요.");setUpload(u);return u.token;}catch(Exception|Error failed){releaseNewSource(u);throw failed;}
            }
            case "saveChunk": {Upload u=requireAnyUpload(a);if(a.getInt("seq")!=u.seq++)throw new IOException("저장 순서가 올바르지 않아요.");String b=a.getString("base64");if(b.length()>350000)throw new IOException("저장 조각이 너무 커요.");byte[] data=android.util.Base64.decode(b,android.util.Base64.DEFAULT);if(u.out.size()+data.length>u.length)throw new IOException("저장 크기가 일치하지 않아요.");u.out.write(data);return true;}
            case "abortSave":sessions.abort(a.optString("token",null),this::releaseNewSource);return true;
            case "finishSave": {Upload u=requireUpload(a);try{if(!u.kind.equals("document")||u.out.size()!=u.length)throw new IOException("저장 크기가 일치하지 않아요.");byte[] bytes=u.out.toByteArray();
                synchronized(FileStore.class){
                File backup=null;
                if(u.backup){try{backup=u.studio?new ExportStore(store).backup(u.target,u.sha,new java.text.SimpleDateFormat("yyyyMMdd-HHmmss",Locale.ROOT).format(new Date())):store.backup(u.target,u.sha,new java.text.SimpleDateFormat("yyyyMMdd-HHmmss",Locale.ROOT).format(new Date()));}catch(IOException e){throw new IOException("원본 백업을 만들지 못해 저장을 멈췄어요. 원본은 변경하지 않았어요. "+e.getMessage(),e);}}
                try{File dest;if(documentFormat(new File(u.target)).equals("hml")){validateDocument(bytes,"hml");dest=writeAdditional(u.target,bytes,u.sha,u.replace);}else dest=store.write(u.target,bytes,u.sha,u.replace);newDocuments.remove(u.sourceId);return obj("meta",record(dest),"sha",FileStore.sha(bytes),"backup",backup==null?JSONObject.NULL:record(backup));}
                catch(IOException e){if(backup!=null){if(originalIntact(u))backup.delete();else throw new IOException(e.getMessage()+" 원본 백업은 지우지 않고 남겨 두었어요: "+backup.getName(),e);}throw e;}
                }
            }finally{sessions.upload=null;releaseNewSource(u);}}
            case "beginDraft": {
                if(drafts==null)throw new IOException("복구 저장소를 사용할 수 없어요.");
                if(sessions.draft!=null&&System.currentTimeMillis()-sessions.draft.started<120000)throw new IOException("복구 자료를 저장하고 있어요.");
                Upload u=new Upload();u.kind="draft";u.token=UUID.randomUUID().toString();u.sourceId=a.getString("id");u.length=a.getInt("length");
                if(u.length<8||u.length>FileStore.MAX_BYTES)throw new IOException("복구 자료의 크기가 올바르지 않아요.");
                Map<String,String> info=new LinkedHashMap<>();info.put("name",clip(a.optString("name"),240));info.put("path",clip(a.optString("path"),2000));info.put("folder",clip(a.optString("folder"),2000));info.put("format",a.getString("format"));info.put("encrypted",a.optBoolean("encrypted",false)?"true":"false");info.put("external",a.optBoolean("external",false)?"true":"false");info.put("lossy",a.optBoolean("lossy",false)?"true":"false");info.put("docId",clip(a.optString("docId"),200));
                u.info=info;sessions.draft=u;return u.token;
            }
            case "finishDraft": {
                String token=a.getString("token");Upload u=sessions.draft;if(u==null||!u.token.equals(token))throw new IOException("복구 저장 세션이 만료되었어요.");
                try{if(!u.kind.equals("draft")||u.out.size()!=u.length)throw new IOException("복구 자료 크기가 일치하지 않아요.");
                    if(destroyed)throw new IOException("문서가 닫혔어요.");
                    String key=u.sourceId.startsWith("draft:")?u.sourceId.substring(6):DraftStore.key(u.sourceId);ownedDraftKeys.add(key);drafts.write(key,u.info,u.out.toByteArray());return obj("key",key);
                }finally{sessions.draft=null;}
            }
            case "abortDraft":sessions.abort(a.optString("token",null),this::releaseNewSource);return true;
            case "listDrafts": {JSONArray out=new JSONArray();if(drafts!=null)for(Map<String,String> m:drafts.list())out.put(draftJson(m));return out;}
            case "readDraft": {
                if(drafts==null)throw new IOException("복구 저장소를 사용할 수 없어요.");
                String key=draftKey(a);Map<String,String> m=drafts.info(key);byte[] data=drafts.read(key);
                purgeBlobs();if(blobs.size()>=2)throw new IOException("다른 문서를 처리 중이에요. 잠시 뒤 다시 시도해 주세요.");String token=UUID.randomUUID().toString();putBlob(token,data);
                JSONObject meta=obj("id","draft:"+key,"name",m.get("name"),"path",m.get("path"),"folder",m.get("folder"),"size",data.length,"modified",Long.parseLong(m.get("savedAt")),"format",m.get("format"),"external",true,"draft",true,"encrypted","true".equals(m.get("encrypted")));
                return obj("url","/document/"+token,"token",token,"sha",FileStore.sha(data),"meta",meta);
            }
            case "discardDraft": {if(drafts==null)return true;String key=draftKey(a);if(DraftStore.validKey(key)){ownedDraftKeys.add(key);drafts.delete(key);}return true;}
            default:throw new IOException("지원하지 않는 작업이에요.");
        }
    }
    /** A PDF whose page may have been abandoned (page reload, killed render) must not block every later print for the rest of the session. */
    private void releaseStalePdf(){if(pdf!=null&&System.currentTimeMillis()-pdfTouched>120000){try{pdf.close();}catch(Exception ignored){}pdf=null;sessions.abortPdf(null);}}
    /** Print/PDF staging files live in app-private cache and are normally deleted by the print service; sweep any left by a killed process. */
    // ---- encrypted private state: document history + recent documents (PrivateStateStore, AndroidKeystore AES-256-GCM key) ----
    private final String HISTORY="history",RECENT="recent";
    private PrivateStateStore state()throws IOException {return services.state();}
    private JSONObject jsonOf(byte[] bytes)throws Exception {return new JSONObject(new String(bytes,StandardCharsets.UTF_8));}
    private Object historyList()throws Exception {
        PrivateStateStore store=state();JSONArray entries=new JSONArray();
        for(PrivateStateStore.Record record:store.list(HISTORY)){try{JSONObject meta=jsonOf(record.meta);meta.put("id",record.id);entries.put(meta);}catch(Exception unreadable){/* counted below via the store's corrupt counter */}}
        return obj("entries",entries,"unreadable",store.lastListCorruptCount());
    }
    private Object beginState(JSONObject a,String kind)throws Exception {
        if(sessions.state!=null&&System.currentTimeMillis()-sessions.state.started<120000)throw new IOException("기록을 저장하고 있어요. 잠시 기다려 주세요.");
        String id=a.getString("id"),metaText=a.getString("meta");int length=a.getInt("length");
        if(!HostState.validHistoryId(id))throw new IOException("기록 ID가 올바르지 않아요.");
        if(!HostState.validMeta(metaText))throw new IOException("기록 정보가 올바르지 않아요.");
        JSONObject meta=new JSONObject(metaText);if(!id.equals(meta.optString("id")))throw new IOException("기록 정보가 ID와 맞지 않아요.");
        if(length<1||length>FileStore.MAX_BYTES)throw new IOException("기록이 비어 있거나 32MB를 넘어요.");
        state();Upload u=new Upload();u.kind=kind;u.token=UUID.randomUUID().toString();u.sourceId=id;u.length=length;Map<String,String> info=new LinkedHashMap<>();info.put("meta",metaText);u.info=info;sessions.state=u;return u.token;
    }
    private Object finishHistory(JSONObject a)throws Exception {
        String token=a.getString("token");Upload u=sessions.state;if(u==null||!u.token.equals(token))throw new IOException("기록 저장 세션이 만료되었어요.");
        try{if(!u.kind.equals("history")||u.out.size()!=u.length)throw new IOException("기록 크기가 일치하지 않아요.");
            JSONObject meta=new JSONObject(u.info.get("meta"));meta.put("byteLength",u.length);
            state().put(HISTORY,u.sourceId,meta.toString().getBytes(StandardCharsets.UTF_8),u.out.toByteArray());return true;
        }finally{sessions.state=null;}
    }
    private Object readHistory(JSONObject a)throws Exception {
        String id=a.getString("id");if(!HostState.validHistoryId(id))throw new IOException("기록 ID가 올바르지 않아요.");
        PrivateStateStore.Record record=state().get(HISTORY,id);if(record==null)return JSONObject.NULL;
        purgeBlobs();if(blobs.size()>=2)throw new IOException("다른 문서를 처리 중이에요. 잠시 뒤 다시 시도해 주세요.");
        String token=UUID.randomUUID().toString();putBlob(token,record.payload);return obj("url","/document/"+token,"token",token);
    }
    private Object recentList()throws Exception {
        PrivateStateStore store=state();JSONArray out=new JSONArray();
        for(PrivateStateStore.Record record:store.list(RECENT)){try{JSONObject meta=jsonOf(record.meta);out.put(obj("id",record.id,"fileName",meta.getString("fileName"),"sourceFormat",meta.getString("sourceFormat"),"openedAt",meta.getLong("openedAt"),"reopenable",meta.getBoolean("reopenable")));}catch(Exception unreadable){}}
        return out;
    }
    /** The source is resolved natively from the host's opaque id; the page never supplies a path or URI. Sources that cannot be reopened later are stored as names only. */
    private Object recentAdd(JSONObject a)throws Exception {
        // Grant and catalog changes are one transaction across all sessions and Activity instances.
        synchronized(state()){
        String fileName=clip(a.optString("fileName"),240),format=a.optString("sourceFormat","hwp"),sourceId=a.optString("sourceId","");
        if(fileName.isEmpty()||!format.matches("hwp|hwpx|hml"))throw new IOException("최근 문서 정보가 올바르지 않아요.");FileStore.name(fileName);
        JSONObject meta=obj("fileName",fileName,"sourceFormat",format,"openedAt",System.currentTimeMillis(),"reopenable",false);String key="name:"+format+":"+fileName;
        File file=documents.get(sourceId);SelectedFile selected=selectedFiles.get(sourceId);
        if(file!=null){meta.put("kind","path");meta.put("path",file.getPath());meta.put("reopenable",true);key="path:"+file.getPath();}
        else if(selected!=null){
            // A picked document can be reopened later only if the system lets us keep read access to it.
            try{getContentResolver().takePersistableUriPermission(selected.uri,Intent.FLAG_GRANT_READ_URI_PERMISSION);meta.put("kind","uri");meta.put("uri",selected.uri.toString());meta.put("reopenable",true);key="uri:"+selected.uri;}catch(SecurityException notPersistable){}
        }
        String id=HostState.recentId(key);
        PrivateStateStore store=state();
        // Keep the 30 newest; a dropped entry also releases the read access we kept for it.
        store.put(RECENT,id,meta.toString().getBytes(StandardCharsets.UTF_8),new byte[0]);
        releaseDroppedRecents(store);
        return true;
        }
    }
    private void releaseDroppedRecents(PrivateStateStore store){
        try{
            Set<String> kept=new HashSet<>();for(PrivateStateStore.Record record:store.list(RECENT)){try{String uri=jsonOf(record.meta).optString("uri","");if(!uri.isEmpty())kept.add(uri);}catch(Exception ignored){}}
            for(UriPermission permission:getContentResolver().getPersistedUriPermissions()){
                // Only single-document grants this feature kept (never folder/tree grants such as Termux) and no longer referenced are released.
                if(!kept.contains(permission.getUri().toString())&&!android.provider.DocumentsContract.isTreeUri(permission.getUri()))getContentResolver().releasePersistableUriPermission(permission.getUri(),Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }
        }catch(Exception ignored){}
    }
    private Object recentOpen(JSONObject a)throws Exception {
        String id=a.getString("id");PrivateStateStore.Record record=state().get(RECENT,id);
        if(record==null)throw new IOException(HostState.coded("NotFound","최근 문서 목록에서 찾을 수 없어요."));
        JSONObject meta=jsonOf(record.meta);String kind=meta.optString("kind","");
        if(kind.equals("path")){
            if(!Environment.isExternalStorageManager())throw new IOException(HostState.coded("NotAllowed","문서에 접근하려면 파일 접근을 허용해 주세요."));
            File file;try{file=store.resolve(meta.getString("path"));}catch(IOException outside){throw new IOException(HostState.coded("NotAllowed","이 위치의 문서는 열 수 없어요."));}
            if(!file.isFile())throw new IOException(HostState.coded("NotFound","문서를 찾을 수 없어요. 옮기거나 지웠는지 확인해 주세요."));
            return record(file);
        }
        if(kind.equals("uri")){
            Uri uri=Uri.parse(meta.getString("uri"));boolean granted=false;
            for(UriPermission permission:getContentResolver().getPersistedUriPermissions())if(permission.getUri().equals(uri)&&permission.isReadPermission())granted=true;
            if(!granted)throw new IOException(HostState.coded("NotAllowed","이 파일의 접근 권한이 없어졌어요. 다시 선택해 주세요."));
            try{return registerSelection(uri,"document");}
            catch(FileNotFoundException gone){throw new IOException(HostState.coded("NotFound","문서를 찾을 수 없어요."));}
            catch(SecurityException denied){throw new IOException(HostState.coded("NotAllowed","이 파일의 접근 권한이 없어졌어요. 다시 선택해 주세요."));}
        }
        throw new IOException(HostState.coded("NotAllowed","이 문서는 다시 선택해야 열 수 있어요."));
    }
    /** A failed write only discards its backup when the original still holds exactly the bytes the backup copied; otherwise the backup is the only good copy. */
    private boolean originalIntact(Upload u){try{return u.sha!=null&&!u.sha.isEmpty()&&FileStore.sha(store.read(u.target)).equals(u.sha);}catch(Exception unreadable){return false;}}
    private void setUpload(Upload value){Upload previous=sessions.upload;sessions.upload=value;releaseNewSource(previous);}
    private void releaseNewId(String id){if(id!=null&&id.startsWith("new:")&&!sessions.referencesSource(id))newDocuments.remove(id);}
    private void releaseNewSource(Upload value){if(value!=null)releaseNewId(value.sourceId);}
    private Upload requireUpload(JSONObject a)throws Exception{if(sessions.upload==null||!sessions.upload.token.equals(a.getString("token")))throw new IOException("저장 세션이 만료되었어요.");return sessions.upload;}
    private String documentFormat(File file){return ExportStore.documentFormat(file);}
    private String exportExtension(String name){return ExportStore.extension(name);}
    private void validateImage(byte[] bytes)throws IOException {
        BitmapFactory.Options options=new BitmapFactory.Options();options.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
        if(options.outWidth<1||options.outHeight<1||(long)options.outWidth*options.outHeight>25000000)throw new IOException("이미지 형식을 확인하지 못했거나 이미지가 너무 커요.");
    }
    private void validateDocument(byte[] bytes,String format)throws IOException {ExportStore.validateDocument(bytes,format);}
    private JSONObject selectedRecord(String id,SelectedFile file)throws JSONException{return obj("id",id,"name",file.name,"folder","선택한 파일","size",file.size,"modified",0,"format",file.format,"mime",file.mime,"external",true);}
    private File writeAdditional(String target,byte[] bytes,String expectedSha,boolean replace)throws IOException {return new ExportStore(store).write(target,bytes,expectedSha,replace);}
    private void printPdf(File file,String name,int pages){
        if(destroyed){file.delete();return;}
        PrintManager manager=(PrintManager)getSystemService(PRINT_SERVICE);
        try {manager.print(name==null||name.isEmpty()?"hwpxxx":name,new PrintDocumentAdapter(){
            @Override public void onLayout(PrintAttributes oldAttributes,PrintAttributes newAttributes,CancellationSignal cancellation,LayoutResultCallback callback,Bundle extras){if(cancellation.isCanceled()){callback.onLayoutCancelled();return;}callback.onLayoutFinished(new PrintDocumentInfo.Builder("hwpxxx.pdf").setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).setPageCount(pages).build(),!newAttributes.equals(oldAttributes));}
            @Override public void onWrite(PageRange[] ranges,ParcelFileDescriptor destination,CancellationSignal cancellation,WriteResultCallback callback){try(InputStream input=new FileInputStream(file);OutputStream output=new FileOutputStream(destination.getFileDescriptor())){byte[] buffer=new byte[16384];int count;while((count=input.read(buffer))!=-1){if(cancellation.isCanceled()){callback.onWriteCancelled();return;}output.write(buffer,0,count);}callback.onWriteFinished(new PageRange[]{PageRange.ALL_PAGES});}catch(IOException error){callback.onWriteFailed("인쇄 자료를 읽지 못했어요.");}}
            @Override public void onFinish(){file.delete();}
        },null);}catch(Exception error){file.delete();event("hostError",JSONObject.quote("인쇄 서비스를 열지 못했어요."));}
    }
    private Upload requireAnyUpload(JSONObject a)throws Exception{String token=a.getString("token");if(sessions.draft!=null&&sessions.draft.token.equals(token))return sessions.draft;if(sessions.state!=null&&sessions.state.token.equals(token))return sessions.state;return requireUpload(a);}
    private String clip(String s,int max){return s==null?"":s.length()>max?s.substring(0,max):s;}
    private JSONObject draftJson(Map<String,String> m)throws JSONException{return obj("key",m.get("key"),"name",m.get("name"),"path",m.get("path"),"folder",m.get("folder"),"format",m.get("format"),"size",Long.parseLong(m.get("size")),"savedAt",Long.parseLong(m.get("savedAt")),"encrypted","true".equals(m.get("encrypted")),"external","true".equals(m.get("external")),"lossy","true".equals(m.get("lossy")),"docId",m.getOrDefault("docId",""));}
    private String draftKey(JSONObject a)throws Exception{String key=a.optString("key","");if(!key.isEmpty())return key;String id=a.getString("id");return id.startsWith("draft:")?id.substring(6):DraftStore.key(id);}
    private Object scan(AtomicBoolean stop)throws Exception {
        int count=0,skipped=0,visited=0;boolean limit=false;
        // Linked Termux folders first: they are few and chosen on purpose, and a device with a huge shared storage must not hide them.
        TermuxFolders.Scan linked=termux.scan(stop,LINKED_SHARE,b->event("scanBatch",b),(f,d)->{try{event("scanProgress",obj("folders",f,"documents",d));}catch(JSONException ignored){}});
        count+=linked.count;skipped+=linked.skipped;limit=linked.limited;visited=linked.folders;
        ArrayDeque<File> dirs=new ArrayDeque<>(Environment.isExternalStorageManager()&&!stop.get()?roots:Collections.emptyList());Set<String> seen=new HashSet<>();JSONArray batch=new JSONArray();
        final int budget=SCAN_LIMIT-count;int found=0;
        while(!dirs.isEmpty()&&!stop.get()) {
            File d=dirs.removeFirst();try{d=store.resolve(d.getPath());}catch(IOException e){continue;}
            if(!seen.add(d.getPath()))continue;if(++visited>50000+linked.folders){limit=true;break;}
            File[] files=d.listFiles();if(files==null){skipped++;continue;}
            for(File f:files) {
                if(stop.get())break;if(f.getName().startsWith("."))continue;
                boolean dir=f.isDirectory();if(!dir&&!documentFormat(f).matches("hwp|hwpx|hml"))continue;
                try{f=store.resolve(f.getPath());}catch(IOException e){continue;}
                if(f.isDirectory()){int baseDepth=roots.get(0).toPath().getNameCount();if(f.toPath().getNameCount()-baseDepth<64)dirs.addLast(f);}
                else if(!dir){
                    if(++found>budget){limit=true;dirs.clear();break;}
                    batch.put(record(f));if(batch.length()>=24){event("scanBatch",batch);batch=new JSONArray();}
                }
            }
            if(visited%25==0)event("scanProgress",obj("folders",visited,"documents",count+Math.min(found,budget)));
        }
        if(batch.length()>0)event("scanBatch",batch);
        count+=Math.min(found,budget);
        return obj("cancelled",stop.get(),"limited",limit,"skipped",skipped,"count",count);
    }
    /** Only detached bytes cross the deadline. Late workers never import fonts or register a source. */
    private byte[] readProviderBytes(Uri uri,int maximum)throws Exception {
        return ProviderRead.read(resources->{InputStream input=resources.own(getContentResolver().openInputStream(uri));if(input==null)throw new IOException("파일을 읽지 못했어요.");return FileStore.bounded(input,maximum);});
    }
    /** A user-chosen or Intent-delivered content URI becomes an opaque read-only handle, only after the bounded read succeeds. */
    private JSONObject registerSelection(Uri uri,String kind)throws Exception {
        SelectedFile file=ProviderRead.read(resources->{
            SelectedFile result=new SelectedFile();result.uri=uri;result.name="";result.mime=getContentResolver().getType(uri);
            CancellationSignal cancellation=new CancellationSignal();resources.own(()->cancellation.cancel());
            android.database.Cursor cursor=resources.own(getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE},null,null,null,cancellation));
            if(cursor!=null&&cursor.moveToFirst()){result.name=cursor.getString(0);result.size=cursor.isNull(1)?0:cursor.getLong(1);}
            InputStream input=resources.own(getContentResolver().openInputStream(uri));if(input==null)throw new IOException("파일을 읽지 못했어요.");byte[] bytes=FileStore.bounded(input,FileStore.MAX_BYTES);
            if(kind.equals("image"))result.format="image";
            else{
                result.format=HostIntents.documentFormat(result.name,result.mime,Arrays.copyOf(bytes,Math.min(bytes.length,64)));
                if(result.format==null)throw new IOException("HWP·HWPX·HML 문서를 선택해 주세요.");
                result.name=HostIntents.nameWithExtension(result.name,result.format);
            }
            FileStore.name(result.name);if(kind.equals("image"))validateImage(bytes);else validateDocument(bytes,result.format);result.size=bytes.length;return result;
        });
        if(destroyed)throw new IOException("문서가 닫혔어요.");
        String token=selectedFiles.register(uri.toString(),file);return selectedRecord(token,file);
    }
    /** VIEW / EDIT / SEND with a content:// document. Anything else (file:, http:, other actions) is refused with a visible message; the document opens as a read-only original. */
    private void handleIncoming(Intent intent){
        if(intent==null||!HostIntents.acceptableIncomingAction(intent.getAction()))return;
        Uri uri=intent.getData();
        if(uri==null){Object extra=intent.getParcelableExtra(Intent.EXTRA_STREAM);if(extra instanceof Uri)uri=(Uri)extra;}
        if(uri==null)return;
        final Uri document=uri;
        if(!HostIntents.acceptableIncomingScheme(document.getScheme())){event("hostError",JSONObject.quote("이 방식으로 전달된 파일은 열 수 없어요. 파일 앱의 공유 또는 '연결 프로그램'을 사용해 주세요."));return;}
        try{io.execute(()->{try{
            if(destroyed)return;
            JSONObject meta=registerSelection(document,"document");
            synchronized(pendingOpens){pendingOpens.add(meta);while(pendingOpens.size()>4)pendingOpens.remove(0);}
            event("openRequest",Boolean.TRUE);
        }catch(OutOfMemoryError error){sessions.clear(this::releaseNewSource);event("hostError",JSONObject.quote("메모리가 부족해 파일을 열지 못했어요. 원본은 변경하지 않았어요."));}catch(Exception error){event("hostError",JSONObject.quote(error.getMessage()==null?"전달받은 파일을 열지 못했어요.":error.getMessage()));}});}catch(RejectedExecutionException closing){}
    }
    private void pickerResult(int request,int result,Intent data){
        if(!isLive(this))return;
        if(request==303){final long id=filePickerRequest;final String kind=filePickerKind;filePickerRequest=-1;if(id<0)return;if(result!=RESULT_OK||data==null||data.getData()==null){reply(id,null,null);return;}final Uri uri=data.getData();try{io.execute(()->{try{
            if(destroyed)return;
            reply(id,registerSelection(uri,kind),null);
        }catch(OutOfMemoryError error){sessions.clear(this::releaseNewSource);reply(id,null,"메모리가 부족해 파일을 열지 못했어요. 원본은 변경하지 않았어요.");}catch(Exception error){reply(id,null,error.getMessage()==null?"선택한 파일을 읽지 못했어요.":error.getMessage());}});}catch(RejectedExecutionException closing){reply(id,null,"앱을 닫는 중이에요.");}return;}
        if(request==302){final long id=fontPickerRequest;fontPickerRequest=-1;if(id<0)return;if(result!=RESULT_OK||data==null||data.getData()==null){reply(id,null,null);return;}final Uri uri=data.getData();try{io.execute(()->{try{if(destroyed)return;if(fonts==null)throw new IOException("글꼴 저장소를 사용할 수 없어요.");byte[] bytes=readProviderBytes(uri,FontStore.MAX_FONT_BYTES);if(destroyed)return;fonts.importFont(new ByteArrayInputStream(bytes));reply(id,new JSONObject(fonts.snapshot()),null);broadcastEvent("fontsChanged",Boolean.TRUE);}catch(OutOfMemoryError error){sessions.clear(this::releaseNewSource);reply(id,null,"메모리가 부족해 글꼴을 가져오지 못했어요.");}catch(Exception e){reply(id,null,e.getMessage()==null?"글꼴을 가져오지 못했어요.":e.getMessage());}});}catch(RejectedExecutionException closing){reply(id,null,"앱을 닫는 중이에요.");}return;}
        if(request!=301)return;final long id=folderPickerRequest;folderPickerRequest=-1;
        // The root has already rejected results whose owning session no longer exists.
        if(result!=RESULT_OK||data==null||data.getData()==null){if(id>=0)reply(id,false,null);return;}
        final Uri tree=data.getData();
        try{io.execute(()->{try{if(destroyed)return;termux.connect(tree);if(id>=0)reply(id,true,null);broadcastEvent("foldersChanged",Boolean.TRUE);}catch(Exception e){if(id>=0)reply(id,null,e.getMessage()==null?"폴더를 연결하지 못했어요.":e.getMessage());else broadcastEvent("foldersChanged",Boolean.TRUE);}});}catch(RejectedExecutionException closing){}
    }
    private void dispose(){dispose(false);}
    private void dispose(boolean confirmedClose){
        if(destroyed)return;destroyed=true;visible=false;requests.removeSession(sessionId);scanStop.set(true);scanner.shutdownNow();
        for(AlertDialog dialog:new ArrayList<>(nativeDialogs))dialog.cancel();nativeDialogs.clear();
        try{io.execute(()->{if(confirmedClose&&drafts!=null)for(String key:ownedDraftKeys)try{drafts.delete(key);}catch(IOException preserved){}ownedDraftKeys.clear();blobs.clear();blobTimes.clear();documents.clear();pendingOpens.clear();sessions.clear(this::releaseNewSource);if(pdf!=null){try{pdf.close();}catch(Exception ignored){}pdf=null;}});}catch(RejectedExecutionException ignored){}
        io.shutdown();
        if(web!=null){web.removeJavascriptInterface("OfflineNative");if(web.getParent() instanceof android.view.ViewGroup)((android.view.ViewGroup)web.getParent()).removeView(web);web.destroy();web=null;}
    }
    }
}
