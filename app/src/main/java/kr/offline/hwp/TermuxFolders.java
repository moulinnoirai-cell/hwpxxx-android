package kr.offline.hwp;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

/** Read-only, user-selected Termux trees. All access goes through its DocumentsProvider. */
final class TermuxFolders {
    static final String AUTHORITY="com.termux.documents";
    private final ContentResolver resolver;
    private final SharedPreferences prefs;
    private final Map<String,Ref> refs=new ConcurrentHashMap<>();
    private static final String[] COLUMNS={"document_id","_display_name","mime_type","_size","last_modified"};
    static final class Ref {String tree,name,folder,format,id;Uri uri;long size,modified;}
    static final class Scan {int count,folders,skipped;boolean limited;}
    interface Batch {void send(JSONArray batch);}
    TermuxFolders(Context context){resolver=context.getContentResolver();prefs=context.getSharedPreferences("termux-folders",Context.MODE_PRIVATE);}
    private Set<String> saved(){return new HashSet<>(prefs.getStringSet("trees",Collections.emptySet()));}
    private boolean granted(Uri tree){for(UriPermission p:resolver.getPersistedUriPermissions())if(p.isReadPermission()&&p.getUri().equals(tree))return true;return false;}
    private Uri root(Uri tree){return DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));}
    private String key(String tree)throws IOException{return FileStore.sha(tree.getBytes(StandardCharsets.UTF_8));}
    synchronized void connect(Uri tree)throws Exception {
        if(tree==null||!"content".equals(tree.getScheme())||!AUTHORITY.equals(tree.getAuthority())||!DocumentsContract.isTreeUri(tree))throw new IOException("Termux의 프로젝트 폴더를 선택해 주세요. 일반 저장공간은 자동으로 검색해요.");
        Set<String> trees=saved();if(trees.size()>=8&&!trees.contains(tree.toString()))throw new IOException("폴더는 8개까지 연결할 수 있어요. 사용하지 않는 연결을 해제해 주세요.");
        resolver.takePersistableUriPermission(tree,Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try(Cursor c=resolver.query(root(tree),COLUMNS,null,null,null)){
            if(c==null||!c.moveToFirst()||!DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(2)))throw new IOException("선택한 폴더를 열 수 없어요.");
            trees.add(tree.toString());prefs.edit().putStringSet("trees",trees).putString("name:"+key(tree.toString()),"Termux · "+c.getString(1)).commit();
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
        JSONArray out=new JSONArray();for(String raw:new TreeSet<>(saved())){Uri tree=Uri.parse(raw);boolean active=granted(tree);
            if(active)try(Cursor c=resolver.query(root(tree),new String[]{"document_id"},null,null,null)){active=c!=null&&c.moveToFirst();}catch(Exception e){active=false;}
            out.put(new JSONObject().put("id",key(raw)).put("name",prefs.getString("name:"+key(raw),"Termux 폴더")).put("active",active));
        }return out;
    }
    Ref find(String id){return refs.get(id);}
    JSONObject record(Ref r)throws Exception {
        return new JSONObject().put("id",r.id).put("name",r.name).put("path",r.uri.toString()).put("folder",r.folder).put("size",r.size).put("modified",r.modified).put("format",r.format).put("external",true);
    }
    byte[] read(Ref r)throws Exception {
        Uri tree=Uri.parse(r.tree);if(!saved().contains(r.tree)||!granted(tree))throw new IOException("Termux 폴더 연결이 해제됐어요. 설정에서 다시 연결해 주세요.");
        try(InputStream in=resolver.openInputStream(r.uri)){
            if(in==null)throw new IOException("Termux 문서를 열지 못했어요.");byte[] bytes=FileStore.bounded(in,FileStore.MAX_BYTES);if(bytes.length==0)throw new IOException("빈 파일이거나 32MB를 넘는 문서예요.");return bytes;
        }catch(SecurityException e){throw new IOException("Termux 폴더 접근이 해제됐어요. 설정에서 다시 연결해 주세요.",e);}
    }
    private static final class Dir {String id,path;int depth;Dir(String id,String path,int depth){this.id=id;this.path=path;this.depth=depth;}}
    Scan scan(AtomicBoolean stop,int available,Batch publish)throws Exception {
        Scan result=new Scan();refs.clear();Set<String> seenDocuments=new HashSet<>();JSONArray batch=new JSONArray();int entries=0;
        for(String raw:new TreeSet<>(saved())){
            if(stop.get()||result.limited)break;Uri tree=Uri.parse(raw);if(!granted(tree)){result.skipped++;continue;}
            String label=prefs.getString("name:"+key(raw),"Termux 폴더");ArrayDeque<Dir> pending=new ArrayDeque<>();Set<String> seen=new HashSet<>();pending.add(new Dir(DocumentsContract.getTreeDocumentId(tree),label,0));
            while(!pending.isEmpty()&&!stop.get()&&!result.limited){
                Dir dir=pending.removeFirst();if(!seen.add(dir.id))continue;if(++result.folders>50000){result.limited=true;break;}
                Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,dir.id);
                try(Cursor c=resolver.query(children,COLUMNS,null,null,null)){
                    if(c==null){result.skipped++;continue;}
                    while(c.moveToNext()&&!stop.get()){
                        if(++entries>150000){result.limited=true;break;}
                        String docId=c.getString(0),name=c.getString(1),mime=c.getString(2);if(docId==null||name==null)continue;
                        if(DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)){
                            if(!name.equals(".git")&&dir.depth>=64){result.limited=true;break;}if(!name.equals(".git")){if(pending.size()>=50000){result.limited=true;break;}pending.addLast(new Dir(docId,dir.path+"/"+name,dir.depth+1));}continue;
                        }
                        String format=FileStore.ext(new File(name));if((!format.equals("hwp")&&!format.equals("hwpx"))||!seenDocuments.add(docId))continue;
                        if(result.count>=available){result.limited=true;break;}
                        Ref r=new Ref();r.tree=raw;r.id=key("termux:"+docId);r.uri=DocumentsContract.buildDocumentUriUsingTree(tree,docId);r.name=name;r.folder=dir.path;r.format=format;r.size=c.isNull(3)?0:c.getLong(3);r.modified=c.isNull(4)?0:c.getLong(4);refs.put(r.id,r);result.count++;batch.put(record(r));
                        if(batch.length()>=24){publish.send(batch);batch=new JSONArray();}
                    }
                }catch(Exception e){result.skipped++;}
            }
        }
        if(batch.length()>0)publish.send(batch);return result;
    }
}
