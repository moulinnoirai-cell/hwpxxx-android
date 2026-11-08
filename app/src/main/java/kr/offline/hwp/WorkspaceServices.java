package kr.offline.hwp;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.io.File;
import java.io.InputStream;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.io.FileOutputStream;
import java.nio.channels.FileChannel;
import java.nio.file.StandardOpenOption;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.StandardCopyOption;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.ArrayList;
import java.util.Properties;
import java.util.HashSet;
import java.util.Set;
import java.util.Map;
import java.util.UUID;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/** Durable repositories shared by the workspace. No Activity, WebView or document handle is retained. */
final class WorkspaceServices {
    static final long MAX_RECOVERY_BYTES=512L*1024*1024;
    static final String LEGACY_OWNER_FILE="legacy-recovery-owner";
    private static final Map<String,Object> MIGRATION_LOCKS=new HashMap<>();
    private static final Object KEY_LOCK=new Object();
    private static final Map<String,WorkspaceServices> SHARED=new HashMap<>();
    private static final String KEY_ALIAS="kr.offline.hwp.private-state.v1";
    interface StateKeyProvider { SecretKey get() throws Exception; }
    interface LegacyOwnerMover { void move(File source,File destination)throws IOException; }
    private final File filesDir;
    private final FileStore files;
    private final FontStore fonts;
    private final StateKeyProvider keys;
    private final RecoveryBudget recoveryBudget;
    private final LegacyOwnerMover legacyOwnerMover;
    private final Object stateLock=new Object(),draftLock=new Object();
    private final Object migrationLock;
    private final Map<String,DraftStore> drafts=new HashMap<>();
    private PrivateStateStore privateState;
    private DraftStore legacyDrafts;

    /** Recreated Activities reuse the same repository locks while old session IO finishes. */
    static WorkspaceServices acquire(Context context,List<File> roots)throws IOException {
        return acquire(context.getApplicationContext().getFilesDir(),roots,WorkspaceServices::androidKey);
    }
    static synchronized WorkspaceServices acquire(File filesDir,List<File> roots,StateKeyProvider keys)throws IOException {
        String path=filesDir.getCanonicalPath();WorkspaceServices services=SHARED.get(path);
        if(services==null){services=new WorkspaceServices(filesDir,roots,keys);SHARED.put(path,services);}
        else services.refreshRoots(roots);
        return services;
    }
    WorkspaceServices(Context context,List<File> roots)throws IOException {
        this(context.getApplicationContext().getFilesDir(),roots,WorkspaceServices::androidKey);
    }
    /** Tests supply a regular AES key; production always uses AndroidKeystore. */
    WorkspaceServices(File filesDir,List<File> roots,StateKeyProvider keys)throws IOException {
        this(filesDir,roots,keys,MAX_RECOVERY_BYTES);
    }
    WorkspaceServices(File filesDir,List<File> roots,StateKeyProvider keys,long recoveryLimit)throws IOException {
        this(filesDir,roots,keys,recoveryLimit,(source,destination)->Files.move(source.toPath(),destination.toPath(),StandardCopyOption.ATOMIC_MOVE));
    }
    /** Marker-commit failure injection; production requires atomic publication without fallback. */
    WorkspaceServices(File filesDir,List<File> roots,StateKeyProvider keys,long recoveryLimit,LegacyOwnerMover legacyOwnerMover)throws IOException {
        this.filesDir=filesDir.getCanonicalFile();this.keys=keys;files=new FileStore(roots);this.legacyOwnerMover=legacyOwnerMover;
        synchronized(MIGRATION_LOCKS){migrationLock=MIGRATION_LOCKS.computeIfAbsent(this.filesDir.getPath(),unused->new Object());}
        recoveryBudget=new RecoveryBudget(this.filesDir,recoveryLimit);
        FontStore initialized;
        try{initialized=new FontStore(new File(this.filesDir,"fonts"));}catch(IOException unavailable){initialized=null;}
        fonts=initialized;
    }
    FileStore files(){return files;}
    FontStore fonts(){return fonts;}
    void refreshRoots(List<File> roots)throws IOException {files.refreshRoots(roots);}

