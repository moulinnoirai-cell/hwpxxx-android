package kr.offline.hwp;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/**
 * Pure-JVM isolation checks for the multi-document workspace. These are stubs of the OS contract, not device proof:
 * they cover only the shared-state rules that do not need an Android runtime.
 * Usage: WorkspaceIsolationTest <fixtures-dir> [source files to lint for provider reads under the FileStore lock...]
 */
public class WorkspaceIsolationTest {
    static int checks=0;
    static void yes(boolean b,String what){if(!b)throw new AssertionError(what);checks++;}
    interface Run {void run()throws Exception;}
    static void rejected(Run r,String what)throws Exception{try{r.run();}catch(IOException|IllegalArgumentException|IllegalStateException expected){checks++;return;}throw new AssertionError("expected rejection: "+what);}
    static final String A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222";

    public static void main(String[] args)throws Exception {
        Path fixtures=Paths.get(args[0]);
        Path root=Files.createTempDirectory("hwp-workspace-isolation-");
        try {
            requests();
            sameSourceNoOverwrite(root,fixtures);
            draftNamespaces(root,fixtures);
            legacyMigration(root,fixtures);
            frozenRequestProtocol();
            closeTtlAndPickerBounds();
            legacyOwnerMarker(root,fixtures);
            stateFilePrivacyAndLayout(root);
            recoveryDiscovery(root,fixtures);
            recoveryBudget(root,fixtures);
            servicesProcessCache(root);
            for(int i=1;i<args.length;i++){
                Path source=Paths.get(args[i]);noProviderReadUnderStoreLock(source);
                if(source.getFileName().toString().equals("MainActivity.java"))mainActivitySourceChecks(source);
            }
            System.out.println("WorkspaceIsolationTest ok, checks="+checks);
        } finally {deleteTree(root);}
    }

    // ---- picker / close capabilities -------------------------------------------------------------------------
    static void requests()throws Exception {
        WorkspaceRequests r=new WorkspaceRequests();
        // A's picker result routes to A even though B is the active/focused pane when the system returns it.
        int a=r.registerPicker(A,"sessA",7),b=r.registerPicker(B,"sessB",7);
        yes(a!=b,"request codes unique even with identical JS-local codes");
        WorkspaceRequests.Picker pa=r.consumePicker(a);
        yes(pa!=null&&pa.tabId.equals(A)&&pa.sessionId.equals("sessA")&&pa.localCode==7,"A result routes to A");
        yes(r.consumePicker(a)==null,"a result is delivered once");
        yes(r.consumePicker(123456)==null&&r.consumePicker(-1)==null&&r.consumePicker(303)==null,"unknown/legacy code never falls back to another session");
        // A closed owner's pending pickers disappear; a late result is refused, not rerouted to B.
        int a2=r.registerPicker(A,"sessA",9);r.removeSession("sessA");
        yes(r.consumePicker(a2)==null,"closed owner's late picker result refused");
        yes(r.consumePicker(b)!=null,"other session's picker untouched by removeSession");
        // Codes are never reused, even after cancellation/consumption.
        Set<Integer> seen=new HashSet<>();for(int i=0;i<2000;i++){int c=r.registerPicker(A,"s"+(i%3),i);yes(seen.add(c),"no code reuse");r.consumePicker(c);}
        // After recreation the persisted counter prevents an old in-flight system result from colliding with a new request.
        int next=r.nextPickerCode();WorkspaceRequests revived=new WorkspaceRequests(next);
        int fresh=revived.registerPicker(B,"sessB2",1);yes(fresh>=next,"revived counter does not reissue pre-recreation codes");
        // Concurrent registration from several UI-adjacent threads stays unique.
        WorkspaceRequests shared=new WorkspaceRequests();Set<Integer> all=ConcurrentHashMap.newKeySet();
        parallel(8,t->{for(int i=0;i<200;i++)yes(all.add(shared.registerPicker(A,"s"+t,i)),"concurrent unique code");});
        yes(all.size()==1600,"all concurrent codes distinct");
        // The former 16-bit ceiling is gone: counters persisted by older builds keep advancing past 65534/65535.
        WorkspaceRequests legacyCounter=new WorkspaceRequests(65534);
        int p1=legacyCounter.registerPicker(A,"s",1),p2=legacyCounter.registerPicker(A,"s",2),p3=legacyCounter.registerPicker(A,"s",3);
        yes(p1==65534&&p2==65535&&p3==65536&&legacyCounter.consumePicker(p3)!=null,"old 65534 bound no longer applies");
        rejected(()->r.registerPicker(null,"s",1),"missing tab id");rejected(()->r.registerPicker(A,"",1),"missing session id");

        // Close capability: token is bound to the originating session; another session cannot use or consume it.
        String ta=r.requestClose(A,"sessA"),tb=r.requestClose(B,"sessB");
        yes(!ta.equals(tb),"distinct tokens");
        yes(r.consumeClose("sessB",ta)==null,"B cannot consume A's close token");
        yes(r.hasPendingClose("sessA"),"A's token survives B's refused attempt");
        yes(r.consumeClose("sessA",tb)==null,"A cannot consume B's token");
        yes(A.equals(r.consumeClose("sessA",ta)),"A consumes own token once");
        yes(r.consumeClose("sessA",ta)==null,"replayed token refused");
        yes(r.consumeClose("sessA","not-a-token")==null&&r.consumeClose("sessA",null)==null,"unknown/null token refused");
        // Closed owner: token dies with the session and is not honored on behalf of someone else.
        r.removeSession("sessB");yes(r.consumeClose("sessB",tb)==null&&!r.hasPendingClose("sessB"),"stale token of a removed session refused");
        // A refusal (allow=false) consumed the token; the next request must mint a new one.
        String t1=r.requestClose(A,"sessA");r.consumeClose("sessA",t1);String t2=r.requestClose(A,"sessA");yes(!t1.equals(t2),"fresh token after consume");
        yes(r.requestClose(A,"sessA").equals(t2),"repeat request while pending reuses the token");
    }

