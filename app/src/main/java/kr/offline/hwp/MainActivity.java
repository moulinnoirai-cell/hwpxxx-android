package kr.offline.hwp;

import android.app.*;
import android.os.*;
import android.content.*;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.provider.Settings;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.RectF;
import android.graphics.pdf.PdfDocument;
import android.view.*;
import android.widget.FrameLayout;
import android.webkit.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

/** A new application: no code or SDK from the audited Android wrapper. */
public class MainActivity extends Activity {
    private static final String ORIGIN="https://appassets.androidplatform.net";
    /** Operations that never touch shared storage: status, in-memory buffers, the user-selected Termux tree and app-private recovery drafts. */
    private static final Set<String> UNGATED=new HashSet<>(Arrays.asList("status","release","abortSave","abortPdf","disconnectFolder","scan","read","saveChunk","beginDraft","finishDraft","abortDraft","listDrafts","readDraft","discardDraft"));
    private static final java.util.regex.Pattern OVERSIZE_ID=java.util.regex.Pattern.compile("^\\{\"id\":(\\d+)");
    private WebView web;
    private FrameLayout root;
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    /** A scan can take minutes (provider calls, large storage). It runs on its own thread so status, read, save, connect and abort never queue behind it. */
    private final ExecutorService scanner=Executors.newSingleThreadExecutor();
    private final Map<String,File> documents=new ConcurrentHashMap<>();
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
    private volatile List<File> roots;
    private boolean started=false, destroyed=false;
    private PdfDocument pdf; private String pdfTarget; private int pdfCount,pdfIndex;
    private Upload upload,draftUpload;
    private DraftStore drafts;
    private static final class Upload {final long started=System.currentTimeMillis();String token,target,sha,sourceId;boolean replace,backup;String kind="document";int seq,length,width,height;Map<String,String> info;ByteArrayOutputStream out=new ByteArrayOutputStream();}

