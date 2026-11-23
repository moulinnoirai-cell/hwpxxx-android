package kr.offline.hwp;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/**
 * App-private recovery drafts: the last exported state of an edit that was not saved yet.
 * A draft is never the user's document and never replaces one; recovery always opens it as a
 * separate copy that must be saved under a new name. No Android dependency (JVM tested).
 * Bytes are written first and the metadata file last, so a draft without metadata is ignored.
 */
final class DraftStore {
    static final int MAX_DRAFTS=8;
    static final long MAX_TOTAL=128L*1024*1024,MAX_AGE_MS=30L*24*60*60*1000;
    interface Budget {
        Object lock();
        void admit(File directory,String key,long documentBytes,long metadataBytes)throws IOException;
    }
    private final File dir;
    private final Budget budget;
    DraftStore(File dir)throws IOException{this(dir,null);}
    DraftStore(File dir,Budget budget)throws IOException{this.dir=dir.getCanonicalFile();this.budget=budget;if(!this.dir.isDirectory()&&!this.dir.mkdirs())throw new IOException("복구 폴더를 만들 수 없어요.");}
    static String key(String documentId)throws IOException{return FileStore.sha(documentId.getBytes(StandardCharsets.UTF_8)).substring(0,32);}
    static boolean validKey(String key){return key!=null&&key.matches("[0-9a-f]{32}");}
    private File bytes(String key){return new File(dir,key+".draft");}
    private File meta(String key){return new File(dir,key+".meta");}
    private static void need(String key)throws IOException{if(!validKey(key))throw new IOException("복구 항목을 찾을 수 없어요.");}

    /** Atomically stores a draft; older drafts are evicted so the count and total size stay bounded. */
    synchronized void write(String key,Map<String,String> info,byte[] data)throws IOException {
        if(budget==null){writeLocked(key,info,data);return;}
        // Only app-private draft commits share this lock. Never serializes SAF or document reads.
        synchronized(budget.lock()){writeLocked(key,info,data);}
    }
    private void writeLocked(String key,Map<String,String> info,byte[] data)throws IOException {
        need(key);String format=info.get("format");if(format==null)throw new IOException("형식을 알 수 없어요.");
        data=FileStore.storable(data,format);FileStore.validate(data,format);
        long free=dir.getUsableSpace();if(free<data.length+4L*1024*1024)throw new IOException("복구 자료를 저장할 공간이 부족해요.");
        Properties p=new Properties();p.putAll(info);p.setProperty("size",String.valueOf(data.length));p.setProperty("sha",FileStore.sha(data));p.setProperty("savedAt",String.valueOf(System.currentTimeMillis()));
        ByteArrayOutputStream metadata=new ByteArrayOutputStream();
        try(Writer w=new OutputStreamWriter(metadata,StandardCharsets.UTF_8)){p.store(w,null);}
        byte[] metadataBytes=metadata.toByteArray();
        if(budget!=null)budget.admit(dir,key,data.length,metadataBytes.length);
        File tempBytes=File.createTempFile(".draft-",".tmp",dir),tempMeta=File.createTempFile(".draft-",".tmp",dir);
        try {
            try(FileOutputStream out=new FileOutputStream(tempBytes)){out.write(data);out.getFD().sync();}
            try(FileOutputStream out=new FileOutputStream(tempMeta)){out.write(metadataBytes);out.getFD().sync();}
            Files.move(tempBytes.toPath(),bytes(key).toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
            Files.move(tempMeta.toPath(),meta(key).toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        } finally {tempBytes.delete();tempMeta.delete();}
        trim(key);
    }
    private void trim(String keep)throws IOException {
        List<Map<String,String>> all=list();
        // Newest first; drop anything over the count or size budget except the draft just written.
        long total=0;int n=0;
        for(Map<String,String> m:all){
            long size=Long.parseLong(m.getOrDefault("size","0"));n++;total+=size;
            if(!m.get("key").equals(keep)&&(n>MAX_DRAFTS||total>MAX_TOTAL))delete(m.get("key"));
        }
    }
    /** Valid drafts, newest first. Expired, half-written or orphaned files are removed. */
    synchronized List<Map<String,String>> list()throws IOException {
        List<Map<String,String>> out=new ArrayList<>();File[] files=dir.listFiles();if(files==null)return out;
        long now=System.currentTimeMillis();
        for(File f:files) {
            String n=f.getName();
            if(n.startsWith(".draft-")){if(now-f.lastModified()>60_000)f.delete();continue;}
            String key=n.indexOf('.')>0?n.substring(0,n.indexOf('.')):"";
            if(!validKey(key)){continue;}
            if(n.endsWith(".draft")&&!meta(key).isFile()&&now-f.lastModified()>60_000){f.delete();continue;}
            if(!n.endsWith(".meta"))continue;
            Map<String,String> info=load(key);
            if(info==null||!bytes(key).isFile()||bytes(key).length()!=Long.parseLong(info.getOrDefault("size","-1"))||now-Long.parseLong(info.getOrDefault("savedAt","0"))>MAX_AGE_MS){delete(key);continue;}
            out.add(info);
        }
        Collections.sort(out,(a,b)->Long.compare(Long.parseLong(b.get("savedAt")),Long.parseLong(a.get("savedAt"))));return out;
    }
    private Map<String,String> load(String key) {
        try(Reader r=new InputStreamReader(new FileInputStream(meta(key)),StandardCharsets.UTF_8)){
            Properties p=new Properties();p.load(r);Map<String,String> m=new LinkedHashMap<>();for(String k:p.stringPropertyNames())m.put(k,p.getProperty(k));m.put("key",key);
            Long.parseLong(m.getOrDefault("size","x"));Long.parseLong(m.getOrDefault("savedAt","x"));
            String f=m.get("format");if(!"hwp".equals(f)&&!"hwpx".equals(f))return null;return m;
        }catch(IOException|RuntimeException e){return null;}
    }
    synchronized Map<String,String> info(String key)throws IOException{need(key);Map<String,String> m=load(key);if(m==null||!bytes(key).isFile())throw new IOException("복구 항목을 찾을 수 없어요.");return m;}
    synchronized byte[] read(String key)throws IOException {
        Map<String,String> m=info(key);
        try(InputStream in=new FileInputStream(bytes(key))){byte[] data=FileStore.bounded(in,FileStore.MAX_BYTES);
            if(!FileStore.sha(data).equals(m.get("sha")))throw new IOException("복구 자료가 손상되었어요.");FileStore.validate(data,m.get("format"));return data;}
    }
    synchronized void delete(String key)throws IOException{need(key);bytes(key).delete();meta(key).delete();}
}
