package kr.offline.hwp;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.provider.DocumentsContract;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;

/** Read-only, user-selected Termux trees. All access goes through its DocumentsProvider. */
final class TermuxFolders {
    static final String AUTHORITY="com.termux.documents";
    /** A provider that stops answering must not hold the I/O thread (and every later save/abort) forever. */
    static final long QUERY_TIMEOUT_MS=20000,STATUS_TIMEOUT_MS=6000,STATUS_BUDGET_MS=15000,READ_TIMEOUT_MS=45000;
    private final ContentResolver resolver;
    private final SharedPreferences prefs;
    private final Map<String,Ref> refs=new ConcurrentHashMap<>();
    private static final String[] COLUMNS={"document_id","_display_name","mime_type","_size","last_modified"};
    static final class Ref {String tree,name,folder,format,id;Uri uri;long size,modified;}
    static final class Scan {int count,folders,skipped;boolean limited;}
    interface Batch {void send(JSONArray batch);}
    private interface CursorReader<T> {T read(Cursor c)throws Exception;}
    TermuxFolders(Context context){resolver=context.getContentResolver();prefs=context.getSharedPreferences("termux-folders",Context.MODE_PRIVATE);}
    private Set<String> saved(){return new HashSet<>(prefs.getStringSet("trees",Collections.emptySet()));}
    private boolean granted(Uri tree){for(UriPermission p:resolver.getPersistedUriPermissions())if(p.isReadPermission()&&p.getUri().equals(tree))return true;return false;}
    private Uri root(Uri tree){return DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));}
    private String key(String tree)throws IOException{return FileStore.sha(tree.getBytes(StandardCharsets.UTF_8));}

    /** One provider query with a deadline, cooperative cancellation and an abandonable Binder call. */
    private <T> T query(Uri uri,String[] columns,AtomicBoolean stop,long timeoutMs,CursorReader<T> reader)throws Exception {
        final CancellationSignal signal=new CancellationSignal();
        try {
            return TimedCall.call(()->{try(Cursor c=resolver.query(uri,columns,null,null,null,signal)){return c==null?null:reader.read(c);}},stop,timeoutMs,signal::cancel,null);
        } catch(android.os.OperationCanceledException e){throw new TimedCall.Cancelled("작업을 취소했어요.");}
    }

    synchronized void connect(Uri tree)throws Exception {
        if(tree==null||!"content".equals(tree.getScheme())||!AUTHORITY.equals(tree.getAuthority())||!DocumentsContract.isTreeUri(tree))throw new IOException("Termux의 프로젝트 폴더를 선택해 주세요. 일반 저장공간은 자동으로 검색해요.");
        Set<String> trees=saved();boolean known=trees.contains(tree.toString());
        if(trees.size()>=8&&!known)throw new IOException("폴더는 8개까지 연결할 수 있어요. 사용하지 않는 연결을 해제해 주세요.");
        try{resolver.takePersistableUriPermission(tree,Intent.FLAG_GRANT_READ_URI_PERMISSION);}
        catch(SecurityException e){throw new IOException("선택한 폴더의 읽기 권한을 유지하지 못했어요. 다시 선택해 주세요.",e);}
        boolean saved=known;
        try {
            final String[] name=new String[1];
            boolean isDirectory=Boolean.TRUE.equals(query(root(tree),COLUMNS,null,STATUS_TIMEOUT_MS,c->{if(!c.moveToFirst())return false;name[0]=c.getString(1);return DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2));}));
            if(!isDirectory)throw new IOException("선택한 폴더를 열 수 없어요.");
            trees.add(tree.toString());prefs.edit().putStringSet("trees",trees).putString("name:"+key(tree.toString()),"Termux · "+name[0]).commit();saved=true;
        } catch(TimedCall.Timeout e){throw new IOException("Termux가 응답하지 않아 폴더를 연결하지 못했어요. Termux를 한 번 연 뒤 다시 시도해 주세요.",e);
        } finally {
            // A failed connection must not leave a persisted grant behind that the app does not list and cannot release.
            if(!saved)try{resolver.releasePersistableUriPermission(tree,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(RuntimeException ignored){}
        }
    }
    synchronized void disconnect(String id)throws Exception {
        Set<String> trees=saved();for(String raw:new HashSet<>(trees))if(key(raw).equals(id)){
            trees.remove(raw);prefs.edit().putStringSet("trees",trees).remove("name:"+id).commit();
            try{resolver.releasePersistableUriPermission(Uri.parse(raw),Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(SecurityException ignored){}
            refs.values().removeIf(r->r.tree.equals(raw));return;
        }
        throw new IOException("이미 해제된 폴더예요.");
    }
    JSONArray list()throws Exception {
        JSONArray out=new JSONArray();final long end=System.nanoTime()+STATUS_BUDGET_MS*1_000_000L;
        for(String raw:new TreeSet<>(saved())){Uri tree=Uri.parse(raw);boolean active=granted(tree);
            // A provider that is not running or not answering marks the link as needing attention instead of blocking the library.
            // All trees share one budget so eight unresponsive links cannot exceed the bridge's own request timeout.
            final long left=(end-System.nanoTime())/1_000_000L;
            if(active)try{active=left>500&&Boolean.TRUE.equals(query(root(tree),new String[]{"document_id"},null,Math.min(STATUS_TIMEOUT_MS,left),Cursor::moveToFirst));}catch(Exception e){active=false;}
            out.put(new JSONObject().put("id",key(raw)).put("name",prefs.getString("name:"+key(raw),"Termux 폴더")).put("active",active));
        }return out;
    }
    Ref find(String id){return refs.get(id);}
    JSONObject record(Ref r)throws Exception {
        return new JSONObject().put("id",r.id).put("name",r.name).put("path",r.uri.toString()).put("folder",r.folder).put("size",r.size).put("modified",r.modified).put("format",r.format).put("external",true);
    }
    byte[] read(Ref r)throws Exception {
        Uri tree=Uri.parse(r.tree);if(!saved().contains(r.tree)||!granted(tree))throw new IOException("Termux 폴더 연결이 해제됐어요. 설정에서 다시 연결해 주세요.");
        if(r.size>FileStore.MAX_BYTES)throw new IOException("빈 파일이거나 32MB를 넘는 문서예요.");
        final AtomicReference<InputStream> opened=new AtomicReference<>();
        try {
            return TimedCall.call(()->{
                InputStream in=resolver.openInputStream(r.uri);opened.set(in);
                if(in==null)throw new IOException("Termux 문서를 열지 못했어요.");
                try(InputStream stream=in){byte[] bytes=FileStore.bounded(stream,FileStore.MAX_BYTES);if(bytes.length==0)throw new IOException("빈 파일이거나 32MB를 넘는 문서예요.");return bytes;}
            },null,READ_TIMEOUT_MS,()->{try{InputStream in=opened.get();if(in!=null)in.close();}catch(IOException ignored){}},null);
        }
        catch(SecurityException e){throw new IOException("Termux 폴더 접근이 해제됐어요. 설정에서 다시 연결해 주세요.",e);}
        catch(FileNotFoundException e){refs.remove(r.id);throw new IOException("Termux 문서를 찾을 수 없어요. 삭제되었거나 이름이 바뀌었을 수 있어요. 문서함을 새로고침해 주세요.",e);}
        catch(TimedCall.Timeout e){throw new IOException("Termux가 응답하지 않아 문서를 열지 못했어요. Termux를 연 뒤 다시 시도해 주세요. 원본은 변경하지 않았어요.",e);}
    }

    /** Pages through one provider directory; the cursor is read and closed inside the timed call. */
    private final class ProviderSource implements TermuxWalker.Source {
        final Uri tree;final AtomicBoolean stop;
        ProviderSource(Uri tree,AtomicBoolean stop){this.tree=tree;this.stop=stop;}
        @Override public List<TermuxWalker.Entry> list(String directoryId,int max)throws Exception {return list(directoryId,max,QUERY_TIMEOUT_MS);}
        /** The query never outlives the pass's wall clock: its timeout is the smaller of the usual one and what is left. */
        @Override public List<TermuxWalker.Entry> list(String directoryId,int max,long budgetMs)throws Exception {
            return query(DocumentsContract.buildChildDocumentsUriUsingTree(tree,directoryId),COLUMNS,stop,Math.max(1L,Math.min(QUERY_TIMEOUT_MS,budgetMs)),c->{
                List<TermuxWalker.Entry> out=new ArrayList<>();
                while(out.size()<max&&c.moveToNext()&&!stop.get())
                    out.add(new TermuxWalker.Entry(c.getString(0),c.getString(1),DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2)),c.isNull(3)?0:c.getLong(3),c.isNull(4)?0:c.getLong(4)));
                return out;
            });
        }
    }

    /** Termux's home contains ~/storage (termux-setup-storage): symlinks to shared storage that would list every shared document a second time. */
    static final String HOME_ID="/data/data/com.termux/files/home";
    static final Set<String> HOME_SKIP=Collections.singleton("storage");
    static final long SCAN_TIME_BUDGET_MS=150000;

    /**
     * @param available document budget for all linked folders together; each folder is given a fair share of what is left,
     *                  so a large first folder cannot leave the next ones empty
     */
    Scan scan(AtomicBoolean stop,int available,Batch publish,TermuxWalker.Progress progress)throws Exception {
        Scan result=new Scan();final TermuxWalker walker=new TermuxWalker(available,stop,SCAN_TIME_BUDGET_MS);walker.progress=progress;
        final JSONArray[] batch={new JSONArray()};final Set<String> fresh=new HashSet<>();
        List<TermuxWalker.Root> roots=new ArrayList<>();
        for(String raw:new TreeSet<>(saved())){
            final Uri tree=Uri.parse(raw);final String label=prefs.getString("name:"+key(raw),"Termux 폴더");final String rootId=DocumentsContract.getTreeDocumentId(tree);
            roots.add(new TermuxWalker.Root(rootId,label,new ProviderSource(tree,stop),(e,folder,format)->{
                Ref r=new Ref();r.tree=raw;r.id=key("termux:"+e.id);r.uri=DocumentsContract.buildDocumentUriUsingTree(tree,e.id);r.name=e.name;r.folder=folder;r.format=format;r.size=e.size;r.modified=e.modified;
                refs.put(r.id,r);fresh.add(r.id);batch[0].put(record(r));
                if(batch[0].length()>=24){publish.send(batch[0]);batch[0]=new JSONArray();}
            },HOME_ID.equals(rootId)?HOME_SKIP:Collections.<String>emptySet(),granted(tree)));
        }
        // The shared loop gives every tree a fair share of what is left and stops only on a global stop (cancel, time budget).
        walker.walkAll(roots);
        if(batch[0].length()>0)publish.send(batch[0]);
        // Drop references to vanished documents only after a complete pass; a cancelled, limited or partly skipped scan must keep
        // every document the library already shows openable.
        if(walker.complete())refs.keySet().retainAll(fresh);
        result.count=walker.count;result.folders=walker.folders;result.skipped=walker.skipped;result.limited=walker.limited;return result;
    }
}
