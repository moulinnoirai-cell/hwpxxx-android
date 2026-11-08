package kr.offline.hwp;

import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Real bounded-call/session/registry code with deterministic foreign-provider hangs, no Android mocks. */
public class NativeAvailabilityTest {
    static int checks;
    interface Action {void run()throws Exception;}
    static void yes(boolean value,String message){if(!value)throw new AssertionError(message);checks++;}
    static void rejects(Action action,String message)throws Exception {try{action.run();throw new AssertionError(message);}catch(IOException expected){checks++;}}
    static void awaitIgnoringInterrupt(CountDownLatch latch){while(latch.getCount()>0)try{latch.await();}catch(InterruptedException ignored){}}
    static void eventually(Callable<Boolean> condition,String message)throws Exception {long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(4);while(!condition.call()&&System.nanoTime()<end)Thread.sleep(10);yes(condition.call(),message);}
    static class Tracked implements AutoCloseable {final AtomicInteger closed=new AtomicInteger();public void close(){closed.incrementAndGet();}}
    static NativeSessions.Session session(String token,String kind,String source){NativeSessions.Session value=new NativeSessions.Session();value.token=token;value.kind=kind;value.sourceId=source;return value;}
    public static void main(String[] args)throws Exception {
        yes(ProviderRead.TIMEOUT_MS<=30000,"production provider deadline stays below bridge timeout");
        AtomicInteger committed=new AtomicInteger();CountDownLatch release=new CountDownLatch(1),finished=new CountDownLatch(1);Tracked cursor=new Tracked();
        ExecutorService serial=Executors.newSingleThreadExecutor();
        try{
            Future<?> hung=serial.submit(()->{try{byte[] value=ProviderRead.read(resources->{resources.own(cursor);awaitIgnoringInterrupt(release);finished.countDown();return new byte[]{1};},100);committed.addAndGet(value.length);throw new AssertionError("late result committed");}catch(IOException expected){}catch(Exception other){throw new RuntimeException(other);}});
            hung.get(2,TimeUnit.SECONDS);
            yes(serial.submit(()->"save still runs").get(1,TimeUnit.SECONDS).equals("save still runs"),"hung foreign provider releases single I/O caller for saves");
            eventually(()->cursor.closed.get()==1,"timeout closes already acquired cursor");
            release.countDown();yes(finished.await(2,TimeUnit.SECONDS),"provider eventually returned late bytes");Thread.sleep(50);
            yes(committed.get()==0,"late bytes cannot register source or import font");yes(cursor.closed.get()==1,"timeout/worker-finally close cursor once");
        }finally{release.countDown();serial.shutdownNow();}
        // Stream acquisition itself may finish after timeout. The late descriptor is still closed.
        CountDownLatch openGate=new CountDownLatch(1),lateAcquired=new CountDownLatch(1);Tracked lateStream=new Tracked();
        rejects(()->ProviderRead.read(resources->{awaitIgnoringInterrupt(openGate);try{resources.own(lateStream);return "late";}finally{lateAcquired.countDown();}},80),"late open must timeout");
        openGate.countDown();yes(lateAcquired.await(2,TimeUnit.SECONDS),"late stream acquisition completed");eventually(()->lateStream.closed.get()==1,"late stream is closed exactly once");
        // A read blocked inside the provider is released by owned stream cleanup, not by interrupt support.
        CountDownLatch readStarted=new CountDownLatch(1);AtomicInteger streamCloses=new AtomicInteger();
        InputStream blocking=new InputStream(){boolean closed;public synchronized int read()throws IOException{readStarted.countDown();while(!closed)try{wait();}catch(InterruptedException ignored){}throw new IOException("closed");}public synchronized void close(){closed=true;streamCloses.incrementAndGet();notifyAll();}};
        rejects(()->ProviderRead.read(resources->{InputStream stream=resources.own(blocking);return stream.read();},100),"blocked stream timeout");
        yes(readStarted.getCount()==0,"blocked read really entered");eventually(()->streamCloses.get()==1,"timeout closes blocked stream once");
        Tracked success=new Tracked();byte[] detached=ProviderRead.read(resources->{resources.own(success);return new byte[]{5,6};},1000);
        committed.addAndGet(detached.length);yes(committed.get()==2&&success.closed.get()==1,"successful detached result alone reaches caller commit");
        Tracked failing=new Tracked();rejects(()->ProviderRead.read(resources->{resources.own(failing);throw new IOException("provider gone");},1000),"foreign read exception propagated");yes(failing.closed.get()==1,"provider failure closes cursor");
        // Closing a malicious provider resource may hang; caller deadline must still hold.
        CountDownLatch closeGate=new CountDownLatch(1),closeEntered=new CountDownLatch(1);
        long started=System.nanoTime();rejects(()->ProviderRead.read(resources->{resources.own(()->{closeEntered.countDown();awaitIgnoringInterrupt(closeGate);});return "done";},100),"blocked resource close times out");
        yes(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-started)<1500&&closeEntered.getCount()==0,"blocking close never runs on caller");closeGate.countDown();
        // The exact upload ownership object MainActivity uses.
        NativeSessions<NativeSessions.Session> slots=new NativeSessions<>();List<String> discarded=new ArrayList<>();
        slots.upload=session("document-1","document","new:source");slots.draft=session("draft-1","draft","draft:id");slots.state=session("history-1","history","history:id");
        slots.abort("stale",value->discarded.add(value.token));slots.abort(null,value->discarded.add(value.token));slots.abort("",value->discarded.add(value.token));
        yes(slots.upload!=null&&slots.draft!=null&&slots.state!=null&&discarded.isEmpty(),"unknown/null/stale aborts preserve every active slot");
        slots.abort("history-1",value->discarded.add(value.token));yes(slots.state==null&&slots.upload!=null&&slots.draft!=null,"history abort clears only failed history slot");
        slots.state=session("history-2","history","history:id");slots.abort("history-1",value->discarded.add(value.token));yes(slots.state.token.equals("history-2"),"late history abort cannot cancel its replacement");
        slots.abort("draft-1",value->discarded.add(value.token));yes(slots.draft==null&&slots.upload!=null&&slots.state!=null,"draft token-scoped abort isolates document/history");
        slots.draft=session("draft-2","draft","draft:id");
        yes(slots.abortPdf(null)&&slots.upload.kind.equals("document")&&slots.draft!=null&&slots.state!=null,"legacy tokenless PDF abort preserves unrelated document/history/draft");
        slots.upload=session("pdf-1","pdf",null);yes(!slots.abortPdf("stale")&&slots.upload!=null,"stale PDF token does not cancel newer PDF page");
        yes(slots.abortPdf("pdf-1")&&slots.upload==null&&slots.draft!=null&&slots.state!=null,"PDF abort clears PDF page alone");
        slots.upload=session("pdf-2","pdf",null);yes(slots.abortPdf(null)&&slots.upload==null&&slots.state!=null,"legacy PDF abort still clears active PDF page");
        slots.upload=session("document-2","document","new:source");slots.abort("document-1",value->discarded.add(value.token));yes(slots.upload.token.equals("document-2"),"old document abort cannot cancel next document");
        slots.clear(value->discarded.add(value.token));yes(slots.upload==null&&slots.state==null&&slots.draft==null,"OOM cleanup clears history too");
        // Metadata handles are stable and bounded, and never evict any old active source.
        NativeHandleRegistry<String> sources=new NativeHandleRegistry<>("saf:");String original=sources.register("content://provider/one","first");
        boolean same=true;for(int i=0;i<100;i++)same&=original.equals(sources.register("content://provider/one","updated"));yes(same&&sources.size()==1,"100 opens of the same URI reuse one source identity");
        for(int i=1;i<80;i++)sources.register("content://provider/"+i,"value"+i);
        yes(sources.size()==80&&sources.containsKey(original),">64 distinct sources work while oldest active handle remains");
        for(int i=80;i<NativeHandleRegistry.MAX_HANDLES;i++)sources.register("content://provider/"+i,"value"+i);
        yes(sources.size()==1024&&sources.get(original).equals("updated"),"metadata registry reaches bounded 1024 without evicting an active source");
        rejects(()->sources.register("content://provider/overflow","overflow"),"distinct source over cap refused");
        yes(original.equals(sources.register("content://provider/one","still active"))&&sources.size()==1024,"existing URI remains reusable even at capacity");
        yes(sources.get(original).equals("still active"),"capacity refusal does not discard active source");
        NativeHandleRegistry<String> fresh=new NativeHandleRegistry<>("new:");String temporary=fresh.create("hwp");
        slots.upload=session("new-save","document",temporary);slots.state=session("state-active","history","other");
        slots.abort("new-save",value->{if(!slots.referencesSource(value.sourceId))fresh.remove(value.sourceId);});
        yes(fresh.size()==0&&slots.state!=null,"terminal save abort releases temporary new id without touching history");
        for(int i=0;i<NativeHandleRegistry.MAX_HANDLES;i++)fresh.create("hwpx");rejects(()->fresh.create("hwp"),"new identities also bounded at 1024");
        System.out.println("NativeAvailability: "+checks+" checks passed");
    }
}