    PrivateStateStore state()throws IOException {
        synchronized(stateLock){
        if(privateState!=null)return privateState;
        try{
            SecretKey key=keys.get();if(key==null)throw new IOException("비공개 저장 키를 찾지 못했어요.");
            PrivateStateStore store=new PrivateStateStore(new File(filesDir,"state"),key);
            store.configure("history",HostState.MAX_HISTORY,FileStore.MAX_BYTES+HostState.MAX_META,(long)HostState.MAX_HISTORY*(FileStore.MAX_BYTES+HostState.MAX_META));
            store.configure("recent",HostState.MAX_RECENT,32*1024,4L*1024*1024);
            privateState=store;return store;
        }catch(IOException error){throw error;}
        catch(Exception error){throw new IOException("기록을 저장하지 못했어요. 문서는 그대로예요.",error);}
        }
    }
    private static SecretKey androidKey()throws Exception {
        synchronized(KEY_LOCK){
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(!store.containsAlias(KEY_ALIAS)){
            KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).setRandomizedEncryptionRequired(true).build());
            generator.generateKey();
        }
        return (SecretKey)store.getKey(KEY_ALIAS,null);
        }
    }
    private static void requireTabId(String id)throws IOException {
        try{if(id==null||!UUID.fromString(id).toString().equals(id))throw new IllegalArgumentException();}
        catch(IllegalArgumentException invalid){throw new IOException("문서 탭 ID가 올바르지 않아요.",invalid);}
    }
    DraftStore draftStoreFor(String tabId)throws IOException {
        requireTabId(tabId);
        synchronized(draftLock){
        DraftStore store=drafts.get(tabId);
        if(store==null){store=new DraftStore(new File(new File(filesDir,"recovery-tabs"),tabId),recoveryBudget);drafts.put(tabId,store);}
        return store;
        }
    }
    /** Discover recovery owners without parsing records or triggering DraftStore cleanup. */
    List<String> recoverableTabIds()throws IOException {
        List<String> owners=new ArrayList<>();
        try{
            String legacyOwner=readLegacyOwner();
            if(legacyOwner!=null&&hasRecoveryPair(new File(filesDir,"recovery")))owners.add(legacyOwner);
        }catch(IOException unavailableLegacy){
            // Migration reports and preserves damaged legacy state; independent UUID owners still need discovery.
        }
        File root=new File(filesDir,"recovery-tabs");
        if(!root.exists())return Collections.unmodifiableList(owners);
        if(!root.isDirectory()||!root.getCanonicalFile().equals(root))throw new IOException("복구 폴더 경로를 사용할 수 없어요.");
        File[] directories=root.listFiles();if(directories==null)throw new IOException("복구 폴더를 읽지 못했어요.");
        for(File directory:directories){
            if(!directory.isDirectory()||!directory.getCanonicalFile().equals(directory))continue;
            String id=directory.getName();try{requireTabId(id);}catch(IOException invalid){continue;}
            if(!owners.contains(id)&&hasRecoveryPair(directory))owners.add(id);
        }
        Collections.sort(owners);return Collections.unmodifiableList(owners);
    }
    private static boolean hasRecoveryPair(File directory)throws IOException {
        if(!directory.exists())return false;
        if(!directory.isDirectory()||!directory.getCanonicalFile().equals(directory))throw new IOException("복구 폴더 경로를 사용할 수 없어요.");
        File[] entries=directory.listFiles();if(entries==null)throw new IOException("복구 폴더를 읽지 못했어요.");
        for(File metadata:entries){
            String name=metadata.getName();
            if(!name.matches("[0-9a-f]{32}\\.meta")||!metadata.isFile()||!metadata.getCanonicalFile().equals(metadata))continue;
            File data=new File(directory,name.substring(0,32)+".draft");
            if(data.isFile()&&data.getCanonicalFile().equals(data))return true;
        }
        return false;
    }
    private IOException ownerFailure(Exception cause){return new IOException("이전 복구 자료의 탭 소유 정보를 확인하지 못했어요. 기존 복구 자료는 보존했어요.",cause);}
    /** Strict opaque marker read; a damaged marker must never select a different owner. */
    private String readLegacyOwner()throws IOException {
        File marker=new File(filesDir,LEGACY_OWNER_FILE);
        if(!Files.exists(marker.toPath(),LinkOption.NOFOLLOW_LINKS))return null;
        try{
            if(!marker.isFile()||!marker.getCanonicalFile().equals(marker))throw new IOException("invalid recovery owner marker");
            byte[] bytes;try(InputStream input=new FileInputStream(marker)){bytes=FileStore.bounded(input,36);}
            if(bytes.length!=36)throw new IOException("invalid recovery owner marker");
            String id=new String(bytes,StandardCharsets.US_ASCII);requireTabId(id);return id;
        }catch(IOException unreadable){throw ownerFailure(unreadable);}
    }
    /** Called only by the background migration under a per-root process migration lock. */
    private String claimLegacyOwner(String proposed)throws IOException {
        String committed=readLegacyOwner();
        if(committed!=null){syncDirectory(filesDir);return committed;}
        File marker=new File(filesDir,LEGACY_OWNER_FILE),temporary=File.createTempFile(".legacy-owner-",".tmp",filesDir);
        try{
            try(FileOutputStream output=new FileOutputStream(temporary)){output.write(proposed.getBytes(StandardCharsets.US_ASCII));output.getFD().sync();}
            legacyOwnerMover.move(temporary,marker);
            syncDirectory(filesDir);
            if(!proposed.equals(readLegacyOwner()))throw new IOException("recovery owner commit mismatch");
            return proposed;
        }catch(IOException failure){throw ownerFailure(failure);}
        finally{temporary.delete();}
    }
    /** Existing single-document harness retains its original private recovery location. */
    DraftStore legacyDraftStore()throws IOException {
        synchronized(draftLock){
        if(legacyDrafts==null)legacyDrafts=new DraftStore(new File(filesDir,"recovery"),recoveryBudget);
        return legacyDrafts;
        }
    }

    /** Copy committed, readable legacy records before deleting each original pair; failed/unknown files stay. */
    void migrateLegacyDraftsTo(String tabId)throws IOException {
        requireTabId(tabId);
        synchronized(migrationLock){
        File legacyDir=new File(filesDir,"recovery");
        // Validate/commit ownership before any maintenance or copy can alter legacy records.
        String legacyOwner=readLegacyOwner();
        if(legacyDir.isDirectory())legacyOwner=claimLegacyOwner(tabId);
        recoveryBudget.maintainOnce();
        if(!legacyDir.isDirectory()||legacyOwner==null)return;
        DraftStore target=draftStoreFor(legacyOwner),legacy=legacyDraftStore();
        File targetDir=new File(new File(filesDir,"recovery-tabs"),legacyOwner);
        File[] entries=legacyDir.listFiles();if(entries==null)throw new IOException("복구 폴더를 읽지 못했어요.");
        IOException failed=null;
        // Do not use legacy.list(): its orphan/expiry cleanup would delete records before a verified copy.
        for(File entry:entries){
            String name=entry.getName();if(!entry.isFile()||!name.matches("[0-9a-f]{32}\\.meta"))continue;
            String key=name.substring(0,32);
            try{
                Map<String,String> info=legacy.info(key);byte[] bytes=legacy.read(key);
                File targetMeta=new File(targetDir,key+".meta");
                if(targetMeta.exists()){
                    if(!Arrays.equals(bytes,target.read(key)))throw new IOException("기존 복구 자료를 보존했어요.");
                }else{
                    long total=bytes.length;List<Map<String,String>> current=target.list();
                    for(Map<String,String> record:current)total+=Long.parseLong(record.get("size"));
                    if(current.size()>=DraftStore.MAX_DRAFTS||total>DraftStore.MAX_TOTAL)throw new IOException("복구 자료 한도에 도달했어요. 기존 자료를 보존했어요.");
                    target.write(key,info,bytes);
                    // DraftStore syncs document bytes; sync metadata as well before removing the legacy source.
                    try(RandomAccessFile metadata=new RandomAccessFile(targetMeta,"rw")){metadata.getFD().sync();}
                }
                if(!Arrays.equals(bytes,target.read(key)))throw new IOException("복사한 복구 자료를 확인하지 못했어요.");
                syncDirectory(targetDir);
                legacy.delete(key);
            }catch(IOException error){if(failed==null)failed=error;}
        }
        if(failed!=null)throw failed;
        }
    }

    /** Admission is shared across all recovery namespaces; no other tab is evicted to make room. */
    private static final class RecoveryBudget implements DraftStore.Budget {
        private static final Map<String,Object> LOCKS=new HashMap<>();
        private static final Set<String> MAINTAINED=new HashSet<>();
        private final File root;
        private final Object lock;
        private final long limit;
        RecoveryBudget(File root,long limit)throws IOException {
            if(limit<1)throw new IllegalArgumentException("recovery budget must be positive");
            this.root=root;this.limit=limit;
            synchronized(LOCKS){lock=LOCKS.computeIfAbsent(root.getPath(),unused->new Object());}
        }
        void maintainOnce()throws IOException {
            synchronized(lock){
                boolean first;
                synchronized(LOCKS){first=MAINTAINED.add(root.getPath());}
                if(first)pruneExpired();
            }
        }
        public Object lock(){return lock;}
        public void admit(File directory,String key,long documentBytes,long metadataBytes)throws IOException {
            long used=0;
            for(File dir:directories()){
                File[] entries=dir.listFiles();if(entries==null)throw new IOException("복구 폴더를 읽지 못했어요.");
                for(File entry:entries)if(entry.isFile())used+=entry.length();
            }
            // The prior generation stays intact when admission refuses this replacement.
            File previousData=new File(directory,key+".draft"),previousMeta=new File(directory,key+".meta");
            long replacing=(previousData.isFile()?previousData.length():0)+(previousMeta.isFile()?previousMeta.length():0);
            if(used-replacing+documentBytes+metadataBytes>limit)throw new IOException("복구 저장공간 한도에 도달했어요. 기존 복구 자료는 보존했어요. 문서를 저장한 뒤 다시 시도해 주세요.");
        }
        private List<File> directories()throws IOException {
            List<File> out=new ArrayList<>();File legacy=new File(root,"recovery");
            if(legacy.isDirectory()&&legacy.getCanonicalFile().equals(legacy))out.add(legacy);
            File tabs=new File(root,"recovery-tabs");
            if(!tabs.exists())return out;
            if(!tabs.isDirectory()||!tabs.getCanonicalFile().equals(tabs))throw new IOException("복구 폴더 경로를 사용할 수 없어요.");
            File[] dirs=tabs.listFiles();if(dirs==null)throw new IOException("복구 폴더를 읽지 못했어요.");
            for(File dir:dirs)if(dir.isDirectory()&&dir.getCanonicalFile().equals(dir))out.add(dir);
            return out;
        }
        private void pruneExpired()throws IOException {
            long now=System.currentTimeMillis();
            for(File dir:directories()){
                File[] entries=dir.listFiles();if(entries==null)continue;
                for(File meta:entries){
                    if(!meta.isFile()||!meta.getName().matches("[0-9a-f]{32}\\.meta")||meta.length()>64*1024)continue;
                    String id=meta.getName().substring(0,32);File data=new File(dir,id+".draft");
                    try(InputStream input=new FileInputStream(meta)){
                        Properties p=new Properties();p.load(new InputStreamReader(input,StandardCharsets.UTF_8));
                        long savedAt=Long.parseLong(p.getProperty("savedAt","0"));
                        if(savedAt>0&&savedAt<=now&&now-savedAt>DraftStore.MAX_AGE_MS&&data.isFile()){
                            // Only complete, validated expired records qualify. Unknown/orphan bytes are preserved.
                            DraftStore reader=new DraftStore(dir);reader.read(id);reader.delete(id);
                        }
                    }catch(IOException|RuntimeException unreadable){/* preserve unresolved recovery */}
                }
            }
        }
    }
    private static void syncDirectory(File directory)throws IOException {
        try(FileChannel channel=FileChannel.open(directory.toPath(),StandardOpenOption.READ)){channel.force(true);}
        catch(UnsupportedOperationException unsupported){throw new IOException("복구 폴더를 안전하게 저장하지 못했어요.",unsupported);}
    }
}