    // ---- same-source hash race across sessions/instances ----------------------------------------------------
    static void sameSourceNoOverwrite(Path root,Path fixtures)throws Exception {
        byte[] base=Files.readAllBytes(fixtures.resolve("blank.hwp")),v1=Files.readAllBytes(fixtures.resolve("table.hwp")),v2=Files.readAllBytes(fixtures.resolve("문서.hwp"));
        Path dir=Files.createDirectory(root.resolve("race"));
        // Each "session" owns a FileStore instance over the same root: the lock must be process-wide, not per instance.
        for(int round=0;round<40;round++){
            Path target=dir.resolve("same-"+round+".hwp");Files.write(target,base);String sha=FileStore.sha(base);
            FileStore s1=new FileStore(Arrays.asList(dir.toFile())),s2=new FileStore(Arrays.asList(dir.toFile())),s3=new FileStore(Arrays.asList(dir.toFile()));
            AtomicInteger ok=new AtomicInteger();CountDownLatch go=new CountDownLatch(1);List<Thread> threads=new ArrayList<>();
            byte[][] payload={v1,v2,v1};FileStore[] stores={s1,s2,s3};
            for(int i=0;i<3;i++){final int n=i;Thread t=new Thread(()->{try{go.await();stores[n].write(target.toString(),payload[n],sha,true);ok.incrementAndGet();}catch(IOException expectedLoser){}catch(InterruptedException e){}});threads.add(t);t.start();}
            go.countDown();for(Thread t:threads)t.join();
            yes(ok.get()==1,"exactly one same-baseline replace succeeds (round "+round+", got "+ok.get()+")");
            byte[] now=Files.readAllBytes(target);yes(Arrays.equals(now,v1)||Arrays.equals(now,v2),"file holds a complete winner payload");
        }
        // FileStore and ExportStore mutators share one transaction lock for HWPX as well.
        byte[] xbase=Files.readAllBytes(fixtures.resolve("blank.hwpx")),x1=Files.readAllBytes(fixtures.resolve("table.hwpx")),x2=Files.readAllBytes(fixtures.resolve("문서.hwpx"));
        for(int round=0;round<40;round++){
            Path target=dir.resolve("same-"+round+".hwpx");Files.write(target,xbase);String sha=FileStore.sha(xbase);
            FileStore f=new FileStore(Arrays.asList(dir.toFile())),g=new FileStore(Arrays.asList(dir.toFile()));ExportStore e=new ExportStore(g);
            AtomicInteger ok=new AtomicInteger();CountDownLatch go=new CountDownLatch(1);
            Thread t1=new Thread(()->{try{go.await();f.write(target.toString(),x1,sha,true);ok.incrementAndGet();}catch(Exception loser){}});
            Thread t2=new Thread(()->{try{go.await();e.write(target.toString(),x2,sha,true);ok.incrementAndGet();}catch(Exception loser){}});
            t1.start();t2.start();go.countDown();t1.join();t2.join();
            yes(ok.get()==1,"FileStore vs ExportStore same-baseline replace: exactly one winner (round "+round+", got "+ok.get()+")");
        }
        // Non-replace creation of the same new name by two sessions never overwrites either result.
        for(int round=0;round<20;round++){
            Path target=dir.resolve("new-"+round+".hwp");FileStore f=new FileStore(Arrays.asList(dir.toFile())),g=new FileStore(Arrays.asList(dir.toFile()));
            AtomicInteger ok=new AtomicInteger();CountDownLatch go=new CountDownLatch(1);
            Thread t1=new Thread(()->{try{go.await();f.write(target.toString(),v1,null,false);ok.incrementAndGet();}catch(Exception loser){}});
            Thread t2=new Thread(()->{try{go.await();g.write(target.toString(),v2,null,false);ok.incrementAndGet();}catch(Exception loser){}});
            t1.start();t2.start();go.countDown();t1.join();t2.join();yes(ok.get()==1,"same new name: exactly one creator");
        }
    }

    // ---- per-tab recovery namespaces ------------------------------------------------------------------------
    static Map<String,String> info(String name,String format){Map<String,String> m=new HashMap<>();m.put("name",name);m.put("format",format);m.put("path","/storage/emulated/0/"+name);m.put("folder","/storage/emulated/0");return m;}
    static WorkspaceServices services(Path files)throws IOException{return new WorkspaceServices(files.toFile(),Collections.singletonList(files.toFile()),()->{throw new IllegalStateException("keystore must not be touched by recovery");});}