    /** Window colour behind the WebView; matches the light and dark page backgrounds. */
    private int surface(){return (getResources().getConfiguration().uiMode&Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES?Color.rgb(20,25,34):Color.rgb(245,246,250);}
    private void barAppearance(){
        boolean dark=(getResources().getConfiguration().uiMode&Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES;
        int light=WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        WindowInsetsController c=getWindow().getInsetsController();if(c!=null)c.setSystemBarsAppearance(dark?0:light,light);
        getWindow().setStatusBarColor(surface());getWindow().setNavigationBarColor(surface());
    }
    @Override public void onConfigurationChanged(Configuration config){
        super.onConfigurationChanged(config);
        if(web!=null){web.getSettings().setTextZoom(Math.round(config.fontScale*100));web.setBackgroundColor(surface());}
        if(root!=null)root.setBackgroundColor(surface());
        barAppearance();
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);termux=new TermuxFolders(this);
        try {drafts=new DraftStore(new File(getFilesDir(),"recovery"));}catch(IOException e){drafts=null;}
        try {roots=volumeRoots();store=new FileStore(roots);}catch(IOException e){new AlertDialog.Builder(this).setMessage("저장공간을 확인하지 못했어요.").setPositiveButton("닫기",(d,w)->finish()).show();return;}
        web=new WebView(this);
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
            @Override public void onPageFinished(WebView view,String url){if(url.equals(ORIGIN+"/index.html")){started=true;event("resume",Boolean.TRUE);}}
            @Override public void onReceivedSslError(WebView view,android.webkit.SslErrorHandler handler,android.net.http.SslError error){handler.cancel();}
            @Override public boolean onRenderProcessGone(WebView view,android.webkit.RenderProcessGoneDetail detail){if(root!=null)root.removeView(view);view.destroy();if(view==web)web=null;finish();return true;}
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public void onPermissionRequest(PermissionRequest request){request.deny();}
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){callback.onReceiveValue(null);return true;}
            @Override public void onGeolocationPermissionsShowPrompt(String origin,GeolocationPermissions.Callback callback){callback.invoke(origin,false,false);}
        });
        web.setDownloadListener((url,ua,cd,mime,len)->{});
        web.addJavascriptInterface(new Bridge(),"OfflineNative");
        root=new FrameLayout(this);root.setBackgroundColor(surface());
        root.addView(web,new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,FrameLayout.LayoutParams.MATCH_PARENT));
        // Keep the page outside system bars and above the keyboard, including Android 15 edge-to-edge.
        root.setOnApplyWindowInsetsListener((v,insets)->{android.graphics.Insets x=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());v.setPadding(x.left,x.top,x.right,Math.max(x.bottom,insets.getInsets(WindowInsets.Type.ime()).bottom));return WindowInsets.CONSUMED;});
        getWindow().setDecorFitsSystemWindows(false);
        setContentView(root);barAppearance();
        if(Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,()->onBackPressed());
        web.loadUrl(ORIGIN+"/index.html");
    }
    private List<File> volumeRoots()throws IOException {
        LinkedHashMap<String,File> found=new LinkedHashMap<>();File primary=Environment.getExternalStorageDirectory().getCanonicalFile();found.put(primary.getPath(),primary);
        for(File f:getExternalFilesDirs(null)){if(f==null)continue;String path=f.getCanonicalPath();int at=path.indexOf("/Android/");if(at>0){File root=new File(path.substring(0,at));if(root.isDirectory())found.put(root.getPath(),root);}}
        return new ArrayList<>(found.values());
    }
    private WebResourceResponse blocked(){return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream(new byte[0]));}
    private WebResourceResponse intercept(Uri uri,String method) {
        if(!method.equals("GET")||!"https".equals(uri.getScheme())||!"appassets.androidplatform.net".equals(uri.getHost())||uri.getPort()!=-1||uri.getQuery()!=null)return blocked();
        String path=uri.getPath();if(path==null||path.contains("..")||path.contains("\\")||path.contains("\u0000"))return blocked();
        try {
            InputStream input;String mime;
            if(path.startsWith("/document/")) {byte[] data=blobs.get(path.substring(10));if(data==null)return blocked();input=new ByteArrayInputStream(data);mime="application/octet-stream";}
            else {String n=path.substring(1);if(!n.matches("[A-Za-z0-9_./-]+")||n.isEmpty())return blocked();input=getAssets().open(n);
                mime=n.endsWith(".png")?"image/png":n.endsWith(".html")?"text/html":(n.endsWith(".js")||n.endsWith(".mjs"))?"text/javascript":n.endsWith(".css")?"text/css":n.endsWith(".wasm")?"application/wasm":n.endsWith(".ttf")?"font/ttf":"text/plain";}
            Map<String,String> headers=new HashMap<>();headers.put("Cache-Control","no-store");headers.put("X-Content-Type-Options","nosniff");
            headers.put("Content-Security-Policy","default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
            return new WebResourceResponse(mime,"UTF-8",200,"OK",headers,input);
        } catch(IOException e){return blocked();}
    }
    private void reply(long id,Object data,String error) {
        JSONObject result=new JSONObject();try{result.put("ok",error==null);if(error==null)result.put("data",data==null?JSONObject.NULL:data);else result.put("error",error);}catch(JSONException ignored){}
        runOnUiThread(()->{if(!destroyed&&web!=null)web.evaluateJavascript("window.NativeReply&&window.NativeReply("+id+","+result+")",null);});
    }
    private void event(String name,Object data){runOnUiThread(()->{if(!destroyed&&web!=null)web.evaluateJavascript("window.NativeEvent&&window.NativeEvent("+JSONObject.quote(name)+","+String.valueOf(data)+")",null);});}
    private static JSONObject obj(Object...v)throws JSONException {JSONObject o=new JSONObject();for(int i=0;i<v.length;i+=2)o.put((String)v[i],v[i+1]);return o;}
    public final class Bridge {
        @JavascriptInterface public void postMessage(String message){
            if(message==null)return;
            if(message.length()>400000){java.util.regex.Matcher m=OVERSIZE_ID.matcher(message.substring(0,Math.min(64,message.length())));if(m.find())reply(Long.parseLong(m.group(1)),null,"요청이 너무 커요.");return;}
            try {
                JSONObject m=new JSONObject(message);long id=m.getLong("id");String op=m.getString("op");JSONObject a=m.optJSONObject("args");if(a==null)a=new JSONObject();final JSONObject args=a;
                if(op.equals("cancelScan")){scanStop.set(true);reply(id,true,null);return;}
                if(op.equals("scan")){
                    final AtomicBoolean mine=new AtomicBoolean();scanStop.set(true);scanStop=mine;
                    try{scanner.execute(()->{try{reply(id,scan(mine),null);}catch(OutOfMemoryError e){reply(id,null,"메모리가 부족해 검색을 마치지 못했어요.");}catch(Throwable e){reply(id,null,e.getMessage()==null?"문서를 찾지 못했어요.":e.getMessage());}});}catch(RejectedExecutionException closing){reply(id,null,"앱을 닫는 중이에요.");}
                    return;
                }
                if(op.equals("exit")){runOnUiThread(()->finish());reply(id,true,null);return;}
                if(op.equals("connectFolder")){runOnUiThread(()->{
                    if(folderPickerRequest!=-1){reply(id,null,"폴더 선택을 마쳐 주세요.");return;}
                    try{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION|Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);intent.putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI,android.provider.DocumentsContract.buildDocumentUri(TermuxFolders.AUTHORITY,"/data/data/com.termux/files/home"));folderPickerRequest=id;startActivityForResult(intent,301);}catch(Exception e){folderPickerRequest=-1;reply(id,null,"폴더 선택 화면을 열지 못했어요. Termux 설치를 확인해 주세요.");}
                });return;}
                if(op.equals("permission")){runOnUiThread(()->{try{Intent intent=new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,Uri.parse("package:"+getPackageName()));startActivity(intent);reply(id,true,null);}catch(Exception e){reply(id,null,"설정에서 hwpxxx의 모든 파일 접근을 허용해 주세요.");}});return;}
                io.execute(()->{try {if(!UNGATED.contains(op)&&!Environment.isExternalStorageManager())throw new IOException("문서에 접근하려면 파일 접근을 허용해 주세요.");reply(id,operation(op,args),null);}catch(OutOfMemoryError e){upload=null;draftUpload=null;reply(id,null,"메모리가 부족해 작업을 마치지 못했어요. 원본은 변경하지 않았어요.");}catch(Throwable e){reply(id,null,e.getMessage()==null?"작업을 완료하지 못했어요.":e.getMessage());}});
            }catch(Exception ignored){}
        }
    }
    private JSONObject record(File f)throws Exception {
        String id=FileStore.sha(f.getPath().getBytes(StandardCharsets.UTF_8));documents.put(id,f);
        return obj("id",id,"name",f.getName(),"path",f.getPath(),"folder",f.getParent(),"size",f.length(),"modified",f.lastModified(),"format",FileStore.ext(f));
    }
    private File document(String id)throws IOException {if(termux.find(id)!=null)throw new IOException("연결 폴더 원본은 유지해요. 다른 이름으로 저장해 주세요.");if(!Environment.isExternalStorageManager())throw new IOException("문서에 접근하려면 파일 접근을 허용해 주세요.");File f=documents.get(id);if(f==null)throw new IOException("문서 목록을 새로고침한 뒤 다시 선택해 주세요.");return store.resolve(f.getPath());}
    private Object operation(String op,JSONObject a)throws Exception {
        switch(op){
            case "status": {roots=volumeRoots();store=new FileStore(roots);JSONArray volumes=new JSONArray();for(int i=0;i<roots.size();i++)volumes.put(obj("path",roots.get(i).getPath(),"name",i==0?"내장 저장공간":"SD 카드 · "+roots.get(i).getName()));return obj("permission",Environment.isExternalStorageManager(),"connectedFolders",termux.list(),"volumes",volumes,"version",BuildConfig.VERSION_NAME,"engine","rhwp 0.8.7");}
            case "disconnectFolder":termux.disconnect(a.getString("id"));event("foldersChanged",Boolean.TRUE);return true;
            case "listDirs": {
                File dir=store.resolve(a.getString("path"));if(!dir.isDirectory()||!dir.canRead())throw new IOException("폴더를 열 수 없어요. 접근 권한을 확인해 주세요.");
                File[] children=dir.listFiles();if(children==null)throw new IOException("폴더 목록을 읽지 못했어요.");JSONArray result=new JSONArray();int n=0;
                for(File f:children){if(f.getName().startsWith(".")||!f.isDirectory())continue;try{store.resolve(f.getPath());}catch(IOException e){continue;}if(++n>3000)throw new IOException("하위 폴더가 너무 많아요. 다른 위치를 선택해 주세요.");String[] entries=f.list();result.put(obj("path",f.getPath(),"name",f.getName(),"modified",f.lastModified(),"count",entries==null?JSONObject.NULL:entries.length));}
                return obj("path",dir.getPath(),"writable",dir.canWrite(),"folders",result);
            }
            case "mkdir": {File f=store.createFolder(a.getString("parent"),a.getString("name"));return obj("path",f.getPath());}
            case "read": {
                String id=a.getString("id");TermuxFolders.Ref linked=termux.find(id);byte[] data;JSONObject meta;String format;
                if(linked!=null){data=termux.read(linked);meta=termux.record(linked);format=linked.format;}else{File f=document(id);data=store.read(f.getPath());meta=record(f);format=FileStore.ext(f);}
                FileStore.validate(data,format);
                purgeBlobs();if(blobs.size()>=2)throw new IOException("다른 문서를 처리 중이에요. 잠시 뒤 다시 시도해 주세요.");String token=UUID.randomUUID().toString();putBlob(token,data);return obj("url","/document/"+token,"token",token,"sha",FileStore.sha(data),"meta",meta);
            }
            case "release":{String token=a.getString("token");blobs.remove(token);blobTimes.remove(token);return true;}
            case "delete": {String id=a.getString("id");File f=document(id);if(!f.isFile()||!f.delete())throw new IOException("문서를 삭제하지 못했어요.");documents.remove(id);return true;}
            case "move": {File src=document(a.getString("id"));File dest=store.move(src.getPath(),a.getString("parent"),src.getName());documents.remove(a.getString("id"));return record(dest);}
            case "rename": {File src=document(a.getString("id"));String name=a.getString("name");if(!FileStore.ext(new File(name)).equals(FileStore.ext(src)))throw new IOException("확장자는 변경할 수 없어요.");File dest=store.move(src.getPath(),src.getParent(),name);documents.remove(a.getString("id"));return record(dest);}
            case "beginPdf": {
                if(pdf!=null)throw new IOException("다른 PDF를 만들고 있어요.");
                pdfTarget=store.resolve(a.getString("target")).getPath();if(!pdfTarget.endsWith(".pdf")||new File(pdfTarget).exists())throw new IOException("같은 이름의 파일이 있거나 PDF 이름이 올바르지 않아요.");
                pdfCount=a.getInt("count");if(pdfCount<1||pdfCount>100)throw new IOException("PDF 저장은 100페이지까지 지원해요.");pdfIndex=0;pdf=new PdfDocument();return true;
            }
            case "beginPdfPage": {
                if(pdf==null||upload!=null||a.getInt("index")!=pdfIndex)throw new IOException("PDF 페이지 순서가 올바르지 않아요.");
                Upload u=new Upload();u.kind="pdf";u.token=UUID.randomUUID().toString();u.length=a.getInt("length");u.width=a.getInt("width");u.height=a.getInt("height");
                if(u.length<8||u.length>8*1024*1024||u.width<36||u.height<36||u.width>2000||u.height>2000)throw new IOException("PDF 페이지의 크기가 너무 커요.");upload=u;return u.token;
            }
            case "finishPdfPage": {
                Upload u=requireUpload(a);try {
                    if(pdf==null||!u.kind.equals("pdf")||u.out.size()!=u.length)throw new IOException("PDF 페이지 데이터가 일치하지 않아요.");
                    byte[] data=u.out.toByteArray();BitmapFactory.Options opts=new BitmapFactory.Options();opts.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(data,0,data.length,opts);
                    if(opts.outWidth<1||opts.outHeight<1||(long)opts.outWidth*opts.outHeight>5000000)throw new IOException("PDF 이미지의 크기가 너무 커요.");
                    Bitmap bitmap=BitmapFactory.decodeByteArray(data,0,data.length);if(bitmap==null)throw new IOException("PDF 이미지를 읽지 못했어요.");
                    try{PdfDocument.Page page=pdf.startPage(new PdfDocument.PageInfo.Builder(u.width,u.height,pdfIndex+1).create());page.getCanvas().drawColor(Color.WHITE);page.getCanvas().drawBitmap(bitmap,null,new RectF(0,0,u.width,u.height),new android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG));pdf.finishPage(page);pdfIndex++;}finally{bitmap.recycle();}
                    return true;
                }finally{upload=null;}
            }
            case "finishPdf": {
                if(pdf==null||pdfIndex!=pdfCount)throw new IOException("PDF 페이지가 모두 준비되지 않았어요.");
                File temp=File.createTempFile("offline-pdf-",".pdf",getCacheDir());try{try(FileOutputStream out=new FileOutputStream(temp)){pdf.writeTo(out);out.getFD().sync();}byte[] bytes;try(InputStream in=new FileInputStream(temp)){bytes=FileStore.bounded(in,FileStore.MAX_BYTES);}store.write(pdfTarget,bytes,null,false);return obj("path",pdfTarget);}finally{pdf.close();pdf=null;temp.delete();}
            }
            case "abortPdf":if(pdf!=null){pdf.close();pdf=null;}upload=null;return true;
            case "beginSave": {
                // A session older than two minutes is treated as abandoned rather than blocking every later save.
                if(upload!=null&&System.currentTimeMillis()-upload.started<120000)throw new IOException("저장 중이에요. 잠시 기다려 주세요.");
                Upload u=new Upload();u.token=UUID.randomUUID().toString();u.sourceId=a.getString("id");TermuxFolders.Ref linked=termux.find(u.sourceId);
                File src;if(u.sourceId.startsWith("draft:")){
                    // A recovered edit is only ever saved as a new copy; the original document is never its save target.
                    if(drafts==null||!DraftStore.validKey(u.sourceId.substring(6)))throw new IOException("복구 항목을 찾을 수 없어요.");
                    if(a.optBoolean("replace",false))throw new IOException("복구한 내용은 다른 이름으로 저장해 주세요.");
                    src=new File(drafts.info(u.sourceId.substring(6)).get("name"));
                } else {src=linked==null?document(u.sourceId):new File(linked.name);if(linked!=null&&a.optBoolean("replace",false))throw new IOException("연결 폴더 원본은 유지해요. 다른 이름으로 저장해 주세요.");}u.target=store.resolve(a.getString("target")).getPath();u.replace=a.optBoolean("replace",false);u.backup=u.replace&&a.optBoolean("backup",false);u.sha=a.optString("sha","");u.length=a.getInt("length");
                if(u.length<8||u.length>FileStore.MAX_BYTES)throw new IOException("저장할 문서가 너무 커요.");
                if(!FileStore.ext(new File(u.target)).equals(FileStore.ext(src)))throw new IOException("원래 문서 형식을 유지해 주세요.");
                if(u.replace&&!u.target.equals(src.getPath()))throw new IOException("원본 저장 경로가 일치하지 않아요.");
                if(!u.replace&&new File(u.target).exists())throw new IOException("같은 이름의 파일이 있어요. 이름이나 폴더를 바꿔 주세요.");upload=u;return u.token;
            }
            case "saveChunk": {Upload u=requireAnyUpload(a);if(a.getInt("seq")!=u.seq++)throw new IOException("저장 순서가 올바르지 않아요.");String b=a.getString("base64");if(b.length()>350000)throw new IOException("저장 조각이 너무 커요.");byte[] data=android.util.Base64.decode(b,android.util.Base64.DEFAULT);if(u.out.size()+data.length>u.length)throw new IOException("저장 크기가 일치하지 않아요.");u.out.write(data);return true;}
            case "abortSave":upload=null;return true;
            case "finishSave": {Upload u=requireUpload(a);try{if(!u.kind.equals("document")||u.out.size()!=u.length)throw new IOException("저장 크기가 일치하지 않아요.");byte[] bytes=u.out.toByteArray();
                File backup=null;
                if(u.backup){try{backup=store.backup(u.target,u.sha,new java.text.SimpleDateFormat("yyyyMMdd-HHmmss",Locale.ROOT).format(new Date()));}catch(IOException e){throw new IOException("원본 백업을 만들지 못해 저장을 멈췄어요. 원본은 변경하지 않았어요. "+e.getMessage(),e);}}
                try{File dest=store.write(u.target,bytes,u.sha,u.replace);return obj("meta",record(dest),"sha",FileStore.sha(bytes),"backup",backup==null?JSONObject.NULL:record(backup));}
                catch(IOException e){if(backup!=null)backup.delete();throw e;}
            }finally{upload=null;}}
            case "beginDraft": {
                if(drafts==null)throw new IOException("복구 저장소를 사용할 수 없어요.");
                if(draftUpload!=null&&System.currentTimeMillis()-draftUpload.started<120000)throw new IOException("복구 자료를 저장하고 있어요.");
                Upload u=new Upload();u.kind="draft";u.token=UUID.randomUUID().toString();u.sourceId=a.getString("id");u.length=a.getInt("length");
                if(u.length<8||u.length>FileStore.MAX_BYTES)throw new IOException("복구 자료의 크기가 올바르지 않아요.");
                Map<String,String> info=new LinkedHashMap<>();info.put("name",clip(a.optString("name"),240));info.put("path",clip(a.optString("path"),2000));info.put("folder",clip(a.optString("folder"),2000));info.put("format",a.getString("format"));info.put("encrypted",a.optBoolean("encrypted",false)?"true":"false");info.put("external",a.optBoolean("external",false)?"true":"false");info.put("lossy",a.optBoolean("lossy",false)?"true":"false");info.put("docId",clip(a.optString("docId"),200));
                u.info=info;draftUpload=u;return u.token;
            }
            case "finishDraft": {
                String token=a.getString("token");Upload u=draftUpload;if(u==null||!u.token.equals(token))throw new IOException("복구 저장 세션이 만료되었어요.");
                try{if(!u.kind.equals("draft")||u.out.size()!=u.length)throw new IOException("복구 자료 크기가 일치하지 않아요.");
                    String key=u.sourceId.startsWith("draft:")?u.sourceId.substring(6):DraftStore.key(u.sourceId);drafts.write(key,u.info,u.out.toByteArray());return obj("key",key);
                }finally{draftUpload=null;}
            }
            case "abortDraft":draftUpload=null;return true;
            case "listDrafts": {JSONArray out=new JSONArray();if(drafts!=null)for(Map<String,String> m:drafts.list())out.put(draftJson(m));return out;}
            case "readDraft": {
                if(drafts==null)throw new IOException("복구 저장소를 사용할 수 없어요.");
                String key=draftKey(a);Map<String,String> m=drafts.info(key);byte[] data=drafts.read(key);
                purgeBlobs();if(blobs.size()>=2)throw new IOException("다른 문서를 처리 중이에요. 잠시 뒤 다시 시도해 주세요.");String token=UUID.randomUUID().toString();putBlob(token,data);
                JSONObject meta=obj("id","draft:"+key,"name",m.get("name"),"path",m.get("path"),"folder",m.get("folder"),"size",data.length,"modified",Long.parseLong(m.get("savedAt")),"format",m.get("format"),"external",true,"draft",true,"encrypted","true".equals(m.get("encrypted")));
                return obj("url","/document/"+token,"token",token,"sha",FileStore.sha(data),"meta",meta);
            }
            case "discardDraft": {if(drafts==null)return true;String key=draftKey(a);if(DraftStore.validKey(key))drafts.delete(key);return true;}
            default:throw new IOException("지원하지 않는 작업이에요.");
        }
    }
    private Upload requireUpload(JSONObject a)throws Exception{if(upload==null||!upload.token.equals(a.getString("token")))throw new IOException("저장 세션이 만료되었어요.");return upload;}
    private Upload requireAnyUpload(JSONObject a)throws Exception{String token=a.getString("token");if(draftUpload!=null&&draftUpload.token.equals(token))return draftUpload;return requireUpload(a);}
    private static String clip(String s,int max){return s==null?"":s.length()>max?s.substring(0,max):s;}
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
                boolean dir=f.isDirectory();if(!dir&&!FileStore.ext(f).matches("hwp|hwpx"))continue;
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
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);if(request!=301)return;final long id=folderPickerRequest;folderPickerRequest=-1;
        // id<0: the activity (or the whole process) was recreated while the system picker was open, so the request that asked for it is gone.
        // The user's choice is still valid: connect it anyway and let the page learn about it from the next status.
        if(result!=RESULT_OK||data==null||data.getData()==null){if(id>=0)reply(id,false,null);return;}
        final Uri tree=data.getData();
        try{io.execute(()->{try{termux.connect(tree);if(id>=0)reply(id,true,null);event("foldersChanged",Boolean.TRUE);}catch(Exception e){if(id>=0)reply(id,null,e.getMessage()==null?"폴더를 연결하지 못했어요.":e.getMessage());else event("foldersChanged",Boolean.TRUE);}});}catch(RejectedExecutionException closing){}
    }
    @Override protected void onResume(){super.onResume();if(web!=null)event("resume",Boolean.TRUE);}
    @Override public void onBackPressed(){if(web!=null&&started)web.evaluateJavascript("window.AppBack&&window.AppBack()",null);else super.onBackPressed();}
    @Override protected void onDestroy(){destroyed=true;scanStop.set(true);scanner.shutdownNow();// Release buffers on the I/O thread so an operation in flight never sees them vanish.
        try{io.execute(()->{blobs.clear();blobTimes.clear();upload=null;draftUpload=null;if(pdf!=null){try{pdf.close();}catch(Exception ignored){}pdf=null;}});}catch(RejectedExecutionException ignored){}
        io.shutdown();
        if(web!=null){web.removeJavascriptInterface("OfflineNative");if(root!=null)root.removeView(web);web.destroy();web=null;}super.onDestroy();}
}

