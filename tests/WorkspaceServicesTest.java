package kr.offline.hwp;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/** Shared history/font identity, concurrent key initialization and private recovery across restart. */
public final class WorkspaceServicesTest {
    private static int checks;
    private interface Run {void run()throws Exception;}
    private static void yes(boolean value,String label){if(!value)throw new AssertionError(label);checks++;}
    private static void rejects(Run op,String label)throws Exception {try{op.run();throw new AssertionError(label);}catch(IOException expected){checks++;}}
    private static void parallel(Run first,Run second)throws Exception {
        ExecutorService threads=Executors.newFixedThreadPool(2);CountDownLatch ready=new CountDownLatch(2),start=new CountDownLatch(1);
        try{
            List<Future<?>> futures=new ArrayList<>();
            for(Run op:new Run[]{first,second})futures.add(threads.submit(()->{ready.countDown();try{start.await();op.run();}catch(Exception e){throw new RuntimeException(e);}}));
            if(!ready.await(5,TimeUnit.SECONDS))throw new AssertionError("workers not ready");start.countDown();
            for(Future<?> future:futures)future.get(10,TimeUnit.SECONDS);
        }finally{threads.shutdownNow();}
    }
    private static Map<String,String> info(String title){Map<String,String> out=new HashMap<>();out.put("name",title);out.put("format","hwp");return out;}
    private static WorkspaceServices services(Path privateDir,Path root,SecretKey key)throws Exception {return new WorkspaceServices(privateDir.toFile(),Arrays.asList(root.toFile()),()->key);}
    public static void main(String[] args)throws Exception {
        Path root=Files.createTempDirectory("workspace-services-");
        KeyGenerator generator=KeyGenerator.getInstance("AES");generator.init(256);SecretKey key=generator.generateKey();
        byte[] document=Files.readAllBytes(Paths.get(args[0])),font=Files.readAllBytes(Paths.get(args[1]));
        try{
            Path privateDir=Files.createDirectory(root.resolve("private"));AtomicInteger generated=new AtomicInteger();
            WorkspaceServices services=new WorkspaceServices(privateDir.toFile(),Arrays.asList(root.toFile()),()->{generated.incrementAndGet();return key;});
            AtomicReference<PrivateStateStore> first=new AtomicReference<>(),second=new AtomicReference<>();
            parallel(()->first.set(services.state()),()->second.set(services.state()));
            yes(generated.get()==1&&first.get()==second.get(),"two sessions initialize the key once and share one private-state lock");
            CountDownLatch keyStarted=new CountDownLatch(1),releaseKey=new CountDownLatch(1);
            WorkspaceServices slowKey=new WorkspaceServices(Files.createDirectory(root.resolve("slow-key")).toFile(),Arrays.asList(root.toFile()),()->{keyStarted.countDown();if(!releaseKey.await(5,TimeUnit.SECONDS))throw new IOException("key test timeout");return key;});
            ExecutorService keyThread=Executors.newFixedThreadPool(2);
            try{
                Future<?> loading=keyThread.submit(()->{try{slowKey.state();}catch(IOException error){throw new RuntimeException(error);}});
                if(!keyStarted.await(5,TimeUnit.SECONDS))throw new AssertionError("key factory not entered");
                Future<DraftStore> opening=keyThread.submit(()->slowKey.draftStoreFor(UUID.randomUUID().toString()));
                try{yes(opening.get(2,TimeUnit.SECONDS)!=null,"new tab recovery initialization proceeds while Keystore is stalled");}finally{releaseKey.countDown();}
                loading.get(5,TimeUnit.SECONDS);
            }finally{releaseKey.countDown();keyThread.shutdownNow();}

            parallel(()->first.get().put("history","document-a","A".getBytes(StandardCharsets.UTF_8),document),()->second.get().put("history","document-b","B".getBytes(StandardCharsets.UTF_8),document));
            yes(services.state().list("history").size()==2,"both sessions retain their concurrent histories");
            yes(services.state().get("history","document-a").sequence!=services.state().get("history","document-b").sequence,"shared state assigns distinct commit sequences");
            Path acquiredDir=Files.createDirectory(root.resolve("acquired"));AtomicInteger acquiredKeys=new AtomicInteger();
            WorkspaceServices acquired=WorkspaceServices.acquire(acquiredDir.toFile(),Arrays.asList(root.toFile()),()->{acquiredKeys.incrementAndGet();return key;});
            WorkspaceServices reacquired=WorkspaceServices.acquire(acquiredDir.resolve(".").toFile(),Arrays.asList(root.toFile()),()->{throw new AssertionError("must not replace acquired key factory");});
            yes(acquired==reacquired&&acquired.files()==reacquired.files()&&acquired.fonts()==reacquired.fonts(),"Activity recreation reacquires process-shared durable repositories without replacing locks");
            parallel(()->acquired.state().put("history","old-activity",new byte[]{1},document),()->reacquired.state().put("history","new-activity",new byte[]{2},document));
            yes(acquiredKeys.get()==1&&reacquired.state().list("history").size()==2,"overlapping old/new Activity IO shares one key initialization and history transaction lock");
            FileStore originalStore=services.files();Path volume=Files.createDirectory(root.resolve("volume"));services.refreshRoots(Arrays.asList(volume.toFile()));
            yes(services.files()==originalStore,"volume refresh retains shared FileStore identity");
            rejects(()->originalStore.resolve(root.resolve("removed.hwp").toString()),"removed volume no longer resolves");
            services.refreshRoots(Arrays.asList(root.toFile()));
            FontStore paneA=services.fonts(),paneB=services.fonts();yes(paneA!=null&&paneA==paneB,"sessions share font store and its catalog lock");
            AtomicReference<FontStore.Face> faceA=new AtomicReference<>(),faceB=new AtomicReference<>();
            parallel(()->faceA.set(paneA.importFont(new ByteArrayInputStream(font))),()->faceB.set(paneB.importFont(new ByteArrayInputStream(font))));
            yes(faceA.get().id.equals(faceB.get().id)&&paneA.list().size()==1,"racing imports deduplicate same font and aliases");
            String revision=(String)paneA.snapshot().get("revision");
            yes(Arrays.equals(font,paneB.read(faceA.get().id,revision)),"other pane reads imported font at matching revision");
            paneB.delete(faceA.get().id);rejects(()->paneA.read(faceA.get().id,revision),"deleted shared font rejects stale revision");
            paneA.importFont(new ByteArrayInputStream(font));
            String a=UUID.randomUUID().toString(),b=UUID.randomUUID().toString(),c=UUID.randomUUID().toString();
            String sameKey=DraftStore.key("same-local-document-handle");
            DraftStore da=services.draftStoreFor(a),db=services.draftStoreFor(b),dc=services.draftStoreFor(c);
            yes(da==services.draftStoreFor(a)&&da!=db&&db!=dc,"per-tab stores are stable and independent");
            byte[] changed=document.clone();changed[changed.length-1]^=1;
            parallel(()->da.write(sameKey,info("A"),document),()->db.write(sameKey,info("B"),changed));
            yes(da.list().size()==1&&db.list().size()==1&&dc.list().isEmpty(),"A/B cannot list drafts in another tab even when local keys collide");
            yes(Arrays.equals(document,da.read(sameKey))&&Arrays.equals(changed,db.read(sameKey)),"A/B colliding handles recover their own bytes");
            rejects(()->dc.read(sameKey),"C cannot resume A or B");
            da.delete(sameKey);yes(db.list().size()==1&&dc.list().isEmpty(),"discard in A never removes B recovery");
            // Fill C beyond its count limit: this cannot evict active tab B's unsaved data.
            for(int i=0;i<10;i++)dc.write(DraftStore.key("c"+i),info("C"),document);
            yes(dc.list().size()==DraftStore.MAX_DRAFTS&&Arrays.equals(changed,db.read(sameKey)),"one tab's trimming cannot evict another active draft");
            WorkspaceServices restarted=services(privateDir,root,key);
            yes(Arrays.equals(changed,restarted.draftStoreFor(b).read(sameKey)),"same opaque tab ID restores recovery across process recreation");
            yes(restarted.draftStoreFor(a).list().isEmpty(),"deleted A draft stays deleted after restart");
            yes(restarted.state().list("history").size()==2&&Arrays.equals(document,restarted.state().get("history","document-a").payload),"shared encrypted history persists across workspace recreation");
            yes(restarted.fonts().list().size()==1&&restarted.fonts().list().get(0).aliases.contains(faceA.get().family),"font and aliases persist without session lifetime ownership");
            for(String invalid:new String[]{"../escape","",a.toUpperCase(Locale.ROOT),"1-1-1-1-1",a+"/child"})rejects(()->services.draftStoreFor(invalid),"reject noncanonical UUID");
            migrate(root,key,document);
            budget(root,key,document);
            maintenance(root,key,document);
            discoverClosedRecovery(root,key,document);
            discardClosedTab(root,key,document);
            durableLegacyOwner(root,key,document);
            Path broken=Files.createDirectory(root.resolve("broken-fonts"));Files.write(broken.resolve("fonts"),new byte[]{1});
            yes(services(broken,root,key).fonts()==null,"font initialization IO error preserves legacy unavailable-store behavior");
            AtomicInteger attempts=new AtomicInteger();WorkspaceServices retry=new WorkspaceServices(Files.createDirectory(root.resolve("retry")).toFile(),Arrays.asList(root.toFile()),()->{if(attempts.incrementAndGet()==1)throw new IOException("injected unavailable key");return key;});
            rejects(retry::state,"key failure surfaces without a partial state instance");yes(retry.state()!=null&&attempts.get()==2,"failed key initialization can retry");
            System.out.println("WorkspaceServices: "+checks+" checks passed (injected JVM AES key; AndroidKeystore runtime not exercised)");
        }finally{try(java.util.stream.Stream<Path> paths=Files.walk(root)){paths.sorted(Comparator.reverseOrder()).forEach(p->{try{Files.deleteIfExists(p);}catch(IOException ignored){}});}}
    }
    private static void durableLegacyOwner(Path root,SecretKey key,byte[] document)throws Exception {
        Path privateDir=Files.createDirectory(root.resolve("durable-owner"));String a=UUID.randomUUID().toString(),b=UUID.randomUUID().toString();
        String conflict=DraftStore.key("preserved legacy conflict"),good=DraftStore.key("initial migrated legacy");
        WorkspaceServices first=services(privateDir,root,key);DraftStore legacy=first.legacyDraftStore(),target=first.draftStoreFor(a);
        legacy.write(conflict,info("legacy conflict title"),document);legacy.write(good,info("legacy copied title"),document);
        byte[] changed=document.clone();changed[changed.length-1]^=7;target.write(conflict,info("newer tab recovery"),changed);
        rejects(()->first.migrateLegacyDraftsTo(a),"first owner commits marker before reporting preserved legacy conflict");
        Path marker=privateDir.resolve(WorkspaceServices.LEGACY_OWNER_FILE);
        yes(Arrays.equals(a.getBytes(StandardCharsets.US_ASCII),Files.readAllBytes(marker)),"owner marker contains only exact canonical UUID");
        WorkspaceModel reordered=new WorkspaceModel();reordered.createTab(UUID.fromString(a));reordered.createTab(UUID.fromString(b));reordered.moveBefore(b,a);
        WorkspaceServices cold=services(privateDir,root,key);
        rejects(()->cold.migrateLegacyDraftsTo(reordered.tabIds().get(0)),"reordered cold start still retries conflicting recovery in original owner");
        yes(Arrays.equals(document,legacy.read(conflict))&&Arrays.equals(changed,cold.draftStoreFor(a).read(conflict))&&cold.draftStoreFor(b).list().isEmpty(),"reorder cannot move or overwrite conflict into another tab namespace");
        cold.draftStoreFor(a).delete(conflict);WorkspaceServices resolved=services(privateDir,root,key);resolved.migrateLegacyDraftsTo(b);
        yes(Arrays.equals(document,resolved.draftStoreFor(a).read(conflict))&&resolved.draftStoreFor(b).list().isEmpty(),"resolved legacy record always resumes into committed owner despite another requested tab");
        yes(Arrays.equals(a.getBytes(StandardCharsets.US_ASCII),Files.readAllBytes(marker)),"later requested owner never replaces committed owner marker");

        Path failedDir=Files.createDirectory(root.resolve("owner-commit-failure"));DraftStore failedLegacy=new DraftStore(Files.createDirectory(failedDir.resolve("recovery")).toFile());
        failedLegacy.write(good,info("never copied"),document);oldMetadata(failedDir.resolve("recovery").resolve(good+".meta"));
        byte[] originalMetadata=Files.readAllBytes(failedDir.resolve("recovery").resolve(good+".meta"));AtomicReference<byte[]> staged=new AtomicReference<>();
        WorkspaceServices failed=new WorkspaceServices(failedDir.toFile(),Arrays.asList(root.toFile()),()->key,WorkspaceServices.MAX_RECOVERY_BYTES,(source,destination)->{staged.set(Files.readAllBytes(source.toPath()));throw new IOException("injected marker commit failure");});
        rejects(()->failed.migrateLegacyDraftsTo(a),"marker publication failure stops migration before expiry or copying");
        yes(Arrays.equals(staged.get(),a.getBytes(StandardCharsets.US_ASCII))&&!Files.exists(failedDir.resolve(WorkspaceServices.LEGACY_OWNER_FILE)),"failed commit staged only opaque UUID and published no marker");
        yes(Arrays.equals(originalMetadata,Files.readAllBytes(failedDir.resolve("recovery").resolve(good+".meta")))&&Arrays.equals(document,failedLegacy.read(good)),"marker failure preserves original expired metadata and bytes without cleanup");
        yes(!Files.exists(failedDir.resolve("recovery-tabs")),"failed marker publication creates no target namespace");

        Path corruptDir=Files.createDirectory(root.resolve("owner-corruption"));DraftStore corruptLegacy=new DraftStore(Files.createDirectory(corruptDir.resolve("recovery")).toFile());
        corruptLegacy.write(good,info("preserve on corrupt owner"),document);oldMetadata(corruptDir.resolve("recovery").resolve(good+".meta"));
        byte[] corruptOriginalMeta=Files.readAllBytes(corruptDir.resolve("recovery").resolve(good+".meta"));Path corruptMarker=corruptDir.resolve(WorkspaceServices.LEGACY_OWNER_FILE);
        WorkspaceServices corruptServices=services(corruptDir,root,key);
        String independent=UUID.randomUUID().toString(),unreadablePair=UUID.randomUUID().toString();
        corruptServices.draftStoreFor(independent).write(good,info("unrelated closed-tab recovery"),document);
        Path unreadableDir=Files.createDirectories(corruptDir.resolve("recovery-tabs").resolve(unreadablePair));
        byte[] unreadableMetadata="unparseable metadata".getBytes(StandardCharsets.US_ASCII),unreadableData=new byte[]{9};
        Files.write(unreadableDir.resolve(good+".meta"),unreadableMetadata);Files.write(unreadableDir.resolve(good+".draft"),unreadableData);
        List<String> unrelatedOwners=new ArrayList<>(Arrays.asList(independent,unreadablePair));Collections.sort(unrelatedOwners);
        for(byte[] bad:new byte[][]{new byte[0],"damaged-owner".getBytes(StandardCharsets.US_ASCII),a.toUpperCase(Locale.ROOT).getBytes(StandardCharsets.US_ASCII),(a+"\n").getBytes(StandardCharsets.US_ASCII)}){
            Files.write(corruptMarker,bad);rejects(()->corruptServices.migrateLegacyDraftsTo(b),"invalid owner marker fails closed");
            yes(corruptServices.recoverableTabIds().equals(unrelatedOwners),"damaged legacy owner cannot hide unrelated UUID recovery or invent a legacy owner");
            yes(Arrays.equals(bad,Files.readAllBytes(corruptMarker))&&Arrays.equals(corruptOriginalMeta,Files.readAllBytes(corruptDir.resolve("recovery").resolve(good+".meta")))&&Arrays.equals(document,corruptLegacy.read(good)),"damaged owner marker and every original legacy byte remain unchanged");
        }
        yes(Arrays.equals(document,corruptServices.draftStoreFor(independent).read(good))&&Arrays.equals(unreadableMetadata,Files.readAllBytes(unreadableDir.resolve(good+".meta")))&&Arrays.equals(unreadableData,Files.readAllBytes(unreadableDir.resolve(good+".draft"))),"independent readable and corrupt candidate recovery bytes survive discovery unchanged");
        Files.delete(corruptMarker);Files.createDirectory(corruptMarker);rejects(()->services(corruptDir,root,key).migrateLegacyDraftsTo(b),"unreadable non-file owner marker fails closed");
        yes(Files.isDirectory(corruptMarker)&&Arrays.equals(document,corruptLegacy.read(good)),"unreadable marker is never silently overwritten");
        yes(services(corruptDir,root,key).recoverableTabIds().equals(unrelatedOwners),"unreadable non-file legacy marker cannot suppress independent owners after recreation");
        Files.delete(corruptMarker);
        try{
            Files.createSymbolicLink(corruptMarker,corruptDir.resolve("missing-marker-target"));
            rejects(()->services(corruptDir,root,key).migrateLegacyDraftsTo(b),"dangling owner symlink fails closed instead of appearing absent");
            yes(Files.isSymbolicLink(corruptMarker)&&Arrays.equals(document,corruptLegacy.read(good)),"dangling marker is preserved without reclaiming legacy ownership");
            yes(services(corruptDir,root,key).recoverableTabIds().equals(unrelatedOwners),"symlink legacy marker cannot suppress independent owners after recreation");
        }catch(UnsupportedOperationException|FileSystemException unsupported){/* platform cannot create symlinks */}


        Path afterDir=Files.createDirectory(root.resolve("owner-postcommit-failure"));DraftStore afterLegacy=new DraftStore(Files.createDirectory(afterDir.resolve("recovery")).toFile());afterLegacy.write(good,info("postcommit retry"),document);
        WorkspaceServices after=new WorkspaceServices(afterDir.toFile(),Arrays.asList(root.toFile()),()->key,WorkspaceServices.MAX_RECOVERY_BYTES,(source,destination)->{Files.move(source.toPath(),destination.toPath(),StandardCopyOption.ATOMIC_MOVE);throw new IOException("injected after marker rename");});
        rejects(()->after.migrateLegacyDraftsTo(a),"reported failure after marker rename still stops before draft copying");
        yes(Arrays.equals(document,afterLegacy.read(good))&&after.recoverableTabIds().equals(Collections.singletonList(a)),"committed owner with empty target remains discoverable through pending legacy pair");
        WorkspaceServices retry=services(afterDir,root,key);retry.migrateLegacyDraftsTo(b);
        yes(Arrays.equals(document,retry.draftStoreFor(a).read(good))&&retry.draftStoreFor(b).list().isEmpty(),"retry after postcommit error honors durable owner rather than new current tab");
    }
    /** Closing a tab with consent deletes all of its recovery, so the closed tab is not rediscovered at the next start. */
    private static void discardClosedTab(Path root,SecretKey key,byte[] document)throws Exception {
        Path privateDir=Files.createDirectory(root.resolve("discard-closed"));
        WorkspaceServices services=services(privateDir,root,key);
        String a=UUID.randomUUID().toString(),b=UUID.randomUUID().toString(),fresh=UUID.randomUUID().toString();
        yes(services.tabRecoveryNames(fresh).isEmpty()&&!Files.exists(privateDir.resolve("recovery-tabs").resolve(fresh)),"listing a tab without recovery creates no folder");
        DraftStore da=services.draftStoreFor(a),db=services.draftStoreFor(b);
        da.write(DraftStore.key("earlier document"),info("이전 문서.hwp"),document);Thread.sleep(5);
        da.write(DraftStore.key("current document"),info("현재 문서.hwp"),document);
        db.write(DraftStore.key("other tab"),info("다른 탭.hwp"),document);
        yes(services.tabRecoveryNames(a).equals(Arrays.asList("현재 문서.hwp","이전 문서.hwp")),"tab recovery names, newest first");
        Path aDir=privateDir.resolve("recovery-tabs").resolve(a);Files.write(aDir.resolve(".draft-1.tmp"),new byte[]{1});
        yes(services.recoverableTabIds().containsAll(Arrays.asList(a,b)),"both tabs recoverable before close");
        services.discardTabRecovery(a);
        yes(!Files.exists(aDir),"closed tab folder is gone");
        yes(!services.recoverableTabIds().contains(a)&&services.recoverableTabIds().contains(b),"closed tab is not rediscovered; other tab keeps its recovery");
        yes(services.tabRecoveryNames(a).isEmpty()&&db.list().size()==1,"other tab drafts untouched");
        rejects(()->da.write(DraftStore.key("late autosave"),info("늦은 저장.hwp"),document),"a late write from the closed session fails instead of reviving the tab");
        yes(!services.recoverableTabIds().contains(a),"late write did not revive the closed tab");
        services.discardTabRecovery(fresh);yes(!Files.exists(privateDir.resolve("recovery-tabs").resolve(fresh)),"discarding a tab without recovery is a no-op");
        Path bDir=privateDir.resolve("recovery-tabs").resolve(b);Path foreign=Files.write(bDir.resolve("keep.txt"),new byte[]{3});
        services.discardTabRecovery(b);
        yes(Files.exists(foreign)&&!services.recoverableTabIds().contains(b),"unknown files are kept, recovery records are removed");
        for(String invalid:new String[]{"../escape","",a.toUpperCase(Locale.ROOT)})rejects(()->services.discardTabRecovery(invalid),"reject noncanonical tab ID on discard");
    }
    private static void discoverClosedRecovery(Path root,SecretKey key,byte[] document)throws Exception {
        Path privateDir=Files.createDirectory(root.resolve("discovery"));
        WorkspaceServices services=WorkspaceServices.acquire(privateDir.toFile(),Arrays.asList(root.toFile()),()->key);
        yes(services.recoverableTabIds().isEmpty(),"missing recovery directory discovers no owner without creating storage");
        String owner="00000000-0000-0000-0000-000000000001",corruptOwner="00000000-0000-0000-0000-000000000002",emptyOwner=UUID.randomUUID().toString();
        String id=DraftStore.key("older legacy recovery"),currentId=DraftStore.key("current discarded recovery");DraftStore store=services.draftStoreFor(owner);
        services.legacyDraftStore().write(id,info("older unselected legacy recovery"),document);
        services.legacyDraftStore().write(currentId,info("current recovery"),document);
        services.migrateLegacyDraftsTo(owner);store.delete(currentId);
        yes(!Files.exists(privateDir.resolve("recovery").resolve(id+".meta")),"older legacy record moved safely before first owner's current draft is discarded");
        WorkspaceModel model=new WorkspaceModel();model.createTab(UUID.fromString(owner));model.createTab(UUID.randomUUID());model.removeConfirmed(owner);
        yes(!model.contains(owner),"confirmed close removes recovery owner from workspace layout");
        Path tabs=privateDir.resolve("recovery-tabs"),corruptDir=Files.createDirectory(tabs.resolve(corruptOwner));
        byte[] corruptMeta="not readable properties \u0000".getBytes(StandardCharsets.UTF_8),corruptBytes=new byte[]{1};
        Files.write(corruptDir.resolve(id+".meta"),corruptMeta);Files.write(corruptDir.resolve(id+".draft"),corruptBytes);
        String orphan=DraftStore.key("unpaired orphan");Path empty=Files.createDirectory(tabs.resolve(emptyOwner));Files.write(empty.resolve(orphan+".draft"),document);
        Path invalid=Files.createDirectory(tabs.resolve("invalid-tab-id"));Files.write(invalid.resolve(id+".meta"),corruptMeta);Files.write(invalid.resolve(id+".draft"),document);
        String uppercase="ABCDEFAB-0000-0000-0000-000000000000";Path noncanonical=Files.createDirectory(tabs.resolve(uppercase));Files.write(noncanonical.resolve(id+".meta"),corruptMeta);Files.write(noncanonical.resolve(id+".draft"),document);
        Path stray=Files.write(tabs.resolve("stray-file"),new byte[]{2});
        WorkspaceServices reacquired=WorkspaceServices.acquire(privateDir.resolve(".").toFile(),Arrays.asList(root.toFile()),()->key);
        List<String> candidates=reacquired.recoverableTabIds();
        yes(candidates.equals(Arrays.asList(owner,corruptOwner)),"reacquired workspace discovers closed and corrupt candidate owners in stable UUID order");
        try{candidates.add(emptyOwner);throw new AssertionError("mutable discovery result");}catch(UnsupportedOperationException immutable){checks++;}
        WorkspaceServices restarted=services(privateDir,root,key);
        yes(restarted.recoverableTabIds().equals(candidates),"process recreation discovers owners absent from saved layout");
        yes(Arrays.equals(document,restarted.draftStoreFor(owner).read(id)),"closed owner's older recovery remains readable after discovery");
        yes(Arrays.equals(corruptMeta,Files.readAllBytes(corruptDir.resolve(id+".meta")))&&Arrays.equals(corruptBytes,Files.readAllBytes(corruptDir.resolve(id+".draft"))),"metadata-only discovery preserves corrupt candidate pair exactly");
        yes(Arrays.equals(document,Files.readAllBytes(empty.resolve(orphan+".draft")))&&Arrays.equals(document,Files.readAllBytes(invalid.resolve(id+".draft")))&&Files.exists(noncanonical.resolve(id+".meta"))&&Files.exists(stray),"discovery leaves orphan, invalid UUID and unrelated files untouched");
    }
    private static void budget(Path root,SecretKey key,byte[] document)throws Exception {
        Path privateDir=Files.createDirectory(root.resolve("quota"));long limit=2L*document.length+2048;
        WorkspaceServices first=new WorkspaceServices(privateDir.toFile(),Arrays.asList(root.toFile()),()->key,limit);
        WorkspaceServices second=new WorkspaceServices(privateDir.toFile(),Arrays.asList(root.toFile()),()->key,limit);
        String closed=UUID.randomUUID().toString(),a=UUID.randomUUID().toString(),b=UUID.randomUUID().toString(),id=DraftStore.key("same-handle");
        DraftStore closedStore=first.draftStoreFor(closed),da=first.draftStoreFor(a),db=second.draftStoreFor(b);
        closedStore.write(id,info("closed unrecovered tab"),document);
        AtomicInteger won=new AtomicInteger(),refused=new AtomicInteger();
        parallel(()->{try{da.write(id,info("A"),document);won.incrementAndGet();}catch(IOException expected){refused.incrementAndGet();}},()->{try{db.write(id,info("B"),document);won.incrementAndGet();}catch(IOException expected){refused.incrementAndGet();}});
        yes(won.get()==1&&refused.get()==1,"concurrent drafts across service instances cannot both consume the final global capacity");
        yes(Arrays.equals(document,closedStore.read(id)),"quota admission never evicts closed unrecovered data");
        DraftStore winner=da.list().isEmpty()?db:da,loser=da.list().isEmpty()?da:db;
        byte[] larger=Arrays.copyOf(document,document.length*3);
        rejects(()->winner.write(id,info("too large"),larger),"oversized replacement refuses quota before replacing old draft");
        yes(Arrays.equals(document,winner.read(id)),"quota refusal preserves previous recoverable bytes");
        winner.delete(id);loser.write(id,info("after explicit discard"),document);
        yes(Arrays.equals(document,loser.read(id))&&Arrays.equals(document,closedStore.read(id)),"explicit discard reclaims capacity without deleting another tab");
        String orphan=DraftStore.key("unknown orphan");Path orphanPath=privateDir.resolve("recovery-tabs").resolve(closed).resolve(orphan+".draft");Files.write(orphanPath,document);
        rejects(()->loser.write(id,info("retained while orphan counts"),document),"preexisting orphan bytes count toward global admission");
        yes(Files.exists(orphanPath)&&Arrays.equals(document,loser.read(id)),"budget refusal does not delete unknown orphan or old live record");
    }
    private static void oldMetadata(Path path)throws Exception {
        Properties properties=new Properties();try(Reader reader=Files.newBufferedReader(path,StandardCharsets.UTF_8)){properties.load(reader);}
        properties.setProperty("savedAt",String.valueOf(System.currentTimeMillis()-DraftStore.MAX_AGE_MS-60000));
        try(Writer writer=Files.newBufferedWriter(path,StandardCharsets.UTF_8)){properties.store(writer,null);}
    }
    private static void maintenance(Path root,SecretKey key,byte[] document)throws Exception {
        Path privateDir=Files.createDirectory(root.resolve("maintenance"));String tab=UUID.randomUUID().toString();
        Path dir=Files.createDirectories(privateDir.resolve("recovery-tabs").resolve(tab));DraftStore draft=new DraftStore(dir.toFile());
        String expired=DraftStore.key("expired"),corrupt=DraftStore.key("expired-corrupt"),current=DraftStore.key("current"),orphan=DraftStore.key("old-orphan");
        draft.write(expired,info("expired"),document);draft.write(corrupt,info("corrupt"),document);draft.write(current,info("current"),document);
        oldMetadata(dir.resolve(expired+".meta"));oldMetadata(dir.resolve(corrupt+".meta"));Files.write(dir.resolve(corrupt+".draft"),new byte[]{1});
        Files.write(dir.resolve(orphan+".draft"),document);Files.setLastModifiedTime(dir.resolve(orphan+".draft"),java.nio.file.attribute.FileTime.fromMillis(0));
        WorkspaceServices startup=services(privateDir,root,key);startup.migrateLegacyDraftsTo(tab);
        yes(!Files.exists(dir.resolve(expired+".meta"))&&!Files.exists(dir.resolve(expired+".draft")),"startup releases only validated records beyond existing 30-day expiry");
        yes(Files.exists(dir.resolve(corrupt+".meta"))&&Files.exists(dir.resolve(corrupt+".draft"))&&Files.exists(dir.resolve(orphan+".draft")),"startup preserves unreadable expired pairs and orphan bytes");
        yes(Files.exists(dir.resolve(current+".meta")),"startup preserves current recovery");
        oldMetadata(dir.resolve(current+".meta"));services(privateDir,root,key).migrateLegacyDraftsTo(tab);
        yes(Files.exists(dir.resolve(current+".meta")),"recreating services does not rerun global recovery cleanup in the same process");
    }
    private static void migrate(Path root,SecretKey key,byte[] document)throws Exception {
        Path privateDir=Files.createDirectory(root.resolve("migration")),legacyDir=Files.createDirectory(privateDir.resolve("recovery"));
        DraftStore legacy=new DraftStore(legacyDir.toFile());String good=DraftStore.key("legacy-good"),failed=DraftStore.key("legacy-copy-failed"),corrupt=DraftStore.key("legacy-corrupt"),orphan=DraftStore.key("legacy-orphan"),conflict=DraftStore.key("legacy-conflict");
        legacy.write(good,info("good"),document);legacy.write(failed,info("failed"),document);legacy.write(corrupt,info("corrupt"),document);legacy.write(conflict,info("conflict"),document);
        Files.write(legacyDir.resolve(corrupt+".draft"),new byte[]{1});Files.write(legacyDir.resolve(orphan+".draft"),document);
        Files.setLastModifiedTime(legacyDir.resolve(orphan+".draft"),java.nio.file.attribute.FileTime.fromMillis(0));
        WorkspaceServices services=services(privateDir,root,key);String a=UUID.randomUUID().toString(),b=UUID.randomUUID().toString();DraftStore target=services.draftStoreFor(a);
        byte[] changed=document.clone();changed[changed.length-1]^=2;target.write(conflict,info("newer tab recovery"),changed);
        Path targetDir=privateDir.resolve("recovery-tabs").resolve(a);Files.createDirectory(targetDir.resolve(failed+".meta"));Files.write(targetDir.resolve(failed+".meta/block"),new byte[]{1});
        rejects(()->services.migrateLegacyDraftsTo(a),"copy failure and corrupt source remain visible as migration error");
        yes(Arrays.equals(document,target.read(good))&&!Files.exists(legacyDir.resolve(good+".meta")),"verified legacy copy migrates successfully before original is removed");
        yes(Arrays.equals(document,legacy.read(failed)),"failed destination commit preserves resumable legacy source");
        yes(Files.exists(legacyDir.resolve(corrupt+".meta"))&&Files.exists(legacyDir.resolve(corrupt+".draft")),"corrupt legacy pair is not blindly deleted");
        yes(Files.exists(legacyDir.resolve(orphan+".draft")),"old orphan remains intact during migration");
        yes(Arrays.equals(changed,target.read(conflict))&&Arrays.equals(document,legacy.read(conflict)),"conflicting target preserves both recoveries");
        rejects(()->services.migrateLegacyDraftsTo(b),"another requested owner retries preserved records only in the committed namespace");yes(services.draftStoreFor(b).list().isEmpty(),"only first restored tab can claim legacy records");
        Files.delete(targetDir.resolve(failed+".meta/block"));Files.delete(targetDir.resolve(failed+".meta"));
        // Simulate restart after copied bytes committed but before legacy source deletion.
        target.write(failed,info("interrupted-copy"),document);
        WorkspaceServices restart=services(privateDir,root,key);rejects(()->restart.migrateLegacyDraftsTo(a),"corrupt/conflicting entries remain reported after restart");
        yes(Arrays.equals(document,restart.draftStoreFor(a).read(failed))&&!Files.exists(legacyDir.resolve(failed+".meta")),"restart recognizes identical committed copy before deleting legacy source");
    }
}