    static void draftNamespaces(Path root,Path fixtures)throws Exception {
        byte[] hwp=Files.readAllBytes(fixtures.resolve("blank.hwp")),other=Files.readAllBytes(fixtures.resolve("table.hwp"));
        Path files=Files.createDirectory(root.resolve("ns"));WorkspaceServices s=services(files);
        yes(s.draftStoreFor(A)==s.draftStoreFor(A)&&s.draftStoreFor(A)!=s.draftStoreFor(B),"one cached store per tab UUID");
        rejected(()->s.draftStoreFor("../x"),"traversal id");rejected(()->s.draftStoreFor("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),"non-canonical UUID");rejected(()->s.draftStoreFor(null),"null id");rejected(()->s.draftStoreFor(A+"/.."),"suffix traversal");
        // Same file / same name opened in two tabs: identical document key, separate namespaces, no cross visibility.
        String key=DraftStore.key("/storage/emulated/0/보고서.hwp");
        s.draftStoreFor(A).write(key,info("보고서.hwp","hwp"),hwp);s.draftStoreFor(B).write(key,info("보고서.hwp","hwp"),other);
        yes(Arrays.equals(s.draftStoreFor(A).read(key),hwp)&&Arrays.equals(s.draftStoreFor(B).read(key),other),"same key in two tabs stays separate");
        s.draftStoreFor(A).delete(key);rejected(()->s.draftStoreFor(A).info(key),"A's draft deleted");
        yes(Arrays.equals(s.draftStoreFor(B).read(key),other),"discarding in A never deletes B's draft");
        // Per-store trim (8 drafts) in A must not evict B's draft.
        for(int i=0;i<12;i++)s.draftStoreFor(A).write(DraftStore.key("doc-"+i),info("d"+i+".hwp","hwp"),hwp);
        yes(s.draftStoreFor(A).list().size()==DraftStore.MAX_DRAFTS,"A bounded by its own quota");
        yes(s.draftStoreFor(B).list().size()==1&&Arrays.equals(s.draftStoreFor(B).read(key),other),"A's trim does not evict B's active draft");
        // A new process (new WorkspaceServices over the same files) reopens the same namespace by UUID only.
        WorkspaceServices again=services(files);yes(again.draftStoreFor(B).list().size()==1,"namespace survives restart by UUID");
        // Concurrent writes of different tabs through one WorkspaceServices stay isolated.
        parallel(4,t->{try{String id=t%2==0?A:B;for(int i=0;i<3;i++)s.draftStoreFor(id).write(DraftStore.key("c"+t+"-"+i),info("c.hwp","hwp"),hwp);}catch(IOException e){throw new UncheckedIOException(e);}});
        yes(s.draftStoreFor(B).list().stream().allMatch(m->m.get("key")!=null),"concurrent writes left readable metadata");
    }

    // ---- legacy recovery migration: copy before delete, failures keep the legacy copy -----------------------
    static void legacyMigration(Path root,Path fixtures)throws Exception {
        byte[] hwp=Files.readAllBytes(fixtures.resolve("blank.hwp")),other=Files.readAllBytes(fixtures.resolve("table.hwp"));
        // Happy path: copied verbatim to the first tab; legacy pair removed only after verification; second tab does not receive them.
        Path f1=Files.createDirectory(root.resolve("mig1"));WorkspaceServices s=services(f1);
        String k1=DraftStore.key("one"),k2=DraftStore.key("two");
        s.legacyDraftStore().write(k1,info("one.hwp","hwp"),hwp);s.legacyDraftStore().write(k2,info("two.hwp","hwp"),other);
        s.migrateLegacyDraftsTo(A);
        yes(Arrays.equals(s.draftStoreFor(A).read(k1),hwp)&&Arrays.equals(s.draftStoreFor(A).read(k2),other),"legacy drafts copied to first tab");
        yes(!new File(f1.toFile(),"recovery/"+k1+".meta").exists()&&!new File(f1.toFile(),"recovery/"+k1+".draft").exists(),"legacy pair removed after verified copy");
        s.migrateLegacyDraftsTo(B);yes(s.draftStoreFor(B).list().isEmpty(),"second tab never receives legacy drafts");

        // Conflict: target already holds different bytes for the same key => legacy preserved, target untouched, error surfaced.
        Path f2=Files.createDirectory(root.resolve("mig2"));WorkspaceServices c=services(f2);
        c.legacyDraftStore().write(k1,info("one.hwp","hwp"),hwp);c.draftStoreFor(A).write(k1,info("one.hwp","hwp"),other);
        rejected(()->c.migrateLegacyDraftsTo(A),"conflicting target preserved with an error");
        yes(Arrays.equals(c.legacyDraftStore().read(k1),hwp),"legacy copy survives a conflicting target");
        yes(Arrays.equals(c.draftStoreFor(A).read(k1),other),"target draft never overwritten by migration");

        // Corrupt legacy bytes: never copied, never deleted.
        Path f3=Files.createDirectory(root.resolve("mig3"));WorkspaceServices d=services(f3);
        d.legacyDraftStore().write(k1,info("one.hwp","hwp"),hwp);
        Files.write(f3.resolve("recovery/"+k1+".draft"),new byte[]{1,2,3});
        rejected(()->d.migrateLegacyDraftsTo(A),"corrupt legacy reported");
        yes(Files.exists(f3.resolve("recovery/"+k1+".draft"))&&Files.exists(f3.resolve("recovery/"+k1+".meta")),"corrupt legacy files left in place");
        yes(d.draftStoreFor(A).list().isEmpty(),"corrupt record not materialised in the tab namespace");

        // Quota: a full target keeps every legacy record rather than evicting either side.
        Path f4=Files.createDirectory(root.resolve("mig4"));WorkspaceServices q=services(f4);
        for(int i=0;i<DraftStore.MAX_DRAFTS;i++)q.draftStoreFor(A).write(DraftStore.key("t"+i),info("t"+i+".hwp","hwp"),hwp);
        q.legacyDraftStore().write(k1,info("one.hwp","hwp"),other);
        rejected(()->q.migrateLegacyDraftsTo(A),"full target preserves legacy");
        yes(Arrays.equals(q.legacyDraftStore().read(k1),other)&&q.draftStoreFor(A).list().size()==DraftStore.MAX_DRAFTS,"neither side lost a draft at the quota");

        // Idempotent restart: equal bytes in both places => completes and drops only the legacy pair.
        Path f5=Files.createDirectory(root.resolve("mig5"));WorkspaceServices r=services(f5);
        r.legacyDraftStore().write(k1,info("one.hwp","hwp"),hwp);r.draftStoreFor(A).write(k1,info("one.hwp","hwp"),hwp);
        r.migrateLegacyDraftsTo(A);yes(!Files.exists(f5.resolve("recovery/"+k1+".meta"))&&Arrays.equals(r.draftStoreFor(A).read(k1),hwp),"interrupted migration resumes");
    }


    // ---- frozen request protocol: durable counter shared by Activity instances, session replacement ----------
    static void frozenRequestProtocol()throws Exception {
        // Emulates MainActivity.launchPicker: one process-wide lock + durable high-water mark committed before launch.
        final Object lock=new Object();final AtomicInteger prefs=new AtomicInteger(1000);
        WorkspaceRequests first=new WorkspaceRequests(prefs.get()),second=new WorkspaceRequests(prefs.get());
        Set<Integer> codes=ConcurrentHashMap.newKeySet();
        parallel(6,t->{WorkspaceRequests r=t%2==0?first:second;for(int i=0;i<150;i++)synchronized(lock){
            r.raiseNextPickerCodeTo(prefs.get());int c=r.registerPicker(A,"s"+t,i);prefs.set(r.nextPickerCode());yes(codes.add(c),"two Activity instances never issue the same code");}});
        yes(codes.size()==900,"all codes from both instances distinct");
        // raise never lowers; an old Activity cannot downgrade the allocator.
        WorkspaceRequests r=new WorkspaceRequests(5000);r.raiseNextPickerCodeTo(2000);yes(r.nextPickerCode()==5000,"high-water mark never lowered");
        r.raiseNextPickerCodeTo(6000);yes(r.registerPicker(A,"s",1)==6000,"raised mark honoured");
        // Renderer replacement keeps the tab UUID but mints a new session id: old capabilities are dead for the new runtime.
        WorkspaceRequests q=new WorkspaceRequests();int code=q.registerPicker(A,"old-session",3);String token=q.requestClose(A,"old-session");
        WorkspaceRequests.Picker route=q.consumePicker(code);yes(route!=null&&!route.sessionId.equals("new-session")&&route.tabId.equals(A),"route names the OLD session so MainActivity drops it for the replacement");
        yes(q.consumeClose("new-session",token)==null,"old close token unusable by the replacement session of the same tab");
        q.removeSession("old-session");yes(q.consumeClose("old-session",token)==null,"revoked on teardown");
        // A pending close is per session: another tab's pending close never blocks or aliases this one.
        String x=q.requestClose(A,"sa"),y=q.requestClose(B,"sb");yes(!x.equals(y)&&q.hasPendingClose("sa")&&q.hasPendingClose("sb"),"independent pending closes");
        q.removeSession("sa");yes(!q.hasPendingClose("sa")&&q.hasPendingClose("sb"),"teardown removes only its own token");
    }

    // ---- workspace state file: ids/layout only; layout operations keep visible assignments -------------------
    static void stateFilePrivacyAndLayout(Path root)throws Exception {
        Path dir=Files.createDirectory(root.resolve("state-store"));File file=dir.resolve("workspace-state").toFile();
        WorkspaceModel m=new WorkspaceModel();UUID[] id={UUID.randomUUID(),UUID.randomUUID(),UUID.randomUUID(),UUID.randomUUID()};
        for(UUID u:id)yes(m.createTab(u),"tab created");
        String secretTitle="기밀-급여표 비밀번호1234.hwp";
        for(UUID u:id)m.update(u.toString(),secretTitle,true,true,true);
        m.setSplit(true,id[0].toString());
        String primary=m.primaryId(),secondary=m.secondaryId(),active=m.activeId();
        yes(secondary!=null&&!secondary.equals(primary),"split has two distinct visible tabs");
        // Reordering/closing a hidden tab changes order only, never pane assignments.
        String hidden=null;for(String t:m.tabIds())if(!t.equals(primary)&&!t.equals(secondary)){hidden=t;break;}
        yes(hidden!=null,"a hidden tab exists");
        m.moveBefore(hidden,m.tabIds().get(0));
        yes(primary.equals(m.primaryId())&&secondary.equals(m.secondaryId())&&active.equals(m.activeId()),"moveBefore keeps primary/secondary/active");
        yes(m.removeConfirmed(hidden)&&primary.equals(m.primaryId())&&secondary.equals(m.secondaryId())&&m.size()==3,"closing a hidden tab leaves both panes");
        WorkspaceStateStore store=new WorkspaceStateStore(file);store.save(m);
        String text=new String(Files.readAllBytes(file.toPath()),"UTF-8");
        for(String t:m.tabIds())yes(text.contains(t),"state keeps tab id");
        yes(!text.contains("기밀")&&!text.contains("비밀번호")&&!text.contains("1234")&&!text.contains(".hwp")&&!text.contains("title")&&!text.toLowerCase().contains("password"),"state file holds no title/name/password text");
        yes(file.length()<=WorkspaceStateStore.MAX_BYTES,"state file bounded");
        WorkspaceStateStore.Loaded loaded=store.load();
        yes(loaded.status==WorkspaceStateStore.Status.OK&&loaded.model.tabIds().equals(m.tabIds())&&primary.equals(loaded.model.primaryId())&&secondary.equals(loaded.model.secondaryId())&&loaded.model.isSplit(),"cold start restores ids, order and panes");
        yes(loaded.model.tab(primary).title.equals("")||!loaded.model.tab(primary).title.contains("기밀"),"no title is restored from disk");
        // A corrupt layout is quarantined (kept), never silently replaced.
        Files.write(file.toPath(),"garbage".getBytes("UTF-8"));
        yes(store.load().status==WorkspaceStateStore.Status.INVALID,"corrupt state detected");
        File kept=store.quarantineInvalid();yes(kept!=null&&kept.isFile()&&!file.exists()&&Arrays.equals(Files.readAllBytes(kept.toPath()),"garbage".getBytes("UTF-8")),"corrupt state preserved aside");
        yes(store.load().status==WorkspaceStateStore.Status.ABSENT,"next start begins empty after quarantine");
        // The 6th tab is refused; unrelated tabs stay.
        WorkspaceModel full=new WorkspaceModel();for(int i=0;i<WorkspaceModel.MAX_TABS;i++)full.createTab(UUID.randomUUID());
        yes(!full.canCreateTab()&&!full.createTab(UUID.randomUUID())&&full.size()==WorkspaceModel.MAX_TABS,"five tab cap");
    }

    // ---- orphan recovery discovery: opaque UUIDs only, read-only, never touches records -------------------
    static void writeDraft(File dir,String key,byte[] data,boolean meta,boolean bytes)throws IOException {
        dir.mkdirs();if(bytes)Files.write(new File(dir,key+".draft").toPath(),data);if(meta)Files.write(new File(dir,key+".meta").toPath(),"x".getBytes());
    }
    static void recoveryDiscovery(Path root,Path fixtures)throws Exception {
        byte[] hwp=Files.readAllBytes(fixtures.resolve("blank.hwp"));
        Path files=Files.createDirectory(root.resolve("discover"));WorkspaceServices s=services(files);
        yes(s.recoverableTabIds().isEmpty()&&!new File(files.toFile(),"recovery-tabs").exists(),"no recovery root: empty and nothing created");
        File tabs=new File(files.toFile(),"recovery-tabs");String k=DraftStore.key("d");
        String c="33333333-3333-4333-8333-333333333333",d="44444444-4444-4444-8444-444444444444";
        writeDraft(new File(tabs,B),k,hwp,true,true);writeDraft(new File(tabs,A),k,hwp,true,true);   // complete -> reported, sorted
        writeDraft(new File(tabs,c),k,hwp,true,false);                                                // meta only
        writeDraft(new File(tabs,d),k,hwp,false,true);                                                // bytes only
        writeDraft(new File(tabs,"not-a-uuid"),k,hwp,true,true);writeDraft(new File(tabs,"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),k,hwp,true,true);
        Files.write(new File(tabs,"55555555-5555-4555-8555-555555555555").toPath(),new byte[]{1});     // a file, not a directory
        Map<String,Long> before=new TreeMap<>();for(File f:allFiles(tabs))before.put(f.getPath(),f.length()+f.lastModified());
        List<String> found=s.recoverableTabIds();
        yes(found.equals(Arrays.asList(A,B)),"only complete lowercase-UUID owners reported, sorted: "+found);
        Map<String,Long> after=new TreeMap<>();for(File f:allFiles(tabs))after.put(f.getPath(),f.length()+f.lastModified());
        yes(before.equals(after),"discovery neither parsed, cleaned nor deleted any record");
        yes(!String.valueOf(found).contains("보고서"),"discovery returns opaque ids only");
    }
    static List<File> allFiles(File dir){List<File> out=new ArrayList<>();File[] l=dir.listFiles();if(l!=null)for(File f:l){out.add(f);if(f.isDirectory())out.addAll(allFiles(f));}return out;}

    // ---- shared recovery budget: refuses, never evicts another tab; legacy counted; concurrent safe ---------
    static long usedBytes(Path files)throws IOException{long n=0;for(File f:allFiles(files.toFile()))if(f.isFile()&&(f.getPath().contains("recovery-tabs")||f.getPath().contains(File.separator+"recovery"+File.separator)))n+=f.length();return n;}
    static void recoveryBudget(Path root,Path fixtures)throws Exception {
        byte[] hwp=Files.readAllBytes(fixtures.resolve("blank.hwp"));long limit=2L*hwp.length+2500;
        Path files=Files.createDirectory(root.resolve("budget"));
        WorkspaceServices s=new WorkspaceServices(files.toFile(),Collections.singletonList(files.toFile()),()->{throw new IllegalStateException();},limit);
        String k1=DraftStore.key("one"),k2=DraftStore.key("two"),k3=DraftStore.key("three");
        s.draftStoreFor(A).write(k1,info("a.hwp","hwp"),hwp);s.draftStoreFor(B).write(k1,info("b.hwp","hwp"),hwp);
        rejected(()->s.draftStoreFor(A).write(k2,info("a2.hwp","hwp"),hwp),"admission refuses a draft that would exceed the global budget");
        rejected(()->s.draftStoreFor(UUID.randomUUID().toString()).write(k3,info("c.hwp","hwp"),hwp),"a third tab is refused, not given room by eviction");
        yes(Arrays.equals(s.draftStoreFor(A).read(k1),hwp)&&Arrays.equals(s.draftStoreFor(B).read(k1),hwp),"refusal evicted nobody");
        s.draftStoreFor(A).write(k1,info("a.hwp","hwp"),hwp);yes(Arrays.equals(s.draftStoreFor(A).read(k1),hwp),"replacing a tab's own draft stays within budget");
        s.draftStoreFor(B).delete(k1);s.draftStoreFor(A).write(k2,info("a2.hwp","hwp"),hwp);yes(s.draftStoreFor(A).list().size()==2,"freed budget is reusable");
        // Legacy recovery counts toward the same global limit.
        Path f2=Files.createDirectory(root.resolve("budget2"));
        WorkspaceServices l=new WorkspaceServices(f2.toFile(),Collections.singletonList(f2.toFile()),()->{throw new IllegalStateException();},limit);
        l.legacyDraftStore().write(k1,info("l1.hwp","hwp"),hwp);l.legacyDraftStore().write(k2,info("l2.hwp","hwp"),hwp);
        rejected(()->l.draftStoreFor(A).write(k3,info("t.hwp","hwp"),hwp),"legacy records occupy the shared budget");
        // Concurrency: many tabs racing for a small budget never exceed it and never lose an accepted draft.
        Path f3=Files.createDirectory(root.resolve("budget3"));long small=3L*hwp.length+4000;
        WorkspaceServices c=new WorkspaceServices(f3.toFile(),Collections.singletonList(f3.toFile()),()->{throw new IllegalStateException();},small);
        List<String> ids=new ArrayList<>();for(int i=0;i<8;i++)ids.add(UUID.randomUUID().toString());
        Set<String> accepted=ConcurrentHashMap.newKeySet();
        parallel(8,t->{try{c.draftStoreFor(ids.get(t)).write(k1,info("t.hwp","hwp"),hwp);accepted.add(ids.get(t));}catch(IOException refused){}});
        yes(!accepted.isEmpty()&&accepted.size()<=3,"at most the budget's worth of drafts accepted: "+accepted.size());
        yes(usedBytes(f3)<=small,"global budget never exceeded under contention");
        for(String id:accepted)yes(Arrays.equals(c.draftStoreFor(id).read(k1),hwp),"accepted draft intact");
    }

    static void servicesProcessCache(Path root)throws Exception {
        Path a=Files.createDirectory(root.resolve("acq-a")),b=Files.createDirectory(root.resolve("acq-b"));
        WorkspaceServices.StateKeyProvider none=()->{throw new IllegalStateException();};
        WorkspaceServices x=WorkspaceServices.acquire(a.toFile(),Collections.singletonList(a.toFile()),none),y=WorkspaceServices.acquire(a.toFile(),Collections.singletonList(a.toFile()),none);
        yes(x==y&&x.files()==y.files()&&x.fonts()==y.fonts(),"recreated Activity reuses the same repositories and locks");
        yes(WorkspaceServices.acquire(b.toFile(),Collections.singletonList(b.toFile()),none)!=x,"different files dir, different services");
        yes(x.draftStoreFor(A)==y.draftStoreFor(A),"draft store shared across Activity instances");
    }

    // ---- SOURCE checks on the frozen MainActivity (text patterns, not runtime proof) ---------------------------
    static String method(String text,String signature){
        int at=text.indexOf(signature);yes(at>=0,"MainActivity has "+signature);
        int open=text.indexOf('{',at),depth=0,i=open;for(;i<text.length();i++){char ch=text.charAt(i);if(ch=='{')depth++;else if(ch=='}'&&--depth==0)break;}
        return text.substring(open,i+1);
    }
    static int count(String text,String needle){int n=0,i=0;while((i=text.indexOf(needle,i))>=0){n++;i+=needle.length();}return n;}
    static void mainActivitySourceChecks(Path source)throws Exception {
        String t=new String(Files.readAllBytes(source),"UTF-8");
        yes(!t.contains("pauseTimers")&&!t.contains("resumeTimers"),"no process-global WebView timer pause");
        // The strip disables its new/open controls from the snapshot's maxTabs: it must be the model's limit, never a literal (it was a hard-coded 8 after the limit became 5).
        yes(t.contains("\"maxTabs\",WorkspaceModel.MAX_TABS")&&!t.contains("\"maxTabs\",8"),"workspace snapshot sends WorkspaceModel.MAX_TABS as maxTabs");
        yes(!t.toLowerCase().contains("<iframe")&&t.contains("frame-src 'none'")&&!t.contains("frame-src 'self'")&&!t.contains("setAllowFileAccess(true)")&&!t.contains("setBlockNetworkLoads(false)"),"CSP frame-src none and WebView lockdown unchanged");
        String editorRegion=t.substring(t.indexOf("private final class EditorSession"));
        // Late/foreign callbacks: replies and events are bound to the owning session and dropped once it is not the live one for its tab.
        yes(method(t,"private void reply(long id").contains("isLive(EditorSession.this)")&&method(t,"private void event(String name").contains("isLive(EditorSession.this)"),"reply/event guarded by owning live session");
        yes(!method(t,"private void reply(long id").contains("activeEditor()")&&!method(t,"private void event(String name").contains("activeEditor()"),"reply/event never target the active session");
        yes(t.contains("private boolean isLive(EditorSession editor){return !activityDestroyed&&!editor.destroyed&&editors.get(editor.tabId)==editor;}"),"isLive compares session instance, not just tab id");
        // Pickers: single launch site, consumed route, owner re-validated, no active-session fallback.
        yes(count(t,"startActivityForResult(")==1&&method(t,"private void launchPicker(").contains("startActivityForResult"),"all pickers go through launchPicker");
        String result=method(t,"protected void onActivityResult(");
        yes(result.contains("consumePicker(request)")&&result.contains("owner.sessionId.equals(route.sessionId)")&&!result.contains("activeEditor()"),"picker result routed by consumed route and session id only");
        yes(method(t,"private void launchPicker(").indexOf("commit()")<method(t,"private void launchPicker(").indexOf("startActivityForResult"),"durable counter committed before the picker launches");
        // Hidden tabs keep their runtime: the only destroy is session disposal, the only navigation is the one initial load.
        yes(count(t,"web.destroy()")==1&&method(t,"private void dispose(boolean confirmedClose)").contains("web.destroy()"),"WebView destroyed only by session disposal");
        yes(count(t,"loadUrl(")==1&&method(t,"private void load()").contains("loadUrl("),"single initial navigation per session (select/reorder/split never reload)");
        yes(!method(t,"private void layoutWorkspace()").contains("destroy")&&!method(t,"private void layoutWorkspace()").contains("loadUrl"),"layout hides by detaching, never destroying or reloading");
        // Pause/resume reach every session, hidden included.
        String pause=method(t,"protected void onPause()");
        yes(pause.contains("for(EditorSession editor:editors.values())")&&pause.contains("event(\"pause\"")&&!pause.contains("editor.visible"),"onPause flushes recovery in every session including hidden");
        // Activity.finish only for: last tab, legacy harness, startup failure/early back, or renderer-fallback with no tabs left.
        String renderer=method(t,"private void rendererGone(");
        for(int at=renderer.indexOf("finish()");at>=0;at=renderer.indexOf("finish()",at+1)){String ctx=renderer.substring(Math.max(0,at-60),at);yes(ctx.contains("legacyTests")||ctx.contains("editors.isEmpty()"),"rendererGone finish() only when legacy or no tabs remain");}
        yes(method(t,"public boolean onRenderProcessGone(").contains("rendererGone(EditorSession.this)")&&!method(t,"public boolean onRenderProcessGone(").contains("finish()"),"renderer loss handled per session");
        String removeConfirmed=method(t,"private void removeConfirmed(");
        yes(removeConfirmed.contains("finishCloseLayout()")&&method(t,"private void finishCloseLayout()").contains("if(workspace.isEmpty()){persistWorkspace();finish();return;}"),"Activity finishes only when the MODEL is empty (lazy tabs keep it alive)");
        // Every finish() call site is one of the audited ones.
        for(int at=t.indexOf("finish()");at>=0;at=t.indexOf("finish()",at+1)){String ctx=t.substring(Math.max(0,at-110),at);
            yes(ctx.contains("setPositiveButton(\"닫기\"")||ctx.contains("legacyTests")||ctx.contains("workspace.isEmpty()")||ctx.contains("migrationPending"),"unaudited finish() at offset "+at);}
        int exitAt=t.indexOf("if(op.equals(\"exit\"))");String exit=t.substring(exitAt,t.indexOf("\n",exitAt));
        yes(exit.contains("requestClose(tabId,EditorSession.this)")&&!exit.contains("removeConfirmed(")&&!exit.contains("dispose("),"exit only asks for a guarded close of its originating session; never removes directly");
        // Cache sweep once per Activity workspace startup, never from session/new-tab code.
        yes(count(t,"sweepPdfCache()")==2&&!editorRegion.contains("sweepPdfCache()")&&!method(t,"private EditorSession newEditor(").contains("sweepPdfCache"),"PDF cache sweep runs once at startup only");
        // Recents: grant + catalog + revoke are one transaction on the shared store.
        for(String sig:new String[]{"private Object recentAdd(","case \"recentRemove\"","case \"recentClear\""}){
            String body=sig.startsWith("case")?t.substring(t.indexOf(sig),t.indexOf("\n",t.indexOf(sig))):method(t,sig);
            int sync=body.indexOf("synchronized("),release=body.indexOf("releaseDroppedRecents(");
            yes(sync>=0&&release>sync,sig+" releases grants inside the shared-store lock");
        }
        // Save: backup and replacement share one FileStore.class critical section.
        String save=t.substring(t.indexOf("case \"finishSave\""),t.indexOf("case \"beginDraft\""));
        int lock=save.indexOf("synchronized(FileStore.class)");yes(lock>=0&&save.indexOf(".backup(")>lock&&save.indexOf("store.write(")>lock,"finishSave backup+write under one FileStore.class lock");
        // Close: only the target session may answer; a stale-dirty model flag is never used to skip confirmation.
        String ops=method(t,"private void workspaceOperation(");
        yes(ops.contains("consumeClose(origin.sessionId")&&ops.contains("target.equals(origin.tabId)"),"close result bound to origin session and tab");
        yes(!method(t,"private void requestClose(").contains(".dirty"),"requestClose never consults cached dirty metadata");
        closeFixChecks(t);
    }


    // ---- close-token TTL (deterministic clock) and 32-bit picker space ----------------------------------------
    static void closeTtlAndPickerBounds()throws Exception {
        yes(WorkspaceRequests.MAX_PICKER_CODE==1_000_000_000&&WorkspaceRequests.CLOSE_TIMEOUT_MS==120_000,"pinned public limits");
        final long[] now={1_000};final long ttl=WorkspaceRequests.CLOSE_TIMEOUT_MS;
        WorkspaceRequests r=new WorkspaceRequests(1000,()->now[0]);
        String t=r.requestClose(A,"s1");
        yes(r.isPendingClose("s1",t)&&!r.isPendingClose("s2",t)&&!r.isPendingClose("s1","nope")&&!r.isPendingClose("s1",null),"token valid only for its own session");
        now[0]+=ttl-1;yes(r.isPendingClose("s1",t)&&r.hasPendingClose("s1"),"valid 1 ms before the timeout");
        yes(r.requestClose(A,"s1").equals(t),"repeat request reuses the live token");
        now[0]+=1;yes(!r.isPendingClose("s1",t)&&!r.hasPendingClose("s1"),"expired exactly at the timeout");
        yes(r.consumeClose("s1",t)==null,"expired token cannot close its target");
        String t2=r.requestClose(A,"s1");yes(!t2.equals(t),"expiry reissues a fresh token");
        yes(r.consumeClose("s1",t)==null,"old token stays dead after reissue");
        // Wrong-origin attempts and repeated requests never refresh or consume a token; life counts from creation.
        now[0]+=60_000;yes(r.consumeClose("s2",t2)==null&&r.isPendingClose("s1",t2),"wrong origin neither consumes nor refreshes");
        yes(r.requestClose(A,"s1").equals(t2),"re-request does not refresh the clock");
        now[0]+=60_000;yes(!r.isPendingClose("s1",t2)&&r.consumeClose("s1",t2)==null,"token expires 120 s after creation despite wrong-origin/re-request traffic");
        // A replacement session of the same tab cannot use, or inherit the consent of, the old session's token.
        String old=r.requestClose(A,"old");String fresh=r.requestClose(A,"new");
        yes(!old.equals(fresh)&&r.consumeClose("new",old)==null&&r.consumeClose("old",fresh)==null,"replacement session has its own capability");
        r.removeSession("old");yes(r.consumeClose("old",old)==null&&r.isPendingClose("new",fresh),"teardown revokes only that session");
        // Expiry is per session: s1's expiry leaves s3's newer token untouched.
        String a1=r.requestClose(A,"s1");now[0]+=ttl-10;String a3=r.requestClose(B,"s3");now[0]+=10;
        yes(!r.isPendingClose("s1",a1)&&r.isPendingClose("s3",a3)&&!r.isPendingClose("new",fresh),"independent expiry per session");
        // A clock that moves backwards fails closed (token treated as expired, never extended).
        WorkspaceRequests back=new WorkspaceRequests(1000,()->now[0]);String bt=back.requestClose(A,"s");now[0]-=5000;
        yes(!back.isPendingClose("s",bt)&&back.consumeClose("s",bt)==null&&!back.requestClose(A,"s").equals(bt),"backwards clock fails closed");
        rejected(()->new WorkspaceRequests(1000,null),"clock required");
        // Pre-existing API is retained and works on the default monotonic clock.
        WorkspaceRequests plain=new WorkspaceRequests();String pt=plain.requestClose(A,"p");
        yes(plain.hasPendingClose("p")&&plain.isPendingClose("p",pt)&&A.equals(plain.consumeClose("p",pt))&&!plain.hasPendingClose("p"),"legacy constructor/API unchanged");

        // Picker space: near-bound, no wrap, no overflow, fail closed.
        final int max=WorkspaceRequests.MAX_PICKER_CODE;
        WorkspaceRequests b=new WorkspaceRequests(max-1,()->now[0]);
        int c1=b.registerPicker(A,"s",1),c2=b.registerPicker(A,"s",2);
        yes(c1==max-1&&c2==max,"last two codes issued");
        rejected(()->b.registerPicker(A,"s",3),"beyond MAX_PICKER_CODE fails closed");
        yes(b.nextPickerCode()==max+1&&b.nextPickerCode()>0,"allocator stops, never wraps negative");
        rejected(()->b.registerPicker(B,"s",4),"still closed on repeat");
        yes(b.consumePicker(c1)!=null&&b.consumePicker(c2)!=null,"issued routes still honoured");
        b.raiseNextPickerCodeTo(Integer.MAX_VALUE);rejected(()->b.registerPicker(A,"s",5),"corrupt/huge durable mark fails closed without overflow");
        yes(b.nextPickerCode()==Integer.MAX_VALUE,"no int overflow at Integer.MAX_VALUE");
        WorkspaceRequests neg=new WorkspaceRequests(5000);neg.raiseNextPickerCodeTo(-5);neg.raiseNextPickerCodeTo(0);yes(neg.nextPickerCode()==5000,"non-positive floors ignored");
        WorkspaceRequests low=new WorkspaceRequests(-100);yes(low.registerPicker(A,"s",1)==1000,"negative constructor floor clamps to 1000");
        // Concurrent allocation across the final stretch: exactly the remaining codes succeed, all distinct.
        WorkspaceRequests edge=new WorkspaceRequests(max-1000);Set<Integer> got=ConcurrentHashMap.newKeySet();AtomicInteger refused=new AtomicInteger();
        parallel(8,t3->{for(int i=0;i<200;i++){try{yes(got.add(edge.registerPicker(A,"s"+t3,i)),"unique near bound");}catch(IllegalStateException e){refused.incrementAndGet();}}});
        yes(got.size()==1001&&refused.get()==1600-1001&&Collections.max(got)==max,"exactly the remaining 1001 codes issued, rest refused");
    }

    // ---- durable legacy-recovery owner marker -----------------------------------------------------------------
    static WorkspaceServices servicesWith(Path files,WorkspaceServices.LegacyOwnerMover mover)throws IOException{
        return new WorkspaceServices(files.toFile(),Collections.singletonList(files.toFile()),()->{throw new IllegalStateException();},WorkspaceServices.MAX_RECOVERY_BYTES,mover);
    }
    static final WorkspaceServices.LegacyOwnerMover ATOMIC_MOVER=(from,to)->Files.move(from.toPath(),to.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
    static void legacyOwnerMarker(Path root,Path fixtures)throws Exception {
        byte[] hwp=Files.readAllBytes(fixtures.resolve("blank.hwp")),other=Files.readAllBytes(fixtures.resolve("table.hwp"));
        String k1=DraftStore.key("one"),k2=DraftStore.key("two");
        // Marker is a 36-byte canonical UUID, committed BEFORE the first record is copied or deleted.
        Path f1=Files.createDirectory(root.resolve("own1"));WorkspaceServices s=servicesWith(f1,(from,to)->{
            yes(Files.exists(f1.resolve("recovery/"+k1+".meta"))&&Files.exists(f1.resolve("recovery/"+k2+".draft")),"legacy intact when the marker is committed");
            yes(!new File(f1.toFile(),"recovery-tabs/"+A).exists()||new File(f1.toFile(),"recovery-tabs/"+A).list().length==0,"nothing copied before the marker commit");
            ATOMIC_MOVER.move(from,to);});
        s.legacyDraftStore().write(k1,info("one.hwp","hwp"),hwp);s.legacyDraftStore().write(k2,info("two.hwp","hwp"),other);
        s.migrateLegacyDraftsTo(A);
        byte[] marker=Files.readAllBytes(f1.resolve(WorkspaceServices.LEGACY_OWNER_FILE));
        yes(marker.length==36&&new String(marker,"US-ASCII").equals(A),"owner marker is the 36-byte tab UUID");
        yes(Arrays.equals(s.draftStoreFor(A).read(k1),hwp)&&!Files.exists(f1.resolve("recovery/"+k1+".meta")),"records migrated to the marker owner");
        // After a restart and a reorder (another tab now first), leftovers still go to the committed owner, never to B.
        WorkspaceServices again=servicesWith(f1,ATOMIC_MOVER);String k3=DraftStore.key("three");
        again.legacyDraftStore().write(k3,info("three.hwp","hwp"),hwp);again.migrateLegacyDraftsTo(B);
        yes(Arrays.equals(again.draftStoreFor(A).read(k3),hwp)&&again.draftStoreFor(B).list().isEmpty(),"owner survives restart/reorder");
        yes(new String(Files.readAllBytes(f1.resolve(WorkspaceServices.LEGACY_OWNER_FILE)),"US-ASCII").equals(A),"marker never rewritten");
        // No legacy directory: nothing to claim, no marker invented.
        Path f2=Files.createDirectory(root.resolve("own2"));WorkspaceServices none=servicesWith(f2,ATOMIC_MOVER);none.migrateLegacyDraftsTo(A);
        yes(!Files.exists(f2.resolve(WorkspaceServices.LEGACY_OWNER_FILE)),"no marker without legacy records");
        // Commit failure (injected): fail closed, legacy untouched, no marker, retry succeeds.
        Path f3=Files.createDirectory(root.resolve("own3"));WorkspaceServices bad=servicesWith(f3,(from,to)->{throw new IOException("injected");});
        bad.legacyDraftStore().write(k1,info("one.hwp","hwp"),hwp);
        rejected(()->bad.migrateLegacyDraftsTo(A),"marker commit failure surfaces");
        yes(!Files.exists(f3.resolve(WorkspaceServices.LEGACY_OWNER_FILE))&&Arrays.equals(bad.legacyDraftStore().read(k1),hwp),"failed commit leaves legacy readable and no marker");
        yes(!new File(f3.toFile(),"recovery-tabs/"+A).exists()||new File(f3.toFile(),"recovery-tabs/"+A).list().length==0,"failed commit copied nothing");
        yes(f3.toFile().list((d,n)->n.startsWith(".legacy-owner-")).length==0,"temporary marker cleaned up");
        WorkspaceServices retry=servicesWith(f3,ATOMIC_MOVER);retry.migrateLegacyDraftsTo(A);yes(Arrays.equals(retry.draftStoreFor(A).read(k1),hwp),"retry after failed commit migrates");
        // Damaged markers: migration fails closed, legacy and marker bytes preserved, no other owner chosen.
        byte[][] damaged={"short".getBytes("US-ASCII"),(A+"x").getBytes("US-ASCII"),"zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz".getBytes("US-ASCII"),"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA".getBytes("US-ASCII"),new byte[0]};
        int n=0;for(byte[] bad2:damaged){
            Path f=Files.createDirectory(root.resolve("own-bad"+(n++)));WorkspaceServices w=servicesWith(f,ATOMIC_MOVER);
            w.legacyDraftStore().write(k1,info("one.hwp","hwp"),hwp);Files.write(f.resolve(WorkspaceServices.LEGACY_OWNER_FILE),bad2);
            rejected(()->w.migrateLegacyDraftsTo(B),"damaged marker fails closed");
            yes(Arrays.equals(Files.readAllBytes(f.resolve(WorkspaceServices.LEGACY_OWNER_FILE)),bad2)&&Arrays.equals(w.legacyDraftStore().read(k1),hwp),"damaged marker and legacy bytes preserved");
            yes(!new File(f.toFile(),"recovery-tabs/"+B).exists()||new File(f.toFile(),"recovery-tabs/"+B).list().length==0,"no record copied under a guessed owner");
        }
        try{ // a symlinked marker must never be followed
            Path f=Files.createDirectory(root.resolve("own-link"));WorkspaceServices w=servicesWith(f,ATOMIC_MOVER);w.legacyDraftStore().write(k1,info("one.hwp","hwp"),hwp);
            Path target=Files.write(root.resolve("elsewhere"),A.getBytes("US-ASCII"));Files.createSymbolicLink(f.resolve(WorkspaceServices.LEGACY_OWNER_FILE),target);
            rejected(()->w.migrateLegacyDraftsTo(B),"symlinked marker fails closed");yes(Arrays.equals(w.legacyDraftStore().read(k1),hwp),"legacy preserved behind a symlinked marker");
        }catch(UnsupportedOperationException noSymlinks){}
        // Discoverability: an owner with a pending legacy pair is reported even though its own directory is empty/absent.
        Path f4=Files.createDirectory(root.resolve("own4"));WorkspaceServices d=servicesWith(f4,ATOMIC_MOVER);
        d.legacyDraftStore().write(k1,info("one.hwp","hwp"),hwp);Files.write(f4.resolve(WorkspaceServices.LEGACY_OWNER_FILE),A.getBytes("US-ASCII"));
        yes(d.recoverableTabIds().contains(A)&&!new File(f4.toFile(),"recovery-tabs").exists(),"owner with pending legacy pair discoverable without any tab directory");
        Files.delete(f4.resolve("recovery/"+k1+".meta"));yes(!d.recoverableTabIds().contains(A),"no pair, no phantom owner");
        // P2-H (fixed after the first pass of this review): a damaged marker must not hide unrelated orphan owners.
        Path f5=Files.createDirectory(root.resolve("own5"));WorkspaceServices e=servicesWith(f5,ATOMIC_MOVER);e.draftStoreFor(B).write(k1,info("b.hwp","hwp"),hwp);
        Files.write(f5.resolve(WorkspaceServices.LEGACY_OWNER_FILE),"short".getBytes("US-ASCII"));
        yes(e.recoverableTabIds().equals(Collections.singletonList(B)),"damaged legacy marker must not hide unrelated orphan recovery owners");
        rejected(()->e.migrateLegacyDraftsTo(A),"...while migration itself still fails closed");
    }


    // ---- SOURCE checks for the close/lazy/recovery-ownership fixes (text patterns, not runtime proof) ----------
    static void closeFixChecks(String t){
        // P1-A: guarded close. Only a live-hook/Core answer or an explicit default-Cancel native confirmation closes.
        yes(count(t,"removeConfirmed(origin,true)")==1&&count(t,"removeConfirmed(target,false)")==1&&count(t,"private void removeConfirmed(EditorSession editor,boolean discardOwnedRecovery)")==1&&!t.contains("removeConfirmed(EditorSession.this"),"session-level removal has exactly two callers: origin-bound hook/Core result (discard) and explicit native confirmation (preserve)");
        String ops=method(t,"private void workspaceOperation(");
        yes(ops.contains("removeConfirmed(origin,true)")&&ops.indexOf("consumeClose(origin.sessionId,token)")<ops.indexOf("removeConfirmed(origin,true)")&&ops.contains("target.equals(origin.tabId)"),"hook/Core result closes only after consuming the origin-bound token");
        yes(ops.contains("optBoolean(\"unavailable\",false)){offerNativeClose(origin,token);break;}"),"'unavailable' only offers the prompt, never closes");
        String req=method(t,"private void requestClose(");
        yes(!req.contains(".dirty")&&!req.contains(".ready")&&!req.contains("hasOpenedContent"),"requestClose never uses cached dirty/ready metadata");
        yes(!req.contains("new EditorSession")&&!req.contains("retainEditor")&&!req.contains("load()"),"closing never instantiates or loads a hidden tab");
        yes(req.contains("requestUnloadedClose(canonical)")&&req.contains("CLOSE_BUSY")&&req.contains("hasPendingClose(target.sessionId)"),"unloaded target and busy cases handled visibly");
        yes(req.contains("if(document.querySelector('dialog[open], .modal-overlay'))return 'dialog'")&&req.contains("core.confirmClose()")&&req.contains("AndroidWorkspaceCloseRequest(token)"),"script: dialog preflight, hook, then actual Core confirmClose");
        String show=method(t,"private void showNativeClose(");
        yes(show.contains("setNegativeButton(\"취소\"")&&show.contains("getButton(AlertDialog.BUTTON_NEGATIVE).requestFocus()"),"native fallback is default-Cancel");
        yes(show.contains("removeConfirmed(target,false)")&&!show.contains("removeConfirmed(target,true)")&&show.contains("if(isLive(target))"),"native fallback closes the same live instance and preserves all recovery");
        yes(show.indexOf("requests.consumeClose(target.sessionId,token)")<show.indexOf("dialog.show()"),"JS token revoked before the native prompt is shown");
        yes(show.contains("!activityResumed")&&show.contains("nativeDialogs.isEmpty()"),"native prompt waits for resumed Activity and no other dialog");
        String offer=method(t,"private void offerNativeClose(");
        yes(offer.contains("dialog[open], .modal-overlay")&&offer.contains("postDelayed(unresponsive,2500)")&&offer.contains("isPendingClose(target.sessionId,token)"),"fallback probes open dialogs, bounds a hung probe, honours TTL");
        yes(t.contains("CLOSE_FALLBACK_MS=15_000"),"15 s fallback delay");
        String un=method(t,"private void requestUnloadedClose(");
        yes(un.contains("setNegativeButton(\"취소\"")&&un.contains("requestFocus()")&&un.contains("editors.get(tabId)==null")&&un.contains("instance.equals(unloadedOwners.get(tabId))")&&un.contains("isPendingClose(instance,token)"),"unloaded close: default-Cancel, owner/instance/TTL re-validated");
        yes(!un.contains("drafts")&&!un.contains("dispose(")&&!un.contains("new EditorSession")&&!un.contains("retainEditor")&&!un.contains(".delete("),"unloaded close touches no recovery and loads nothing");
        String back=method(t,"public void onBackPressed()");
        yes(back.contains("requestClose(active.tabId,active)")&&back.contains("postDelayed(close,2500)")&&!back.contains("removeConfirmed(")&&!back.contains("dispose("),"Back goes through guarded close; hung evaluation retried, never removes directly");
        // P2-C: lazy runtimes.
        String startup=method(t,"private void completeStartup(");
        yes(startup.contains("for(String id:workspace.visibleIds())retainEditor(new EditorSession(id,\"blank\"))")&&!startup.contains("workspace.tabIds()"),"cold start instantiates only visible tabs");
        String renderer=method(t,"private void rendererGone(");
        yes(!renderer.contains("new EditorSession")&&!renderer.contains("retainEditor")&&renderer.contains("workspace.isVisible(editor.tabId)"),"hidden renderer loss defers replacement; only visible tabs are refilled by layout");
        String layout=method(t,"private void layoutWorkspace()");
        yes(layout.contains("for(String id:wanted)if(!editors.containsKey(id))try{retainEditor(new EditorSession(id,\"blank\"))"),"layout creates runtimes only for visible ids");
        yes(count(t,"new EditorSession(")==6,"runtime creation sites are exactly startup, layout, select, new tab, split, legacy harness (none in close/rendererGone): "+count(t,"new EditorSession("));
        // P2-F: marker commit, migration and discovery run on the background executor, never on the UI thread.
        String create=method(t,"public void onCreate(Bundle saved)");int exec=create.indexOf("workspaceIo.execute(()->{");
        yes(exec>0&&create.indexOf("migrateLegacyDraftsTo(")>exec&&create.indexOf("recoverableTabIds()")>exec&&count(t,"migrateLegacyDraftsTo(")==1&&count(t,"recoverableTabIds()")==1&&count(t,"legacyDraftStore()")==1,"owner marker/migration/discovery only inside the background task");
        yes(count(t,"drafts.delete(")==2,"recovery deletion sites: explicit discardDraft and owned-key cleanup only");
        // P2-D/E.
        yes(!t.contains("event(\"foldersChanged\"")&&count(t,"broadcastEvent(\"foldersChanged\"")==3,"folder connect/disconnect broadcast to every session");
        // P2-G: ownership of recovery deletion.
        yes(count(t,"ownedDraftKeys.add(")==3,"recovery ownership is claimed at exactly beginSave(selected draft)/finishDraft/discardDraft");
        String readDraft=t.substring(t.indexOf("case \"readDraft\""),t.indexOf("case \"discardDraft\""));
        yes(!readDraft.contains("ownedDraftKeys")&&!readDraft.contains("delete("),"previewing a draft via readDraft never claims or deletes it");
        yes(!t.substring(t.indexOf("case \"listDrafts\""),t.indexOf("case \"readDraft\"")).contains("ownedDraftKeys"),"listDrafts never claims");
        String dispose=method(t,"private void dispose(boolean confirmedClose)");
        yes(dispose.contains("if(confirmedClose&&drafts!=null)for(String key:ownedDraftKeys)")&&!dispose.contains("drafts.list")&&!dispose.contains("listFiles")&&!dispose.contains("deleteRecursively"),"confirmed close deletes only owned keys, never a namespace");
        yes(method(t,"private void dispose()").contains("dispose(false)")&&method(t,"protected void onDestroy()").contains("editor.dispose()")&&method(t,"private void rendererGone(").contains("editor.dispose()")&&!method(t,"private void rendererGone(").contains("dispose(true)")&&!method(t,"protected void onDestroy()").contains("dispose(true)"),"Activity destroy and renderer loss preserve recovery");
        yes(count(t,"dispose(true)")==0&&count(t,"dispose(discardOwnedRecovery)")==1,"only removeConfirmed's parameter can request recovery cleanup");
    }

    // ---- static lint: no foreign-provider read inside the FileStore transaction lock -------------------------
    static void noProviderReadUnderStoreLock(Path source)throws Exception {
        String text=new String(Files.readAllBytes(source),"UTF-8");int from=0;int blocks=0;
        String[] forbidden={"ProviderRead","getContentResolver","openInputStream","ContentResolver","TimedCall","termux.read","readProviderBytes","registerSelection"};
        while(true){
            int at=text.indexOf("synchronized (FileStore.class)",from);if(at<0)at=text.indexOf("synchronized(FileStore.class)",from);if(at<0)break;
            int open=text.indexOf('{',at),depth=0,i=open;for(;i<text.length();i++){char c=text.charAt(i);if(c=='{')depth++;else if(c=='}'&&--depth==0)break;}
            String body=text.substring(open,i);for(String word:forbidden)yes(!body.contains(word),source.getFileName()+": '"+word+"' inside FileStore.class lock");
            blocks++;from=i;
        }
        yes(blocks>0||!source.getFileName().toString().matches("FileStore.java|ExportStore.java"),source.getFileName()+": expected FileStore.class transaction blocks");
    }

    static void parallel(int n,IntRun body)throws Exception {
        ExecutorService pool=Executors.newFixedThreadPool(n);List<Future<?>> futures=new ArrayList<>();
        try{for(int i=0;i<n;i++){final int t=i;futures.add(pool.submit(()->body.run(t)));}for(Future<?> f:futures)f.get(60,TimeUnit.SECONDS);}finally{pool.shutdownNow();}
    }
    interface IntRun {void run(int t);}
    static void deleteTree(Path root)throws IOException{if(!Files.exists(root))return;try(java.util.stream.Stream<Path> w=Files.walk(root)){w.sorted(Comparator.reverseOrder()).forEach(p->p.toFile().delete());}}
}
