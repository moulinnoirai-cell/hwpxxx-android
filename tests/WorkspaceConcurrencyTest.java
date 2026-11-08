package kr.offline.hwp;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Real competing writers, independent repositories, and validated originals/backups. */
public final class WorkspaceConcurrencyTest {
    private static int checks;
    private interface Run {void run()throws Exception;}
    private static void yes(boolean value,String label){if(!value)throw new AssertionError(label);checks++;}
    private static void compete(Run first,Run second)throws Exception {
        CountDownLatch ready=new CountDownLatch(2),start=new CountDownLatch(1);
        AtomicInteger won=new AtomicInteger(),conflicted=new AtomicInteger();
        List<Throwable> unexpected=Collections.synchronizedList(new ArrayList<>());
        Runnable[] work=new Runnable[2];Run[] ops={first,second};
        for(int i=0;i<2;i++){final int index=i;work[i]=()->{ready.countDown();try{start.await();ops[index].run();won.incrementAndGet();}catch(IOException conflict){conflicted.incrementAndGet();}catch(Throwable error){unexpected.add(error);}};}
        Thread a=new Thread(work[0]),b=new Thread(work[1]);a.start();b.start();
        if(!ready.await(5,TimeUnit.SECONDS))throw new AssertionError("writers not ready");start.countDown();
        a.join(10000);b.join(10000);yes(!a.isAlive()&&!b.isAlive(),"writers completed");
        yes(unexpected.isEmpty(),"no unexpected errors: "+unexpected);
        yes(won.get()==1&&conflicted.get()==1,"exactly one writer wins, one conflicts: "+won+"/"+conflicted);
    }
    public static void main(String[] args)throws Exception {
        Path root=Files.createTempDirectory("workspace-concurrency-");
        try{
            FileStore a=new FileStore(Arrays.asList(root.toFile())),b=new FileStore(Arrays.asList(root.toFile()));
            byte[] original=Files.readAllBytes(Paths.get(args[0])),one=original.clone(),two=original.clone();
            // HWP signature and complete document length stay valid; the trailing edit makes distinct baselines.
            one[one.length-1]^=1;two[two.length-1]^=2;
            for(int iteration=0;iteration<12;iteration++){
                String path=root.resolve("replace"+iteration+".hwp").toString();a.write(path,original,null,false);String baseline=FileStore.sha(original);
                compete(()->a.write(path,one,baseline,true),()->b.write(path,two,baseline,true));
                byte[] result=a.read(path);yes(Arrays.equals(result,one)||Arrays.equals(result,two),"one intact final generation");
                String create=root.resolve("create"+iteration+".hwp").toString();
                compete(()->a.write(create,one,null,false),()->b.write(create,two,null,false));
                result=a.read(create);yes(Arrays.equals(result,one)||Arrays.equals(result,two),"create collision preserves winner");
            }
            String backed=root.resolve("backed.hwp").toString();a.write(backed,original,null,false);String baseline=FileStore.sha(original);
            compete(()->{synchronized(FileStore.class){a.backup(backed,baseline,"same");a.write(backed,one,baseline,true);}},()->{synchronized(FileStore.class){b.backup(backed,baseline,"same");b.write(backed,two,baseline,true);}});
            File[] backups=root.toFile().listFiles(f->f.getName().startsWith("backed_"));
            yes(backups!=null&&backups.length==1,"losing transaction cannot publish an extra backup");
            yes(Arrays.equals(original,Files.readAllBytes(backups[0].toPath())),"backup is complete original");FileStore.validate(a.read(backed),"hwp");checks++;
            exportRace(root,a,b);
            // FileStore and ExportStore really use the same process transaction monitor.
            CountDownLatch attempted=new CountDownLatch(1);AtomicReference<Throwable> error=new AtomicReference<>();
            Thread deleting=new Thread(()->{attempted.countDown();try{b.delete(backed);}catch(Throwable e){error.set(e);}});
            synchronized(FileStore.class){deleting.start();attempted.await();awaitBlocked(deleting);yes(Files.isRegularFile(Paths.get(backed)),"delete waits for another session's transaction");}
            deleting.join(5000);yes(error.get()==null&&!Files.exists(Paths.get(backed)),"delete commits after transaction releases");
            System.out.println("WorkspaceConcurrency: "+checks+" checks passed");
        }finally{try(java.util.stream.Stream<Path> paths=Files.walk(root)){paths.sorted(Comparator.reverseOrder()).forEach(p->{try{Files.deleteIfExists(p);}catch(IOException ignored){}});}}
    }
    private static void awaitBlocked(Thread worker)throws Exception {
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5);
        while(worker.getState()!=Thread.State.BLOCKED&&worker.isAlive()&&System.nanoTime()<deadline)Thread.yield();
        yes(worker.getState()==Thread.State.BLOCKED,"competing transaction blocks on common monitor");
    }
    private static void exportRace(Path root,FileStore a,FileStore b)throws Exception {
        byte[] original="<HWPML><BODY>original</BODY></HWPML>".getBytes(StandardCharsets.UTF_8),one="<HWPML><BODY>one</BODY></HWPML>".getBytes(StandardCharsets.UTF_8),two="<HWPML><BODY>two</BODY></HWPML>".getBytes(StandardCharsets.UTF_8);
        String path=root.resolve("export.hml").toString();new ExportStore(a).write(path,original,null,false);String baseline=FileStore.sha(original);
        CountDownLatch inMove=new CountDownLatch(1),release=new CountDownLatch(1),started=new CountDownLatch(1);
        AtomicInteger won=new AtomicInteger(),conflicts=new AtomicInteger();AtomicReference<Throwable> failure=new AtomicReference<>();
        ExportStore first=new ExportStore(a,(source,destination)->{inMove.countDown();try{if(!release.await(5,TimeUnit.SECONDS))throw new IOException("test release timeout");}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IOException(e);}Files.move(source,destination,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);});
        ExportStore second=new ExportStore(b);
        Thread x=new Thread(()->{try{first.write(path,one,baseline,true);won.incrementAndGet();}catch(Throwable e){failure.set(e);}});
        Thread y=new Thread(()->{started.countDown();try{second.write(path,two,baseline,true);won.incrementAndGet();}catch(IOException e){conflicts.incrementAndGet();}catch(Throwable e){failure.set(e);}});
        x.start();if(!inMove.await(5,TimeUnit.SECONDS))throw new AssertionError("first export did not reach commit");
        try{y.start();started.await();awaitBlocked(y);}finally{release.countDown();}
        x.join(10000);y.join(10000);yes(failure.get()==null&&won.get()==1&&conflicts.get()==1,"second HML writer rechecks baseline after first commit");
        yes(Arrays.equals(one,a.read(path)),"HML final bytes belong to the first completed transaction");
        String create=root.resolve("new.txt").toString();compete(()->new ExportStore(a).write(create,"one".getBytes(StandardCharsets.UTF_8),null,false),()->new ExportStore(b).write(create,"two".getBytes(StandardCharsets.UTF_8),null,false));
        String created=new String(a.read(create),StandardCharsets.UTF_8);yes(created.equals("one")||created.equals("two"),"general export create preserves winner");
    }
}
